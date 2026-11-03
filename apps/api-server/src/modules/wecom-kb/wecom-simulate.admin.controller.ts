import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import * as crypto from 'crypto';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { WecomChatService } from './wecom-chat.service';
import { WecomSvcTokenService } from './wecom-svc-token.service';
import type { Binding } from './op-proxy.service';
import { execTierOf, normalizeGrant } from './op-policy';
import type { Tier } from './op-policy';

class SimulateDto {
  @IsString()
  @MaxLength(500)
  text!: string;

  /** true = 先清掉这个管理员（+ 这个身份档）的试跑会话（等价于在企微里发「取消」） */
  @IsOptional()
  @IsBoolean()
  reset?: boolean;

  /**
   * 以谁的身份跑：`owner` = 负责人（默认）/ `staff` = 同事。
   *
   * 必须能选，否则试跑台只能验「负责人视角」：同事档（69 项）与「特批了某项」
   * 这两种最需要验的状态，恰恰是企微被备案卡住时唯一验不了的 ——
   * 而它们也正是这套权限设计的重点。
   */
  @IsOptional()
  @IsIn(['owner', 'staff'])
  tier?: Tier;

  /** 同事档的「单独放权」清单（空 = 同事本来能做的那些；有值 = 额外允许） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  grantedOps?: string[];
}

/** 试跑结果：`reply` 是机器人要回的那段话，其余是给页面看的「这次以什么身份、按什么清单跑的」 */
export interface SimulateResult {
  reply: string;
  /** 实际执行身份 —— 可能与所选 tier 不同（同事有清单时会升 owner，见 `execTierOf`） */
  execAs: 'owner' | 'staff' | 'none';
  /** 回显所选档位，便于页面把「你选的」和「实际执行的」并排显示 */
  tier?: Tier;
  /** 生效的放权条数（目录里已失效的编码会被剔除，不计入） */
  granted?: number;
  /** 被剔除的死编码 —— 不提示的话会让人以为「放权了却没生效」 */
  unknown?: string[];
}

/**
 * 机器人「试跑台」· 让机器人在企微回调还没通的情况下也能被验证
 *
 * ## 为什么必须有它
 *
 * 企微回调地址要求**域名**（企业微信不收 IP），备案未完成前机器人收不到任何消息 ——
 * 也就是说「它能操作后台全部功能」这件事，**在当前环境里无法被任何人验证一次**。
 * 「门禁全绿 ≠ 功能可用」在本项目已经踩过：写完了、测过了，但没人真的跑通过一遍。
 * 这个端点走**服务端内部同一套** `WecomChatService.reply()`，不复制任何判据，
 * 所以试跑跑通 ≈ 企微通了就能用。
 *
 * ## 两种身份都能试（2026-11-02 加）
 *
 * 只能以负责人跑时，试跑台证明得了「功能通了」，证明不了「同事放权后到底能做什么」——
 * 而后者才是这套权限设计的目的。故 `tier` + `grantedOps` 可指定，
 * 身份升级规则复用 `op-policy.execTierOf`（与真实回调链路**同一个函数**）。
 *
 * ## 安全边界（这里执行是**真的**写库，不是沙箱）
 *
 *   · 只有 `super_admin / admin` 能进（`AdminGuard` + `@Roles`）；
 *   · 审计不丢人：`X-KB-Operator` 记的是**当前登录管理员姓名**（不是「机器人」），
 *     事后在 `ab_operation_log.kb_operator` 里能查到是谁试的；
 *   · 会话按「管理员 + 身份档 + 放权清单」隔离（`sim:<id>:...`），
 *     与真实企微 userid 不共用状态，也避免「负责人填了一半的草稿」被同事档接着用；
 *   · 高危操作仍然是「草稿 → 回 1 才执行」两轮，试跑也一样 —— 不会因为点了试跑就立刻动钱。
 *
 * ## 为什么不做成「沙箱 / 只读模式」
 *
 * 只读模式下有一半功能（改单、排套餐、发券）根本跑不到，而它们恰恰是最需要验证的部分。
 * 与其做一个「看起来能试但试不出问题」的假沙箱，不如明确标注「这里会真写库」，
 * 让试跑的人自己决定用哪句话。
 */
@Controller('admin/wecom-kb')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin')
export class WecomSimulateController {
  private readonly logger = new Logger(WecomSimulateController.name);

  constructor(
    private readonly chat: WecomChatService,
    private readonly svcToken: WecomSvcTokenService,
  ) {}

