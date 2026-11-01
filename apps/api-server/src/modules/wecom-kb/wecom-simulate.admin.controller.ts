import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { WecomChatService } from './wecom-chat.service';
import { WecomSvcTokenService } from './wecom-svc-token.service';
import type { Binding } from './op-proxy.service';

class SimulateDto {
  @IsString()
  @MaxLength(500)
  text!: string;

  /** true = 先清掉这个管理员的试跑会话（等价于在企微里发「取消」） */
  @IsOptional()
  @IsBoolean()
  reset?: boolean;
}

/**
 * 机器人「试跑台」· 让机器人在企微回调还没通的情况下也能被验证
 *
 * ## 为什么必须有它
 *
 * 企微回调地址要求**域名**（企业微信不收 IP），备案未完成前机器人收不到任何消息 ——
 * 也就是说「它能操作 131 个后台功能」这件事，**在当前环境里无法被任何人验证一次**。
 * 「门禁全绿 ≠ 功能可用」在本项目已经踩过：写完了、测过了，但没人真的跑通过一遍。
 * 这个端点走**服务端内部同一套** `WecomChatService.reply()`，不复制任何判据，
 * 所以试跑跑通 ≈ 企微通了就能用。
 *
 * ## 安全边界（这里执行是**真的**写库，不是沙箱）
 *
 *   · 只有 `super_admin / admin` 能进（`AdminGuard` + `@Roles`），且**用负责人身份**执行；
 *   · 审计不丢人：`X-KB-Operator` 记的是**当前登录管理员姓名**（不是「机器人」），
 *     事后在 `ab_operation_log.kb_operator` 里能查到是谁试的；
 *   · 会话按管理员隔离（`sim:<id>`），与真实企微 userid 不共用状态，
 *     避免「试跑时填了一半的参数」串到真人的对话里；
 *   · 高危操作仍然是「草稿 → 回 1 才执行」两轮，试跑也一样 —— 不会因为点了试跑就立刻动钱。
 *
 * ## 为什么不做成「沙箱 / 只读模式」
 *
 * 只读模式下有一半功能（改单、排套餐、发券）根本跑不到，而它们恰恰是最需要验证的部分。
 * 与其做一个「看起来能试但试不出问题」的假沙箱，不如明确标注「这里会真写库」，
 * 让试跑的人自己决定用哪句话。
 */
@Controller('admin/wecom/kb')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin')
export class WecomSimulateController {
  constructor(
    private readonly chat: WecomChatService,
    private readonly svcToken: WecomSvcTokenService,
  ) {}

  @Post('simulate')
  async simulate(
    @Body() dto: SimulateDto,
    @CurrentAdmin() admin: JwtPayload,
  ): Promise<{ reply: string; execAs: string }> {
    const who = admin?.username || 'admin#' + String(admin?.sub ?? '?');
    // 用负责人执行账号：试跑要能覆盖 131 项，用 operator 账号会有 62 项直接回「做不了」，
    // 那样的试跑结论是假的（会让人以为功能没做）。
    const token = await this.svcToken.get('owner');
    if (!token) {
      return {
        reply:
          '负责人执行账号还没配好（服务器 .env.prod 缺 WECOM_OWNER_USERNAME / WECOM_OWNER_PASSWORD），暂时没法试跑。',
        execAs: 'none',
      };
    }

    const b: Binding = {
      // ⚠️ 这里必须是**当前管理员姓名**，不是「试跑台」：审计要能回答「谁干的」
      operatorName: who,
      operatorToken: token,
      approverToken: null,
      tier: 'owner',
      grantedOps: [],
    };

    const text = dto.reset ? '取消' : dto.text;
    try {
      const reply = await this.chat.reply('sim:' + String(admin?.sub ?? '0'), text, b);
      return { reply, execAs: 'owner' };
    } catch (e) {
      // 试跑台自己不能把异常抛成 500：那样页面上只会看到「请求失败」，
      // 而真正有价值的信息是「机器人这一句崩在哪」。
      return { reply: '机器人这一句处理出错：' + (e as Error).message, execAs: 'owner' };
    }
  }
}
