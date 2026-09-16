import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Supplier } from '../../database/entities/supplier.entity';
import {
  AdminUser,
  OperationLog,
  SysConfig,
  MessageTemplate,
} from '../../database/entities/system.entity';
import { AdminController } from './admin.controller';
import { AdminUserService } from './admin-user/admin-user.service';
import { ConfigService } from './config/config.service';
import { MessageTemplateService } from './template/message-template.service';
import { AdminRoleService } from './role/role.service';
import { OperationLogService } from './operation-log/operation-log.service';

/**
 * 后台管理模块 · 见《接口规范 v1.0》§6.7 与《目录结构 v2.0》
 *
 * ## 职责边界
 * 本模块只承载**后台自有的系统管理域**（账号 / 角色 / 操作日志 / 系统配置，D51–D60）。
 * 业务域的后台端点**不在这里**，而是就近放在各业务模块内，路径统一以
 * `admin/` 开头：
 *   · `modules/meal/meal-admin.controller.ts`         → D1–D7   套餐编排（M3-2）
 *   · `modules/order/order-admin.controller.ts`       → D8–D12  订单中心（M3-3）
 *   · `modules/building/building-admin.controller.ts` → D13–D18 楼栋与楼群
 *   · `modules/team-leader/leader-admin.controller.ts`→ D19–D22 团长管理
 *   · `modules/supplier/*-admin.controller.ts`        → D23–D32 供应商与集散
 *   · `modules/finance/refund-admin.controller.ts`    → D40–D42 退款审批（C6 收口）
 *   · `modules/finance/supplier-share-admin.controller.ts` → D36–D37 应付结算（M3-9）
 *   · `modules/stats/stats-admin.controller.ts`       → D47–D50 数据统计（**已落点** · M3-11）
 *   · 财务其余端点（D33–D35 / D38–D39 / D43–D44）    → **待落点**（P34 资金总览 / 佣金 / 对账）
 *   · 通知模板（D59–D60）                            → **已落点**（P36 · M3-12，本文件内 AdminController）
 *
 * **为什么这样分**：每个后台控制器只需注入同模块的 service（零跨模块 DI），
 * 依赖关系天然收敛；集中到 admin 模块则会反向依赖全部业务模块。
 *
 * ⚠️ `AdminGuard` 不在此注册 —— 由 `CommonModule`（@Global）提供，全局可直接
 *    `@UseGuards(AdminGuard)`；本模块的 `@Roles()` 亦同理（装饰器无需 DI，
 *    `Reflector` 由守卫自己注入）。
 * ⚠️ `OperationLogInterceptor` 也已在 CommonModule 全局注册（APP_INTERCEPTOR），
 *    故此处只放元数据装饰器 `@OperationLog()`，不必 import 日志实体到各业务模块。
 * ⚠️ `BizConfigService`（配置读取）同样来自 CommonModule（@Global）——
 *    `ConfigService` 直接注入即可，**不要在别处再建一份配置读取**：
 *    「配置唯一入口」这条纪律一旦破，就会出现两套缓存、两种生效时机。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AdminUser, OperationLog, Supplier, SysConfig, MessageTemplate]),
  ],
  controllers: [AdminController],
  providers: [
    AdminUserService,
    AdminRoleService,
    OperationLogService,
    ConfigService,
    MessageTemplateService,
  ],
  exports: [
    AdminUserService,
    AdminRoleService,
    OperationLogService,
    ConfigService,
    // ⚠️ 导出给 `MessageModule`（投递侧按 scene 读模板判断能否发）——
    //    投递侧与管理侧共用 `message-template.specs.ts` 的闸门函数，
    //    但**不共用 service**（读写职责不同：这里管编辑，那边管投递）
    MessageTemplateService,
  ],
})
export class AdminModule {}
