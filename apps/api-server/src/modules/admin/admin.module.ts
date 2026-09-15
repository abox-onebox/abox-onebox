import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Supplier } from '../../database/entities/supplier.entity';
import { AdminUser, OperationLog } from '../../database/entities/system.entity';
import { AdminController } from './admin.controller';
import { AdminUserService } from './admin-user/admin-user.service';
import { AdminRoleService } from './role/role.service';
import { OperationLogService } from './operation-log/operation-log.service';

/**
 * 后台管理模块 · 见《接口规范 v1.0》§6.7 与《目录结构 v2.0》
 *
 * ## 职责边界
 * 本模块只承载**后台自有的系统管理域**（账号 / 角色 / 操作日志，D51–D56）。
 * 业务域的后台端点**不在这里**，而是就近放在各业务模块内，路径统一以
 * `admin/` 开头：
 *   · `modules/meal/meal-admin.controller.ts`         → D1–D7   套餐编排（M3-2）
 *   · `modules/order/order-admin.controller.ts`       → D8–D12  订单中心（M3-3）
 *   · `modules/building/building-admin.controller.ts` → D13–D18 楼栋与楼群（M3-4）
 *   · `modules/team-leader/leader-admin.controller.ts`→ D19–D22 团长管理（M3-4）
 *   · `modules/supplier/*-admin.controller.ts`        → D23–D32 供应商与集散（M3-5）
 *   · `modules/finance/finance-admin.controller.ts`   → D33–D46 财务结算（M3-6）
 *   · `modules/stats/stats-admin.controller.ts`       → D47–D50 数据统计（M3-7）
 *
 * **为什么这样分**：每个后台控制器只需注入同模块的 service（零跨模块 DI），
 * 依赖关系天然收敛；集中到 admin 模块则会反向依赖全部业务模块。
 *
 * ⚠️ `AdminGuard` 不在此注册 —— 由 `CommonModule`（@Global）提供，全局可直接
 *    `@UseGuards(AdminGuard)`；本模块的 `@Roles()` 亦同理（装饰器无需 DI，
 *    `Reflector` 由守卫自己注入）。
 * ⚠️ `OperationLogInterceptor` 也已在 CommonModule 全局注册（APP_INTERCEPTOR），
 *    故此处只放元数据装饰器 `@OperationLog()`，不必 import 日志实体到各业务模块。
 */
@Module({
  imports: [TypeOrmModule.forFeature([AdminUser, OperationLog, Supplier])],
  controllers: [AdminController],
  providers: [AdminUserService, AdminRoleService, OperationLogService],
  exports: [AdminUserService, AdminRoleService, OperationLogService],
})
export class AdminModule {}
