import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  Balance,
  BalanceLog,
  Commission,
  DistributionCenter,
  SupplierShare,
} from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order, Refund } from '../../database/entities/order.entity';
import { Dish, Supplier, SupplierDishDaily } from '../../database/entities/supplier.entity';
import { User } from '../../database/entities/user.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import { MessageModule } from '../message/message.module';
import { CommissionService } from './commission.service';
import { FinanceController } from './finance.controller';
import { LeaderFinanceController } from './leader-finance.controller';
import { RefundAdminController } from './refund-admin.controller';
import { RefundAdminService } from './refund-admin.service';
import { RefundService } from './refund.service';
import { ReversalService } from './reversal.service';
import { SupplierShareAdminController } from './supplier-share-admin.controller';
import { SupplierShareService } from './supplier-share.service';
import { WithdrawService } from './withdraw.service';

/**
 * 财务模块 · 见《接口规范 v1.0》§4.4 / §6.5 与《目录结构 v2.0》
 *
 * 本期已实装：
 *   · 团长侧四接口：L10 佣金明细 · L11 余额 · L12 提现 · L13 提现记录
 *   · `RefundService` —— L7 团长代退申请（C6 第一段）+ **D11 后台强制退款（第三段）**
 *     + **D41/D42 退款审批（第二段）**
 *   · `ReversalService` —— C6 反向结算（**余额退回 + 佣金反冲**；⭐ 自营口径下
 *     **不再冲减供应商应付**，见 `reversal.service.ts` 头注）
 *   · `RefundAdminService` —— 后台 D40 退款流水 / D41 通过 / D42 驳回（P34）
 *   · **M3-9 `SupplierShareService` —— S9 应付结算**（出单 / 列表 / 付款登记 / 未出单异常清单）
 *     + `SupplierShareAdminController`（`/admin/supplier-shares/*`）+ 跑批 `SupplierShareTask`
 *
 * 后台侧仍待写：D33–D39、D43–D46（财务总览、余额调整、对账、提现审批）。
 *
 * ⚠️ 依赖方向：`OrderModule → FinanceModule`（取 Refund/Reversal），单向无循环。
 *    `OrderModule` 自身也持有 `Refund` 实体（历史原因：`RefundService` 曾住在
 *    order 模块），TypeORM `forFeature` 重复注册同一实体是合法的，不会产生双份表。
 *
 * ⚠️ M3-9 为何直接 forFeature `Supplier` / `Dish` / `SupplierDishDaily` 而不依赖
 *    `SupplierModule`：出单要按 (供应商, 菜品) 读**出餐计划的实收量**，属实体级读取。
 *    为此 import `SupplierModule` 会在 FinanceModule ↔ SupplierModule 之间拉出一条
 *    服务依赖（将来供应商端若要复用财务服务就成环），而实体级依赖不构成模块循环
 *    —— 与 M3-5 `TeamLeaderModule`、M3-6 `SupplierModule` 的既有处理一致。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Commission,
      SupplierShare,
      Balance,
      BalanceLog,
      DistributionCenter,
      Withdraw,
      TeamLeader,
      Order,
      Refund,
      User,
      // M3-9 应付结算（S9）读取口径所需
      Supplier,
      Dish,
      SupplierDishDaily,
    ]),
    // M3-12：退款成功后的「退款结果通知」投递口（必推项，见 message-template.specs）
    MessageModule,
  ],
  controllers: [
    FinanceController,
    LeaderFinanceController,
    RefundAdminController,
    SupplierShareAdminController,
  ],
  providers: [
    CommissionService,
    WithdrawService,
    RefundService,
    ReversalService,
    RefundAdminService,
    SupplierShareService,
  ],
  exports: [
    CommissionService,
    WithdrawService,
    RefundService,
    ReversalService,
    // 导出给 `tasks/supplier-share.task.ts`（T+1 02:00 跑批共用同一执行口）
    SupplierShareService,
  ],
})
export class FinanceModule {}
