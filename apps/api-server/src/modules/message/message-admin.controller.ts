import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/auth.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { IdempotentInterceptor } from '../../common/interceptors/idempotent.interceptor';
import { OrchestrateDto, ReachQueryDto } from './dto/message-f5.dto';
import { MessageOrchestratorService } from './message-orchestrator.service';
import { MessageReachService } from './message-reach.service';

/**
 * 后台 · 消息触达（F5）· 见《接口规范 v1.0》§6.7
 *
 * 路由：`GET /admin/messages/reach` · `POST /admin/messages/orchestrate`
 *
 * ## 为什么是独立控制器，而不是塞进 `AdminController`（`admin/system`）
 *
 * `AdminController` 的类级白名单是 `super_admin / admin`，本控制器**取同一档**，
 * 但两者**归属不同域**：`admin/system/*` 是「系统配置」（账号 / 角色 / 日志 / 配置 / 模板），
 * 而「编排一次触达」是**对外部产生影响的动作**（会给真实用户发消息），
 * 与「改一个配置值」的风险等级不同。分开的好处有两条：
 *   1. 将来若要把「谁可以群发」单独收窄（例如只给 `super_admin`），
 *      改本控制器的装饰器即可，**不会顺带改掉配置页的权限**；
 *   2. `@Roles` 的白名单在**类级**是唯一声明点 —— 混在一个类里就会有两个真相。
 *
 * ⚠️ 但**前端页面**上两者是同页两个 Tab（配置 + 到达率）：页面归属服务端域、
 *    按钮权限随页面。这是刻意的 —— 运营看配置时会顺带看到到达率，
 *    而「谁看到」与「谁能调接口」是两件事（前端过滤是体验，不是安全边界）。
 *
 * ## 为什么两个端点都不收 `admin` 之外的角色
 *
 * 与 `/admin/system/templates` 保持一致（同一批人能配模板，才该是同一批人能触发编排）——
 * 否则会出现「配不了模板、却能按它群发」的错配。
 */
@ApiTags('后台·消息触达')
@ApiBearerAuth()
@Controller('admin/messages')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin')
export class MessageAdminController {
  constructor(
    private readonly orchestrator: MessageOrchestratorService,
    private readonly reachService: MessageReachService,
  ) {}

  @Get('reach')
  @ApiOperation({
    summary: 'D67 通知到达率（按场景 / 按北京日 · F5）',
    description:
      '返回 ① `scenes[]` 按场景汇总（**含区间内 0 投递的场景**，顺序与「模板配置」页一致）；' +
      '② `daily[]` 按北京日汇总；③ `summary` 区间合计。' +
      '⚠️ 到达率的分母是「**已尝试投递**」的条数，**不含**「因未启用被跳过」的通知 —— ' +
      '`ab_message` 按纪律只记「发过什么」。故本接口**算不出「应发未发」**，那要看场景开关与启用闸门。' +
      '⚠️ 一期本接口**必然全 0**（无微信账号 → 模板 ID 全空 → 启用闸门拦住 → 无投递记录）：' +
      '`note` 会明写原因，页面须如实展示，不得粉饰。' +
      '⚠️ `reachRate: null` 表示「区间内没有任何尝试投递」，与「0%」（发了全失败）**语义不同**。' +
      '只读 GET → 不加 `@OperationLog()`。',
  })
  reach(@Query() q: ReachQueryDto) {
    return this.reachService.reach(q);
  }

  /**
   * ⭐ 幂等保护（同一写法对齐 order / team-leader 的写操作）
   *
   * `required: false` 的原因：编排**已经有自己的安全默认**（`dryRun` 缺省 true），
   * 且端上可能只是在后台页面点「算一下人群」；把请求头设成必填会让这类只读用途全部变成 `10001`。
   * 这里真正要防的是「**连点按钮 → 同一批人收到两次**」，故在**服务侧**再加一道
   * 「同场景 + 同目标日 + 当天」的去重键（见 `MessageOrchestratorService.orchestrate`）
   * —— 两道合起来才覆盖「调用方忘了带幂等键」这种情况。
   */
  @Post('orchestrate')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'message-orchestrate', required: false })
  @OperationLog({ module: 'message', action: '编排通知触达' })
  @ApiOperation({
    summary: 'D68 编排一次批量触达（按场景 + 预定义受众 · F5）',
    description:
      '⭐ 「按人按场景编排」的执行口 —— 与未来的自动跑批**共用同一服务方法**（接入时不改业务逻辑）。' +
      '⚠️ `dryRun` **缺省 true**（安全默认）：只解析受众、不投递；要真发必须显式传 `false`。' +
      '出参含 `audienceSize`（**dryRun 也为真值** —— 一期最有用的就是「今天会有多少人该收到提醒」）、' +
      '`delivered` / `ok` / `failed`、`skipped[]`（按原因分组，**不吞掉「为什么没发出去」**）。' +
      '⚠️ 一期由于模板 ID 全空，所有订阅消息场景都会被投递侧在第 2 步跳过，' +
      '`skipped[]` 里会如实出现「场景未启用」——这不是缺陷，是当前真实状态。' +
      '⚠️ 「发过一条通知」是**对外部有影响**的动作，故记操作日志（含 dryRun 的调用也记：' +
      '「谁在什么时候想给谁发什么」本身就该可审计）。' +
      '⚠️ 幂等：带 `Idempotency-Key` 时 10 分钟内重复请求回放首次结果（`10006`）；' +
      '此外**同一场景 + 同一目标出餐日在同一天内只投递一次**，重复触发返回 `10006` —— ' +
      '防的是「按钮在手抖连点之间没人拦，同一批人当天收到两次一样的话」。',
  })
  orchestrate(@Body() dto: OrchestrateDto) {
    return this.orchestrator.orchestrate(dto);
  }
}
