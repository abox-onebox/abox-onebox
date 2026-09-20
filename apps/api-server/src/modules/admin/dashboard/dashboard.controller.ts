import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../../common/decorators/auth.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';

import { DashboardService, WorkbenchTodosResult } from './dashboard.service';

/**
 * D66 后台工作台 · 待办聚合（登录落点 `/dashboard` · M5-16）
 *
 * ## 为什么白名单里有 `viewer`
 *
 * `admin-role.ts` 里 `/dashboard` 是**五个运营角色的共同菜单项**
 * （admin / operator / finance / viewer / super_admin —— 它是登录落点）。
 * 若此处把 `viewer` 排除，只读观察者登录后的**第一屏**就会拿 10003 ——
 * 页面上唯一能点的东西全报无权限。同 `StatsAdminController` 的注释：
 * **菜单授权与接口授权必须同源**，「菜单能点、点了报无权限」是最容易被当成 bug 的一类不一致。
 *
 * 且本端点的信息量严格**少于** D47 核心指标（后者已对 `viewer` 开放 GMV / 退款率…），
 * 故不构成新的信息暴露。
 *
 * ## 前端仍然要做一件事：按 `account.menus` 过滤卡片
 *
 * 服务端对 `viewer` 返回的 4 条待办里，指向 `/finance/*`、`/meal/*`、`/order/*` 的三条
 * 它**点不进去**。故端上按 `permission.visiblePaths` 过滤 —— 这是**渲染纪律**，
 * 不是安全边界（安全边界是各域控制器自己的 `@Roles`）。
 * 角色一条都不剩时页面显示「当前角色没有待办处理入口」，而不是伪造一个数字。
 */
@ApiTags('后台·工作台')
@ApiBearerAuth()
@Controller('admin/dashboard')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator', 'finance', 'viewer')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('todos')
  @ApiOperation({
    summary: 'D66 工作台待办聚合（登录落点 P27 前置 · M5-16）',
    description:
      '一次返回 4 类待办计数（退款待审 / 提现待审 / 明日未排套餐的楼群 / 今日逾期未送达）' +
      '与今日作业数字 `brief`。**count=0 的项也返回**（端上据此渲染「已清空」，不靠猜）。' +
      '口径全部复用既有状态机，零新状态：' +
      '① `ab_refund.status=applying`；② `ab_withdraw.status=pending`；' +
      '③ 启用楼群 − 明日有「未取消分配」的楼群；' +
      '④ 今日配送单非 `arrived`，**且仅在过送达时刻后才计入**（否则上午恒红，会被学会无视）。' +
      '本端点只返回计数，不返回明细（明细在各域列表页）。',
  })
  todos(): Promise<WorkbenchTodosResult> {
    return this.dashboard.todos();
  }
}
