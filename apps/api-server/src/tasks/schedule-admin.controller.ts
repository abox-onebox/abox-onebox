import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../common/decorators/auth.decorator';
import { OperationLog } from '../common/decorators/operation-log.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { RunTaskDto } from './dto/schedule.dto';
import { ScheduleAdminService } from './schedule-admin.service';

/**
 * 运营后台 · 定时任务（M4-1 新增）
 *
 * ## 为什么放在 `tasks/` 而不是 `modules/admin/`
 * `modules/admin/` 只承载**后台自有的系统管理域**（账号 / 角色 / 操作日志 / 系统配置）。
 * 把跑批控制台放进去，会让 `AdminModule` 反向依赖全部业务模块
 * （它要调 task → task 依赖 meal/order/supplier/delivery/finance/team-leader）——
 * 这正是 `admin.module.ts` 头部明确要避免的形状。
 * 而 `TasksModule` 本就已经依赖全部业务模块，控制器落在这里**零新增耦合**。
 *
 * ## 两级白名单
 * 类级 `super_admin` / `admin`，**不含 `operator`**：
 *   补跑是**会改写历史数据**的高危操作（把一个已过去的日期重新跑一遍），
 *   不是日常作业。与打包任务（P39，含 operator）的取舍相反，理由也相反 ——
 *   那边是「运营每天都要用」，这边是「出事才用一次，且必须有人负责」。
 *   也不含 `viewer` / `finance` —— 只读角色不该有改写历史的能力。
 *
 * ## 两个端点
 * · `GET  /admin/schedule`           跑批时刻表（8 个任务全列，含未实装项）
 * · `POST /admin/schedule/:task/run` 手动补跑
 */
@ApiTags('后台·定时任务')
@ApiBearerAuth()
@Controller('admin/schedule')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin')
export class ScheduleAdminController {
  constructor(private readonly schedule: ScheduleAdminService) {}

  @Get()
  @ApiOperation({
    summary: '跑批时刻表',
    description:
      '列出全部 8 个定时任务的触发时刻、**操作的目标日期语义**、职责说明与实装状态。\n\n' +
      '⚠️ 重点看 `dateKind`：多个任务的 cron 时刻可能相同，但动的**不是同一天**。\n' +
      '例如 `meal-publish` 与 `auto-confirm` 都在 14:00 触发，前者开「次日」的团、' +
      '后者确认「当日」的单 —— 这是本系统最容易配错的一处，故在此显式下发。\n\n' +
      '`implemented=false` 表示该任务代码尚未落地（M4 分三个子批次推进），' +
      '此字段用于**如实告知**，避免把占位任务误当成已上线功能。',
  })
  list() {
    return this.schedule.list();
  }

  @Post(':task/run')
  @HttpCode(200)
  @OperationLog({ module: 'schedule', action: '手动补跑定时任务' })
  @ApiOperation({
    summary: '手动补跑某个定时任务',
    description:
      '补跑与跑批**共用同一执行口**（任务内部的 `runOnce()`），因此算出来的数与跑批完全一致。\n\n' +
      '⚠️ 补跑**刻意不加锁**：锁的语义是「同一目标日期只跑一次（防并发重入）」，' +
      '而补跑的动机恰恰是「跑批没跑成」——被锁挡住就失去用途。\n' +
      '重复补跑的安全性由各服务的业务幂等保证（以 `meal_date` 为键）。\n\n' +
      '`date` 不传时按任务的日期语义推导（今日 / 次日 / 前一日），与跑批同一天。\n\n' +
      '⚠️ 本接口会**改写历史数据**（如把某个已过日期的订单批量置为已截单），' +
      '仅限 `super_admin` / `admin`，且每次调用都会写操作日志。',
  })
  run(@Param('task') task: string, @Body() dto: RunTaskDto) {
    return this.schedule.run(task, dto.date);
  }
}
