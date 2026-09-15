import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, moneyTransformer, PkColumn } from './transformers';

/**
 * ab_order 订单表
 * 依据：《ER v2.1》§4.6 + 《表结构评审意见 v1.0》P0-2（补 refund_applying / refunding 态）、
 *   P1-5（MVP 阶段**先不分区**，单量破万再引入；分区键须含于所有唯一索引）
 */
@Entity('ab_order')
export class Order {
  @PkColumn()
  id!: number;

  @Index('uk_order_no', { unique: true })
  @Column({
    name: 'order_no',
    type: 'varchar',
    length: 32,
    comment: '业务订单号（应用层保证全局唯一）',
  })
  orderNo!: string;

  @Index('idx_order_user')
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId!: number;

  @Index('idx_order_team_leader')
  @Column({
    name: 'team_leader_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
  })
  teamLeaderId?: number | null;

  @Column({ name: 'building_id', type: 'bigint', transformer: bigintTransformer })
  buildingId!: number;

  @Column({ name: 'building_group_id', type: 'bigint', transformer: bigintTransformer })
  buildingGroupId!: number;

  @Column({ name: 'set_meal_id', type: 'bigint', transformer: bigintTransformer })
  setMealId!: number;

  @Index('idx_order_assignment')
  @Column({
    name: 'assignment_id',
    type: 'bigint',
    transformer: bigintTransformer,
    comment: '关联套餐分配',
  })
  assignmentId!: number;

  @Index('idx_order_status')
  @Column({ name: 'meal_date', type: 'date' })
  mealDate!: string;

  @Column({ type: 'int', default: 1 })
  quantity!: number;

  @Column({
    name: 'unit_price',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 8,
    scale: 2,
    comment: '单价快照 ¥25.80',
  })
  unitPrice!: string;

  @Column({
    name: 'total_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
  })
  totalAmount!: string;

  @Column({
    name: 'balance_used',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    default: 0,
    comment: '余额抵扣',
  })
  balanceUsed!: string;

  @Column({
    name: 'discount_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    default: 0,
  })
  discountAmount!: string;

  @Column({
    name: 'pay_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    comment: '微信实付',
  })
  payAmount!: string;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '备注（过敏等）' })
  remark?: string | null;

  /**
   * 11 态（C6 三段式要求 refund_applying / refunding 可查）
   * pending_pay/paid/cut_off/cooked/delivering/delivered/completed
   * /cancelled/refund_applying/refunding/refunded
   */
  @Index('idx_order_refund_status')
  @Column({ type: 'varchar', length: 24, default: 'pending_pay' })
  status!: string;

  @Column({ name: 'paid_at', type: 'datetime', precision: 3, nullable: true })
  paidAt?: Date | null;

  @Column({ name: 'completed_at', type: 'datetime', precision: 3, nullable: true })
  completedAt?: Date | null;

  @Column({ name: 'cancelled_at', type: 'datetime', precision: 3, nullable: true })
  cancelledAt?: Date | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** ab_payment_log 支付流水（永久保留 · 合规要求） */
@Entity('ab_payment_log')
export class PaymentLog {
  @PkColumn()
  id!: number;

  @Index('uk_payment_order', { unique: true })
  @Column({ name: 'order_id', type: 'bigint', transformer: bigintTransformer })
  orderId!: number;

  @Column({ name: 'order_no', type: 'varchar', length: 32 })
  orderNo!: string;

  @Index('idx_payment_transaction')
  @Column({
    name: 'transaction_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '微信交易号',
  })
  transactionId?: string | null;

  @Column({
    name: 'pay_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
  })
  payAmount!: string;

  @Column({ name: 'pay_method', type: 'varchar', length: 16, default: 'wxpay_jsapi' })
  payMethod!: string;

  @Index('idx_payment_status')
  @Column({
    type: 'varchar',
    length: 16,
    default: 'pending',
    comment: 'pending/success/fail/refunded',
  })
  status!: string;

  @Column({ name: 'paid_at', type: 'datetime', precision: 3, nullable: true })
  paidAt?: Date | null;

  @Column({ name: 'raw_response', type: 'json', nullable: true })
  rawResponse?: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/**
 * ab_refund 退款单（C6 三段式：申请 → 审批 → 实退）
 * 依据：《表结构评审意见 v1.0》P0-5 完整 DDL
 */
@Entity('ab_refund')
export class Refund {
  @PkColumn()
  id!: number;