  @Post('simulate')
  async simulate(
    @Body() dto: SimulateDto,
    @CurrentAdmin() admin: JwtPayload,
  ): Promise<SimulateResult> {
    const who = admin?.username || 'admin#' + String(admin?.sub ?? '?');
    const tier: Tier = dto.tier === 'staff' ? 'staff' : 'owner';

    // 死编码一律剔除：否则页面上「勾了 3 项」实际只生效 2 项，且没有任何提示
    const { valid, unknown } = normalizeGrant(dto.grantedOps);

    // ★ 与真实回调链路同一个函数（不另写一份规则）
    const execTier = execTierOf(tier, valid);
    const token = await this.svcToken.get(execTier);
    if (!token) {
      const need =
        execTier === 'owner'
          ? 'WECOM_OWNER_USERNAME / WECOM_OWNER_PASSWORD（负责人执行账号）'
          : 'WECOM_SVC_USERNAME / WECOM_SVC_PASSWORD（同事执行账号）';
      return {
        reply: `「${execTier === 'owner' ? '负责人' : '同事'}」执行账号还没配好：服务器 .env.prod 缺 ${need}，暂时没法试跑。`,
        execAs: 'none',
        tier,
        granted: valid.length,
        unknown,
      };
    }

    const b: Binding = {
      // ⚠️ 这里必须是**当前管理员姓名**，不是「试跑台」：审计要能回答「谁干的」
      operatorName: who,
      operatorToken: token,
      approverToken: null,
      tier,
      grantedOps: valid,
    };

    const text = dto.reset ? '取消' : dto.text;
    try {
      const reply = await this.chat.reply(this.sessionKey(admin, tier, valid), text, b);
      return { reply, execAs: execTier, tier, granted: valid.length, unknown };
    } catch (e) {
      // 试跑台自己不能把异常抛成 500：那样页面上只会看到「请求失败」，
      // 而真正有价值的信息是「机器人这一句崩在哪」。
      return {
        reply: '机器人这一句处理出错：' + (e as Error).message,
        execAs: execTier,
        tier,
        granted: valid.length,
        unknown,
      };
    }
  }

  /**
   * 手动「立即跑一次编排并推送负责人」（与每日 09:00 Cron 同链路）。
   *
   * ⚠️ **不 await**：完整编排要跑 12 个节点（各含 LLM 调用，单节点最长 45s），
   *   全程同步等待会超过 nginx 的 60s 网关超时 → 调用方收到 504，但服务端其实跑完了。
   *   故这里「点火即返回」，真正的成败由 `triggerOwnerPush` 写日志 +
   *   把摘要推到负责人手机来确认（grep 服务器日志 `已推送摘要给` 即可看结果）。
   *
   * 这是「接通推送」验证环节唯一缺的那一步：负责人绑定就绪后，
   * 调一次本端点，过 1~3 分钟看手机有没有收到，即可确认端到端打通。
   */
  @Post('orchestrate-now')
  async orchestrateNow(): Promise<{ triggered: boolean; note: string }> {
    void this.chat
      .triggerOwnerPush()
      .then((r) =>
        this.logger.log(
          '[orchestrate-now] 完成 pushed=' +
            r.pushed +
            ' reason=' +
            (r.reason || '') +
            ' digestLen=' +
            r.digestLen,
        ),
      )
      .catch((e) => this.logger.error('[orchestrate-now] 异常：' + (e as Error).message));
    return {
      triggered: true,
      note:
        '编排已在后台触发（与每日 09:00 自动推送同一条链路），预计 1~3 分钟后推送至负责人手机；' +
        '成功与否可 grep 服务器日志 "已推送摘要给" 确认（pushed=成功 / reason=失败原因）。',
    };
  }

  /**
   * 会话键：管理员 + 身份档 + 放权清单指纹。
   *
   * 为什么把清单也算进去：同一个管理员先以「同事（无特批）」试一句「找 退款」，
   * 再切到「同事 + 特批退款」接着回「1」——若共用会话，那次执行用的还是上一档的上下文，
   * 结论就会莫名其妙。清单变了就当换了一个人，各聊各的。
   */
  private sessionKey(admin: JwtPayload, tier: Tier, granted: readonly string[]): string {
    const id = String(admin?.sub ?? '0');
    if (tier === 'owner') return 'sim:' + id + ':owner';
    if (granted.length === 0) return 'sim:' + id + ':staff';
    const h = crypto
      .createHash('sha1')
      .update([...granted].sort().join(','))
      .digest('hex');
    return 'sim:' + id + ':staff:' + h.slice(0, 8);
  }
}
