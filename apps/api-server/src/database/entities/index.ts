/**
 * 实体统一出口（35 张表）
 *
 * 依据：《数据库 ER 设计 v2.1》+《表结构评审意见 v1.0》（P0-1 ~ P0-6、P1-4、P2-1、P2-5、P2-6）
 *   + 2026-09-15 增补：`ab_withdraw` 提现申请单（M2 · 数据层缺口补齐）
 *   + 2026-09-25 增补：`ab_item_rating` 口味评价（P1-U2 · 逐菜三键 · 只增表）
 *   + 2026-10-20 增补：`ab_page_track` 页面停留埋点（U15 · 匿名聚合 · 只增表）
 *   + 2026-10-26 增补：`ab_sales_pause` 全局停售区间（W1 · 刻意不走 `ab_config`：其 60s 缓存会让停售不立刻生效）
 *   + 2026-10-29 增补：`ab_delivery_proof` 配送送达凭证（Q3 · 挂配送单而非订单 · 只增表）
 *
 * 用户与角色域（4）：User / TeamLeader / Building / LeaderInvite
 * 楼群域（1）：BuildingGroup
 * 商家域（2）：Supplier / Item
 * 套餐域（3）：SetMeal / SetMealItem / MealAssignment
 * 供应商生产域（2）：SupplierItemDaily / SupplierItemCenterDaily（M3-8 新增）
 * 订单与支付域（6）：Order / PaymentLog / Refund / DeliveryRecord / DeliveryProof（Q3 新增） / ItemRating（P1-U2 新增）
 * 财务域（6）：Commission / SupplierShare / Balance / BalanceLog / DistributionCenter / Withdraw
 * 券域（2）：CouponDef / UserCoupon（独立券系统 · 2026-10-23）
 * 系统域（9）：AdminUser / OperationLog / SysConfig / Message / MessageTemplate / OperationRequest（阶段3 新增） / OpBlocklist / PageTrack（U15 新增） / SalesPause（W1 新增）
 *
 * ⚠️ 合计以 `ALL_ENTITIES` 为准（当前 35 张）—— `schema:parity` 是权威对账器，
 *    上面分类注释只是人读的索引，别拿它当计数真源。
 */
export * from './user.entity';
export * from './leader.entity';
export * from './building.entity';
export * from './supplier.entity';
export * from './meal.entity';
export * from './order.entity';
export * from './finance.entity';
export * from './withdraw.entity';
export * from './coupon.entity';
export * from './system.entity';

import { User } from './user.entity';
import { TeamLeader, LeaderInvite } from './leader.entity';
import { Building, BuildingGroup } from './building.entity';
import { Supplier, Item, SupplierItemDaily, SupplierItemCenterDaily } from './supplier.entity';
import { SetMeal, SetMealItem, MealAssignment } from './meal.entity';
import {
  Order,
  PaymentLog,
  Refund,
  DeliveryRecord,
  DeliveryProof,
  ItemRating,
} from './order.entity';
import {
  Commission,
  SupplierShare,
  Balance,
  BalanceLog,
  DistributionCenter,
} from './finance.entity';
import { Withdraw } from './withdraw.entity';
import { CouponDef, UserCoupon } from './coupon.entity';
import {
  AdminUser,
  OperationLog,
  SysConfig,
  Message,
  MessageTemplate,
  OperationRequest,
  OpBlocklist,
  PageTrack,
  SalesPause,
} from './system.entity';

/** 全量实体数组（TypeORM 注册用） */
export const ALL_ENTITIES = [
  User,
  TeamLeader,
  Building,
  LeaderInvite,
  BuildingGroup,
  Supplier,
  Item,
  SetMeal,
  SetMealItem,
  MealAssignment,
  SupplierItemDaily,
  SupplierItemCenterDaily,
  Order,
  PaymentLog,
  Refund,
  DeliveryRecord,
  DeliveryProof,
  ItemRating,
  Commission,
  SupplierShare,
  Balance,
  BalanceLog,
  DistributionCenter,
  Withdraw,
  CouponDef,
  UserCoupon,
  AdminUser,
  OperationLog,
  SysConfig,
  Message,
  MessageTemplate,
  OperationRequest,
  OpBlocklist,
  PageTrack,
  SalesPause,
];
