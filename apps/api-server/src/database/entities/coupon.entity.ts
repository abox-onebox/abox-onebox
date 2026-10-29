import { Column, CreateDateColumn, Entity, Index, UpdateDateColumn } from 'typeorm';
import { bigintTransformer, moneyTransformer, PkColumn } from './transformers';

/**
 * ab_coupon 代金券券种定义（后台管理）
 *   独立券系统（2026-10-23）：券的「面额 / 门槛 / 有效期 / 限量」在此定义，
 *   发放时按定义生成 `ab_user_coupon`。
 *   用途：推荐转正返券 / 售后补偿 / 后台手动发券。不是营销满减主玩法。
 *
 * ⚠️ 实体索引声明必须与迁移（`17*coupon*.ts`）逐名逐列一致 —— 由 `index:parity` 看住。
 */
@Entity('ab_coupon')
export class CouponDef {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, comment: '券名称' })
  name!: string;

  @Column({
    // ⚠️ `name` **必须显式写**：TypeORM 的默认命名策略（`DefaultNamingStrategy`）
    //    **不做** camelCase → snake_case 转换，列名就是属性名原样。
    //    故漏写 `name` 时实体侧建出的是 `faceValue`，而迁移 SQL 里是 `face_value`
    //    —— `schema:parity` 会同时报「迁移缺列 faceValue」+「迁移多出 face_value」，
    //    且**生产与本地会各建一套列名**。本仓所有多词列都显式声明 `name`，本列同规。
    name: 'face_value',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    comment: '面额（元）',
  })
  faceValue!: string;

  @Column({
    name: 'threshold',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    default: 0,
    comment: '使用门槛（元）；0 = 无门槛',
  })
  threshold!: string;

  @Column({
    name: 'validity_type',
    type: 'varchar',
    length: 16,
    comment: 'days=领取后N天有效 / period=固定起止日',
  })
  validityType!: string;

  @Column({ name: 'valid_days', type: 'int', nullable: true, comment: 'validity_type=days 时有效' })
  validDays?: number | null;

  @Column({
    name: 'valid_from',
    type: 'date',
    nullable: true,
    comment: 'validity_type=period 时生效日',
  })
  validFrom?: string | null;

  @Column({
    name: 'valid_to',
    type: 'date',
    nullable: true,
    comment: 'validity_type=period 时失效日',
  })
  validTo?: string | null;

  @Column({
    name: 'total_limit',
    type: 'int',
    nullable: true,
    comment: '发行总量上限；null = 不限',
  })
  totalLimit?: number | null;

  @Column({ name: 'issued_count', type: 'int', default: 0, comment: '已发放数' })
  issuedCount!: number;

  @Column({ type: 'varchar', length: 16, default: 'active', comment: 'active/inactive' })
  status!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  remark?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/**
 * ab_user_coupon 用户持有券（发放记录 / 我的券 / 核券记录共用）
 *   每张券有唯一券码；核销时写 `used_at` / `order_no`。
 *   逻辑过期（valid_to 已过且仍 unused）由查询时判定，不另存状态。
 */
@Entity('ab_user_coupon')
@Index('idx_user_coupon_user_status', ['userId', 'status'])
// ⭐ `uk_user_coupon_batch_user` 是**批量发放的幂等锚**：同一批次同一用户只允许一张券。
//    MySQL 唯一索引允许多个 NULL ⇒ 单人发券（grantBatchNo 为 NULL）不受此约束。
//    索引名 / 列 / 列顺序须与迁移 `1700000000021-coupon-batch.ts` 逐项一致（`index:parity`）。
@Index('idx_user_coupon_batch', ['grantBatchNo'])
@Index('uk_user_coupon_batch_user', ['grantBatchNo', 'userId'], { unique: true })
export class UserCoupon {
  @PkColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId!: number;

  @Index('uk_user_coupon_code', { unique: true })
  @Column({ name: 'code', type: 'varchar', length: 32, comment: '唯一券码' })
  code!: string;

  @Column({ name: 'coupon_def_id', type: 'bigint', transformer: bigintTransformer, nullable: true })
  couponDefId?: number | null;

  @Column({ type: 'varchar', length: 64, comment: '券名称（快照）' })
  name!: string;

  @Column({
    // ⚠️ 同 `CouponDef.faceValue`：默认命名策略不转 snake_case，多词列必须显式 `name`
    name: 'face_value',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    comment: '面额（元）',
  })
  faceValue!: string;

  @Column({
    name: 'threshold',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    default: 0,
    comment: '使用门槛（元）；0 = 无门槛',
  })
  threshold!: string;

  @Column({ name: 'valid_from', type: 'datetime', precision: 3 })
  validFrom!: Date;

  @Column({ name: 'valid_to', type: 'datetime', precision: 3 })
  validTo!: Date;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'unused',
    comment: 'unused/used/revoked（expired 为查询期判定，落库仍 unused；revoked=已回收）',
  })
  status!: string;

  @Column({
    name: 'obtained_from',
    type: 'varchar',
    length: 16,
    default: 'manual',
    comment: 'referral/compensation/manual/system/activity',
  })
  obtainedFrom!: string;

  @Column({ name: 'used_at', type: 'datetime', precision: 3, nullable: true })
  usedAt?: Date | null;

  @Column({ name: 'order_no', type: 'varchar', length: 32, nullable: true, comment: '核销订单号' })
  orderNo?: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '发放备注（补偿原因等）' })
  remark?: string | null;

  /**
   * 批量发放批次号（同一批共用；单人发券为 `NULL`）
   *
   * 两个用途：① **幂等** —— 重复提交同一批次时按它查出「已发过谁」并跳过；
   * ② **追溯** —— 「10-29 那批补偿券发给谁了」。
   */
  @Column({ name: 'grant_batch_no', type: 'varchar', length: 32, nullable: true })
  grantBatchNo?: string | null;

  /** 回收时刻（`NULL` = 未回收）；行保留，只打标记（审计口径同 `deleted_at`） */
  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true })
  revokedAt?: Date | null;

  /**
   * 回收操作人 `ab_admin_user.id`
   *
   * ⚠️ 回收**原因**不占列 —— 由 `@OperationLog` 的 `request_data` 落操作日志，
   *    不在这里冗余第二份审计信息。
   */
  @Column({ name: 'revoked_by', type: 'bigint', transformer: bigintTransformer, nullable: true })
  revokedBy?: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
