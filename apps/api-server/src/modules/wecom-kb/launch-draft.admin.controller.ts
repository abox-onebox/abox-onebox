import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import { WecomChatService } from './wecom-chat.service';
import type { LaunchConfirmRunResult, LaunchDraftGenResult } from './wecom-chat.service';
import { WecomSvcTokenService } from './wecom-svc-token.service';
import type { Binding } from './op-proxy.service';

/**
 * 后台 · 开团草稿（#1 自动开团闭环 · 批 4）
 * ==================================================================
 * 「AI 全包准备 + 人一键确认」在后台的那一半：企微是主入口，本页是**兜底**。
 *
 * ## 为什么路径是 `admin/meal/launch-draft`，却住在这个模块
 *
 * 编排逻辑（候选集过滤 / 白名单 / 实时复核 / 两步写入）**只此一份**，长在
 * `WecomChatService` 里。若为好看把它搬到 meal 模块，就得把这个 4700 行服务
 * 导出过去，或者把逻辑复制一份 —— 后者正是「企微排得对、后台排错」的源头。
 * 于是：路径按业务域（meal）取，模块按依赖归属（复用同一服务）。这不是疏忽。
 *
 * ## 两个端点是什么关系
 *
 *   · `POST admin/meal/launch-draft` —— **只读**，出草稿。不写库、不碰排期。
 *   · `POST admin/meal/launch-draft/confirm` —— **写库**。逐条 `assign → publish`，
 *     与企微「确认开团」共用同一条执行链路（`runLaunchConfirm`）。
 *
 * ## 权限（两个端点**不同**，故意如此）
 *
 *   · 生成草稿：`super_admin / admin / operator` —— 只读、不写库。
 *     `operator` 本来就能在「组合矩阵」手工排餐，让 AI 先出个草稿给他看是同一件事的省力版。
 *   · 确认开团：**只给 `super_admin / admin`** —— 这是真改线上排期，2026-11-04 定的口径。
 *
 * ⚠️ 为什么不做成「类级一刀切」：`operator` 的菜单是「非 `/system/` 全可见」派生的，
 *    若两个端点都只给管理员，运营会**看得见入口、点进去 403** —— 正是 `nav:consistency`
 *    头注里说的「能看见但用不了」那种最难受的形态。
 *    方法级 `@Roles` 会覆盖类级（`AdminGuard` 用 `getAllAndOverride`，[handler, class] 顺序）。
 *
 * 执行身份用**负责人服务账号令牌**（`svcToken`），审计头里记的却是**当前管理员姓名**
 * —— 与试跑台同一口径：事后能回答「是谁点的这一下」。
 *
 * ## 为什么不加 `@OperationLog`
 *
 * 两步写入走的是真实的 `admin/meal/assignments` 端点，那些端点自己会留痕；
 * 这里再记一条只会让同一件事在日志里出现两遍。
 */

/*
 * ⚠️ DTO 必须声明在控制器**之前**。
 *
 * 开着 `emitDecoratorMetadata` 时，`@Body() dto: GenerateLaunchDraftDto` 会在
 * 类定义那一刻**求值**出 `design:paramtypes` —— 若 DTO 写在文件末尾，
 * 此时 `GenerateLaunchDraftDto` 还处于 TDZ（`const`/`class` 的暂时性死区），
 * 抛 `ReferenceError: Cannot access '...' before initialization`。
 *
 * 它是**启动即崩**，且 `tsc --noEmit` 完全看不出来（类型层面完全合法）——
 * 本次是 `route:audit` 门禁在 ts-node 里加载控制器时才抓到的。
 */
class GenerateLaunchDraftDto {
  /** 出餐日 YYYY-MM-DD；不传 = 明日 */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'mealDate 必须是 YYYY-MM-DD' })
  mealDate?: string;
}

class ConfirmLaunchDraftDto {
  /** 1-based 行号（可多选）；不传/空 = 全排 */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  picks?: number[];
}

@Controller('admin/meal/launch-draft')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class LaunchDraftAdminController {
  private readonly logger = new Logger(LaunchDraftAdminController.name);

  constructor(
    private readonly chat: WecomChatService,
    private readonly svcToken: WecomSvcTokenService,
  ) {}

  /**
   * 生成开团草稿（只读）。
   *
   * `mealDate` 不传 ⇒ 明日（与企微默认一致；逐日排是既定口径）。
   */
  @Post()
  async generate(
    @Body() dto: GenerateLaunchDraftDto,
    @CurrentAdmin() admin: JwtPayload,
  ): Promise<LaunchDraftGenResult> {
    const who = this.whoOf(admin);
    const binding = await this.ownerBinding(who);
    if (!binding) {
      return {
        ok: false,
        message:
          '「负责人」执行账号还没配好（服务器 .env 缺 WECOM_OWNER_USERNAME / WECOM_OWNER_PASSWORD），' +
          '暂时出不了草稿。可先在「组合矩阵」页手工排。',
      };
    }

    const r = await this.chat.generateLaunchDraftForAdmin(binding, new Date(), dto.mealDate);
    this.logger.log(
      `[launch-draft] ${who} 生成 日期=${dto.mealDate || '(默认明日)'} ok=${r.ok}` +
        (r.ok ? ` 草稿${r.rows.length}条 拦截${r.blocked.length}条` : ''),
    );
    return r;
  }

  /**
   * 确认开团（**真写排期**）。
   *
   * `picks` 是 1-based 行号；不传或传空数组 ⇒ 全排（页面上「默认全选」的语义）。
   * 越界行号由纯函数 `planLaunchConfirm` 直接拒掉（`bad_pick`），不会静默少排。
   */
  @Post('confirm')
  // ⚠️ 方法级覆盖类级：真写排期只给管理员（2026-11-04 定）。别为了「省事」把 operator 加回来。
  @Roles('super_admin', 'admin')
  async confirm(
    @Body() dto: ConfirmLaunchDraftDto,
    @CurrentAdmin() admin: JwtPayload,
  ): Promise<LaunchConfirmRunResult> {
    const who = this.whoOf(admin);
    const binding = await this.ownerBinding(who);
    if (!binding) {
      return {
        ok: false,
        code: 'no_pending',
        detail:
          '「负责人」执行账号还没配好（服务器 .env 缺 WECOM_OWNER_USERNAME / WECOM_OWNER_PASSWORD），' +
          '现在没法真写排期。可先在「组合矩阵」页手工排。',
      };
    }

    const picks = dto.picks && dto.picks.length ? dto.picks : null;
    const r = await this.chat.confirmLaunchDraftForAdmin(binding, picks, new Date());
    this.logger.log(
      `[launch-draft] ${who} 确认开团 picks=${picks ? picks.join(',') : 'ALL'} ` +
        (r.ok ? `成功${r.rows.filter((x) => x.ok).length}/${r.rows.length}` : `拦截=${r.code}`),
    );
    return r;
  }

  /** 审计用的「谁」：管理员姓名优先，退化到 id（与试跑台同一写法） */
  private whoOf(admin: JwtPayload | undefined): string {
    return admin?.username || 'admin#' + String(admin?.sub ?? '?');
  }

  /**
   * 执行身份 = 负责人服务账号。
   *
   * ⚠️ 拿不到令牌就返回 null 并让调用方给出人话 —— 绝不能拿空令牌去打后台
   *   （那样报的是 401「未登录」，会让人以为是自己的登录过期了）。
   */
  private async ownerBinding(who: string): Promise<Binding | null> {
    const token = await this.svcToken.get('owner');
    if (!token) return null;
    return { operatorName: who, operatorToken: token, approverToken: null, tier: 'owner' };
  }
}
