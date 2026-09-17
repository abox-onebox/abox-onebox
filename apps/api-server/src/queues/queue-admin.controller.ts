import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { QueueService } from '../common/queue/queue.service';
import { Roles } from '../common/decorators/auth.decorator';
import { AdminGuard } from '../common/guards/admin.guard';

/**
 * 运营后台 · 队列状态（M4-3 新增）
 *
 * ## 为什么必须有这个端点
 *
 * 队列的**最大风险不是「失败」，而是「静默失效」**：
 *   · 任务进不去队列（Redis 抖动 / 驱动配错）→ 业务照常返回成功；
 *   · 任务进去了没人消费 → 数据停在中间态；
 *   · 重试耗尽 → 只有一条日志，轮转后就查不到了。
 * 这三种都不会让接口报错。所以必须有一个**只读**的地方能回答：
 * 「现在是什么驱动？会不会丢？三个队列各积压多少？有没有进死信的？」
 *
 * ## 两级白名单
 * 类级 `super_admin` / `admin` / `operator`，**不含 `viewer` / `finance`**：
 * 这与 D47–D50 看板（含 `viewer`）相反，理由也相反 —— 那边是**业务数据**，
 * 只读角色本就该看；这里是**运行态实现细节**（驱动名、积压计数、重试参数），
 * 给业务观察者看没有用途，只是扩大暴露面。与 P39 打包任务含 `operator`
 * 一致：**运维要能第一时间知道「退款任务在重试」**。
 *
 * 本端点**只读**，故无 `@OperationLog()`（不产生变更，无需留痕）。
 */
@ApiTags('后台·队列')
@ApiBearerAuth()
@Controller('admin/queue')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class QueueAdminController {
  constructor(private readonly queue: QueueService) {}

  @Get()
  @ApiOperation({
    summary: '队列状态（驱动 / 是否持久 / 各队列计数）',
    description:
      '⭐ 重点看 `driver` 与 `durable`：\n' +
      '· `driver=redis` + `durable=true` —— 任务持久在 Redis，进程重启不丢（生产形态）；\n' +
      '· `driver=memory` + `durable=false` —— **进程内队列，重启即丢**，且多实例部署时' +
      '任务不会跨实例分发（仅限本地开发与测试）。\n\n' +
      '`failed` 表示**重试耗尽、已进死信**（不是「失败了一次」——中间重试还在 waiting/delayed 里）。' +
      '死信同时会写一条操作日志（`module=queue` / `action=任务重试耗尽`），据此可查到具体业务对象。\n\n' +
      '⚠️ `driver=memory` 时**不要**把它当成生产可用的队列：它存在的意义是让本地与 e2e ' +
      '能跑通「入队 → 消费 → 重试」整条链路，而不是承担可靠性。',
  })
  status() {
    return this.queue.stats();
  }
}
