/**
 * 实体统一出口（28 张表）
 *
 * 依据：《数据库 ER 设计 v2.1》+《表结构评审意见 v1.0》（P0-1 ~ P0-6、P1-4、P2-1、P2-5、P2-6）
 *   + 2026-09-15 增补：`ab_withdraw` 提现申请单（M2 · 数据层缺口补齐）
 *   + 2026-09-25 增补：`ab_dish_rating` 口味评价（P1-U2 · 逐菜三键 · 只增表）
 *
 * 用户与角色域（4）：User / TeamLeader / Building / LeaderInvite
 * 楼群域（1）：BuildingGroup
 * 商家域（2）：Supplier / Dish
 * 套餐域（3）：SetMeal / SetMealItem / MealAssignment
 * 供应商生产域（2）：SupplierDishDaily / SupplierDishCenterDaily（M3-8 新增）
 * 订单与支付域（5）：Order / PaymentLog / Refund / DeliveryRecord / DishRating（P1-U2 新增）
 * 财务域（6）：Commission / SupplierShare / Balance / BalanceLog / DistributionCenter / Withdraw
 * 系统域（5）：AdminUser / OperationLog / SysConfig / Message / MessageTemplate（M3-12 新增）
 * 合计 28 张
 */
export * from './user.entity';
export * from './leader.entity';
export * from './building.entity';
export * from './supplier.entity';
export * from './meal.entity';
export * from './order.entity';
export * from './finance.entity';
export * from './withdraw.entity';
export * from './system.entity';

import { User } from './user.entity';
import { TeamLeader, LeaderInvite } from './leader.entity';
import { Building, BuildingGroup } from './building.entity';
import { Supplier, Dish, SupplierDishDaily, SupplierDishCenterDaily } from './supplier.entity';
import { SetMeal, SetMealItem, MealAssignment } from './meal.entity';
import { Order, PaymentLog, Refund, DeliveryRecord, DishRating } from './order.entity';
import {
  Commission,
  SupplierShare,
  Balance,
  BalanceLog,
  DistributionCenter,
} from './finance.entity';
import { Withdraw } from './withdraw.entity';
import { AdminUser, OperationLog, SysConfig, Message, MessageTemplate } from './system.entity';

/** 全量实体数组（TypeORM 注册用） */
export const ALL_ENTITIES = [
  User,
  TeamLeader,
  Building,
  LeaderInvite,
  BuildingGroup,
  Supplier,
  Dish,
  SetMeal,
  SetMealItem,
  MealAssignment,
  SupplierDishDaily,
  SupplierDishCenterDaily,
  Order,
  PaymentLog,
  Refund,
  DeliveryRecord,
  DishRating,
  Commission,
  SupplierShare,
  Balance,
  BalanceLog,
  DistributionCenter,
  Withdraw,
  AdminUser,
  OperationLog,
  SysConfig,
  Message,
  MessageTemplate,
];
