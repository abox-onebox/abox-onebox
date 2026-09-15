import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, moneyTransformer, PkColumn } from './transformers';

/**
 * ab_set_meal 套餐模板
 * 依据：《ER v2.1》§4.4 + 《表结构评审意见 v1.0》P1-4
 *   —— 本表只做「模板库开关」，流转状态（已分配/已截单/已完成）由
 *      ab_meal_assignment 承担，避免两处状态打架。
 */
@Entity('ab_set_meal')
export class SetMeal {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 128, nullable: true, comment: '套餐名（运营填写）' })
  name?: string | null;

  @Index('idx_set_meal_status_date')
  @Column({ name: 'meal_date', type: 'date', nullable: true, comment: '模板日期（冗余，可空）' })
  mealDate?: string | null;

  @Column({ type: 'decimal', transformer: moneyTransformer, precision: 8, scale: 2, comment: '售价 ¥25.80（C1）' })
  price!: string;

  @Column({ name: 'cost_price', type: 'decimal', transformer: moneyTransformer, precision: 8, scale: 2, comment: '供价合计（C9 修订：按与各供应商逐菜协商价，非固定）' })
  costPrice!: string;

  @Column({ name: 'cover_url', type: 'varchar', length: 512, nullable: true })
  coverUrl?: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description?: string | null;

  @Column({ name: 'one_liner', type: 'varchar', length: 128, nullable: true, comment: '一句话介绍' })
  oneLiner?: string | null;

  @Column({ type: 'tinyint', default: 1, comment: '1启用 0停用（模板库开关 · P1-4）' })
  status!: number;

  @Column({ name: 'created_by', type: 'bigint', transformer: bigintTransformer, nullable: true })
  createdBy?: number | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** ab_set_meal_item 套餐菜品明细（一饭四菜：主荤/半荤/素菜/汤/主食） */
@Entity('ab_set_meal_item')
export class SetMealItem {
  @PkColumn()
  id!: number;

  @Index('idx_set_meal_item_meal')
  @Column({ name: 'set_meal_id', type: 'bigint', transformer: bigintTransformer })
  setMealId!: number;

  @Column({ name: 'dish_id', type: 'bigint', transformer: bigintTransformer })
  dishId!: number;

  @Index('idx_set_meal_item_supplier')
  @Column({ name: 'supplier_id', type: 'bigint', transformer: bigintTransformer, comment: '可重复（同一供应商可出多菜）' })
  supplierId!: number;

  @Column({ type: 'tinyint', comment: '档位 1主荤 2半荤 3素菜 4汤 5主食' })
  slot!: number;

  @Column({ name: 'share_amount', type: 'decimal', transformer: moneyTransformer, precision: 8, scale: 2, nullable: true })
  shareAmount?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}

/**
 * ab_meal_assignment 套餐-楼群-日期分配 ⭐ 核心
 * 依据：《ER v2.1》§3.2 + 《表结构评审意见 v1.0》P0-3
 *   —— distribute_supplier_id 已改为 distribution_center_id（对齐 C4 表驱动）
 */
@Entity('ab_meal_assignment')
@Index('uk_meal_assignment_date_group', ['mealDate', 'buildingGroupId'], { unique: true })
export class MealAssignment {
  @PkColumn()
  id!: number;

  @Column({ name: 'meal_date', type: 'date', comment: '套餐日期' })
  mealDate!: string;

  @Column({ name: 'building_group_id', type: 'bigint', transformer: bigintTransformer })
  buildingGroupId!: number;

  @Index('idx_meal_assignment_meal')
  @Column({ name: 'set_meal_id', type: 'bigint', transformer: bigintTransformer })
  setMealId!: number;

  @Index('idx_meal_assignment_dc')
  @Column({
    name: 'distribution_center_id',
    type: 'bigint', transformer: bigintTransformer,
    nullable: true,
    comment: '该楼群的集散中心（关联 ab_distribution_center · C4）',
  })
  distributionCenterId?: number | null;

  @Column({ type: 'varchar', length: 16, default: 'pending', comment: 'pending/active/cancelled' })
  status!: string;

  @Column({ name: 'publish_at', type: 'datetime', precision: 3, nullable: true, comment: '实际开放预订时间' })
  publishAt?: Date | null;

  @Column({ name: 'cutoff_at', type: 'datetime', precision: 3, nullable: true, comment: '实际截单时间（冗余）' })
  cutoffAt?: Date | null;

  @Column({ name: 'sold_count', type: 'int', default: 0, comment: '已订份数（实时累加）' })
  soldCount!: number;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
