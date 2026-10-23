import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CouponDef, UserCoupon } from '../../database/entities/coupon.entity';
import { CouponService } from './coupon.service';
import { CouponController } from './coupon.controller';
import { CouponAdminController } from './coupon-admin.controller';

/**
 * 代金券模块（独立券系统 · 2026-10-23）
 *
 * 用户端（/coupon/*）与后台端（/admin/coupon/*）控制器就近放在本模块，
 * 路径统一前缀与《接口规范》§6.7 一致；后台端由 `AdminGuard` 全局兜底鉴权。
 *
 * ⚠️ `CouponService` 导出给 `OrderModule` —— 下单核销（`reserveForOrder`）需在同一事务内调用，
 *    故订单模块依赖本模块而非反向。
 */
@Module({
  imports: [TypeOrmModule.forFeature([CouponDef, UserCoupon])],
  controllers: [CouponController, CouponAdminController],
  providers: [CouponService],
  exports: [CouponService],
})
export class CouponModule {}