  @Index('uk_refund_no', { unique: true })
  @Column({ name: 'refund_no', type: 'varchar', length: 32, comment: '退款单号' })
  refundNo!: string;

  @Index('idx_refund_order')
  @Column({ name: 'order_id', type: 'bigint', transformer: bigintTransformer })
  orderId!: number;

  @Column({ name: 'order_no', type: 'varchar', length: 32 })
  orderNo!: string;

  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId!: number;

  @Column({
    name: 'team_leader_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '发起代退的团长',
  })
  teamLeaderId?: number | null;

  @Column({
    name: 'apply_source',
    type: 'varchar',
    length: 16,
    default: 'leader',
    comment: 'user自助/leader团长代退/admin强制（C6）',
  })
  applySource!: string;

  @Column({
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    comment: '退款金额（原路退用户）',
  })
  amount!: string;

  @Column({
    name: 'reason_type',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: 'quality品质/missing缺漏/late延误/wrong错单/other',
  })
  reasonType?: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  reason?: string | null;

  @Index('idx_refund_status_time')
  @Column({
    type: 'varchar',
    length: 16,
    default: 'applying',
    comment: 'applying待审批/approved已批准/refunding退款中/refunded已退款/rejected已驳回',
  })
  status!: string;

  @Column({
    name: 'auditor_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '审批人（后台账号）',
  })
  auditorId?: number | null;

  @Column({ name: 'audit_at', type: 'datetime', precision: 3, nullable: true })
  auditAt?: Date | null;

  @Column({ name: 'audit_remark', type: 'varchar', length: 256, nullable: true })
  auditRemark?: string | null;

  @Column({
    name: 'wx_refund_no',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '微信退款单号',
  })
  wxRefundNo?: string | null;

  @Column({ name: 'refunded_at', type: 'datetime', precision: 3, nullable: true })
  refundedAt?: Date | null;

  @Column({
    type: 'tinyint',
    default: 0,
    comment:
      '反向结算是否已执行（C9：按实际供价/场地费/打包人工/配送费 + 佣金反向回退，平台毛利留存）',
  })
  reversed!: number;

  @Column({ name: 'reversed_at', type: 'datetime', precision: 3, nullable: true })
  reversedAt?: Date | null;

  /**
   * 申请退款**之前**的订单状态（C6 第二段「驳回 → 回原状态」的唯一依据）
   *
   * ⚠️ 为什么必须有这一列：订单状态机对退款分支只画了**单向**箭头
   *    （`cut_off/cooked/delivering/delivered/completed → refund_applying`），
   *    申请时代退接口把 `ab_order.status` 原地改成了 `refund_applying`，
   *    原状态就此丢失。没有它，D42 驳回只能靠「猜」——按时间猜会退回错误的
   *    节点（已 `completed` 的单被退成 `paid`，等于把佣金基数与取餐事实一起抹掉）。
   *
   * 取值：`applyByLeader` / `forceRefund` 写入申请瞬间的 `order.status`；
   *      D11 强制退款不经过「驳回」分支，该列只作审计留痕。
   */
  @Column({
    name: 'order_status_before',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: '申请退款前的订单状态（C6 驳回时回退的目标状态）',
  })
  orderStatusBefore?: string | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** ab_delivery_record 货拉拉送达记录（ER v2.1 §3.6） */
@Entity('ab_delivery_record')
@Index('uk_delivery_date_group', ['mealDate', 'buildingGroupId'], { unique: true })
export class DeliveryRecord {
  @PkColumn()
  id!: number;

  @Column({ name: 'meal_date', type: 'date' })
  mealDate!: string;

  @Column({ name: 'building_group_id', type: 'bigint', transformer: bigintTransformer })
  buildingGroupId!: number;

  @Column({ name: 'expected_at', type: 'datetime', precision: 3, comment: '预计送达 11:30' })
  expectedAt!: Date;

  @Column({
    name: 'actual_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '实际送达',
  })
  actualAt?: Date | null;

  @Column({
    name: 'driver_name',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '货拉拉司机',
  })
  driverName?: string | null;

  @Column({ name: 'driver_phone', type: 'varchar', length: 20, nullable: true })
  driverPhone?: string | null;

  @Column({ name: 'plate_no', type: 'varchar', length: 16, nullable: true, comment: '车牌' })
  plateNo?: string | null;

  @Column({ name: 'total_quantity', type: 'int', default: 0 })
  totalQuantity!: number;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'pending',
    comment: 'pending/called/en_route/arrived',
  })
  status!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  remark?: string | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
