/**
 * 实体统一出口（24 张表）
 *
 * 依据：《数据库 ER 设计 v2.1》+《表结构评审意见 v1.0》（P0-1 ~ P0-6、P1-4、P2-1、P2-5、P2-6）
 *
 * 用户与角色域（4）：User / TeamLeader / Building / LeaderInvite
 * 楼群域（1）：BuildingGroup
 * 商家域（2）：Supplier / Dish
 * 套餐域（3）：SetMeal / SetMealItem / MealAssignment
 * 供应商生产域（1）：SupplierDishDaily
 * 订单与支付域（4）：Order / PaymentLog / Refund / DeliveryRecord
 * 财务域（5）：Commission / SupplierShare / Balance / BalanceLog / DistributionCenter
 * 系统域（4）：AdminUser / OperationLog / SysConfig / Message
 * 合计 24 张
 */
export * from './user.entity';
export * from './leader.entity';
export * from './building.entity';
export * from './supplier.entity';
export * from './meal.entity';
export * from './order.entity';
export * from './finance.entity';
export * from './system.entity';

import { User } from './user.entity';
import { TeamLeader, LeaderInvite } from './leader.entity';
import { Building, BuildingGroup } from './building.entity';
import { Supplier, Dish, SupplierDishDaily } from './supplier.entity';
import { SetMeal, SetMealItem, MealAssignment } from './meal.entity';
import { Order, PaymentLog, Refund, DeliveryRecord } from './order.entity';
import { Commission, SupplierShare, Balance, BalanceLog, DistributionCenter } from './finance.entity';
import { AdminUser, OperationLog, SysConfig, Message } from './system.entity';

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
  Order,
  PaymentLog,
  Refund,
  DeliveryRecord,
  Commission,
  SupplierShare,
  Balance,
  BalanceLog,
  DistributionCenter,
  AdminUser,
  OperationLog,
  SysConfig,
  Message,
];
