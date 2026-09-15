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
import { Withdraw } from '../../database/entities/withdraw.entity';
import { CommissionService } from './commission.service';
import { FinanceController } from './finance.controller';
import { LeaderFinanceController } from './leader-finance.controller';
import { RefundService } from './refund.service';
import { WithdrawService } from './withdraw.service';

/**
 * 财务模块 · 见《接口规范 v1.0》§4.4 / §6.5 与《目录结构 v2.0》
 *
 * 本期（M2）实装团长侧四接口：L10 佣金明细 · L11 余额 · L12 提现 · L13 提现记录；
 * 另提供 `RefundService` 供 `OrderModule` 承接 **L7 团长代退申请**（C6 第一段）。
 *
 * 后台侧（`/admin/finance/*` · D45/D46 提现审批、D47 付款登记）属 M3，
 * 由 `FinanceController` 预留；应付结算 `SupplierShareService` 属 M3-3.9。
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
    ]),
  ],
  controllers: [FinanceController, LeaderFinanceController],
  providers: [CommissionService, WithdrawService, RefundService],
  exports: [CommissionService, WithdrawService, RefundService],
})
export class FinanceModule {}
