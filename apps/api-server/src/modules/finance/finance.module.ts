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
import { User } from '../../database/entities/user.entity';
import { Withdraw } from '../../database/entities/withdraw.entity';
import { CommissionService } from './commission.service';
import { FinanceController } from './finance.controller';
import { LeaderFinanceController } from './leader-finance.controller';
import { RefundAdminController } from './refund-admin.controller';
import { RefundAdminService } from './refund-admin.service';
import { RefundService } from './refund.service';
import { ReversalService } from './reversal.service';
import { WithdrawService } from './withdraw.service';

/**
 * 财务模块 · 见《接口规范 v1.0》§4.4 / §6.5 与《目录结构 v2.0》
 *
 * 本期已实装：
 *   · 团长侧四接口：L10 佣金明细 · L11 余额 · L12 提现 · L13 提现记录
 *   · `RefundService` —— L7 团长代退申请（C6 第一段）+ **D11 后台强制退款（第三段）**
 *     + **D41/D42 退款审批（第二段）**
 *   · `ReversalService` —— C9 反向结算（佣金反冲 / 应付冲减 / 余额退回）
 *   · `RefundAdminService` —— 后台 D40 退款流水 / D41 通过 / D42 驳回（P34）
 *
 * 后台侧仍待写：D33–D39、D43–D46（财务总览、应付结算、余额调整、对账、提现审批）。
 *
 * ⚠️ 依赖方向：`OrderModule → FinanceModule`（取 Refund/Reversal），单向无循环。
 *    `OrderModule` 自身也持有 `Refund` 实体（历史原因：`RefundService` 曾住在
 *    order 模块），TypeORM `forFeature` 重复注册同一实体是合法的，不会产生双份表。
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
    ]),
  ],
  controllers: [FinanceController, LeaderFinanceController, RefundAdminController],
  providers: [
    CommissionService,
    WithdrawService,
    RefundService,
    ReversalService,
    RefundAdminService,
  ],
  exports: [CommissionService, WithdrawService, RefundService, ReversalService],
})
export class FinanceModule {}
