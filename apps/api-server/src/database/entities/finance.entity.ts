import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, moneyTransformer, rateTransformer, PkColumn } from './transformers';

/**
 * ab_commission 团长佣金流水
 *   C2 —— 四级佣金 8/9/10/12%，结算时**冻结等级与费率快照**
 *   C9 —— 退款时以 type='reversal' 生成负向冲销（毛利留存）
 *   C11 —— 出款走灵活用工平台，补 payout_channel / payout_batch_no / tax_withheld_amount
 * 依据：《表结构评审意见 v1.0》P0-6 + P2-5
 */
@Entity('ab_commission')
@Index('uk_commission_order_type', ['orderId', 'type'], { unique: true })
export class Commission {
  @PkColumn()
  id!: number;

  @Column({ name: 'order_id', type: 'bigint', transformer: bigintTransformer })
  orderId!: number;

  @Column({ name: 'order_no', type: 'varchar', length: 32 })
  orderNo!: string;

  @Index('idx_commission_leader_date')
  @Column({ name: 'team_leader_id', type: 'bigint', transformer: bigintTransformer })
  teamLeaderId!: number;

  @Column({ name: 'leader_level', type: 'varchar', length: 16, comment: '结算时等级快照（C2）' })
  leaderLevel!: string;

  @Column({ type: 'decimal', transformer: rateTransformer, precision: 5, scale: 4, comment: '结算时费率快照 0.08/0.09/0.10/0.12' })
  rate!: string;

  @Column({ name: 'base_amount', type: 'decimal', transformer: moneyTransformer, precision: 10, scale: 2, comment: '计佣基数' })
  baseAmount!: string;

  @Column({ type: 'int', comment: '计入份数（实发）' })
  quantity!: number;

  @Column({ type: 'decimal', transformer: moneyTransformer, precision: 10, scale: 2, comment: '佣金金额（正=入账，负=冲销）' })
  amount!: string;

  @Column({ type: 'varchar', length: 16, default: 'normal', comment: 'normal正常/reversal退款冲销（C9）' })
  type!: string;

  @Index('idx_commission_status')
  @Column({ type: 'varchar', length: 16, default: 'pending', comment: 'pending待结算/settled已打款/cancelled已冲销' })
  status!: string;

  @Column({ name: 'settled_at', type: 'datetime', precision: 3, nullable: true })
  settledAt?: Date | null;

  @Column({ name: 'meal_date', type: 'date' })
  mealDate!: string;

  /** ---- C11：灵活用工出款通道 ---- */
  @Column({
    name: 'payout_channel',
    type: 'varchar',
    length: 16,
    default: 'FLEX_MANUAL',
    comment: 'FLEX_MANUAL灵活用工人工/FLEX_API灵活用工API/WECHAT_TRANSFER预留',
  })
  payoutChannel!: string;

  @Column({ name: 'payout_batch_no', type: 'varchar', length: 32, nullable: true, comment: '出款批次号' })
  payoutBatchNo?: string | null;

  @Column({
    name: 'tax_withheld_amount',
    type: 'decimal', transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    default: 0,
    comment: '平台代扣个税（C11，团长到手 = amount - tax）',
  })
  taxWithheldAmount!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/**
 * ab_supplier_share 供应商 / 集散中心应付结算流水
 *   C9（2026-09-15 修订）—— 成本项**可配置、不写死**：
 *     · 供应商供价 —— 与各供应商**逐菜协商**（成交价落库）
 *     · 集散/场地费 —— 集散中心**复用合作供应商场地 → 默认 0**（按实际登记）
 *     · 打包人工 / 配送费 —— 由**平台**承担（雇佣兼职打包 + 安排货拉拉送货）
 *     · 平台毛利 = 售价 − 成本合计 − 佣金（**结果值**，不预设）
 *   退款走 type='reversal' 反向冲减
 *   C11 —— 只记录**应付**，实际付款由财务人工对公转账日结，channel 恒为 manual
 * 依据：《表结构评审意见 v1.0》P0-6
 */
@Entity('ab_supplier_share')
export class SupplierShare {
  @PkColumn()
  id!: number;

  @Index('uk_share_no', { unique: true })
  @Column({ name: 'share_no', type: 'varchar', length: 32, comment: '分账单号' })
  shareNo!: string;

  @Index('idx_share_status')
  @Column({ name: 'share_date', type: 'date', comment: '应付生成日（T+1）' })
  shareDate!: string;

  @Index('idx_share_payee')
  @Column({ name: 'meal_date', type: 'date', comment: '对应出餐日' })
  mealDate!: string;

  @Column({
    name: 'payee_type',
    type: 'varchar',
    length: 16,
    comment: 'supplier供应商/distribution_center集散中心（C9）',
  })
  payeeType!: string;

  @Column({ name: 'payee_id', type: 'bigint', transformer: bigintTransformer, comment: '供应商或集散中心 id' })
  payeeId!: number;

  @Column({ name: 'dish_id', type: 'bigint', transformer: bigintTransformer, nullable: true, comment: '菜品（供应商分账按菜品计）' })
  dishId?: number | null;

  @Column({ type: 'int', comment: '份数' })
  quantity!: number;

  @Column({ name: 'unit_price', type: 'decimal', transformer: moneyTransformer, precision: 8, scale: 2, comment: '单位结算金额（按菜品协商价 / 场地费 / 打包人工 / 配送费分项落库）' })
  unitPrice!: string;

  @Column({ type: 'decimal', transformer: moneyTransformer, precision: 12, scale: 2, comment: '分账金额（正=分账，负=反向冲销）' })
  amount!: string;

  @Column({ type: 'varchar', length: 16, default: 'normal', comment: 'normal正常/reversal反向冲销（C9）' })
  type!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'manual',
    comment: 'manual人工对公转账（当前唯一渠道 · C11）/ wxpay微信分账（二期预留）',
  })
  channel!: string;

  @Column({ name: 'payment_voucher_no', type: 'varchar', length: 64, nullable: true, comment: '付款凭证号（银行回单号）' })
  paymentVoucherNo?: string | null;

  @Column({ name: 'invoice_no', type: 'varchar', length: 64, nullable: true, comment: '供应商发票号（税前扣除凭证）' })
  invoiceNo?: string | null;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'pending',
    comment: 'pending待付款/success已付款/failed异常/reversed已冲减',
  })
  status!: string;

  @Column({ name: 'fail_reason', type: 'varchar', length: 256, nullable: true })
  failReason?: string | null;

  @Column({ name: 'settled_at', type: 'datetime', precision: 3, nullable: true, comment: '结算日' })
  settledAt?: Date | null;

  @Column({ name: 'paid_at', type: 'datetime', precision: 3, nullable: true, comment: '实际付款日（人工转账完成）' })
  paidAt?: Date | null;

  @Column({ name: 'origin_id', type: 'bigint', transformer: bigintTransformer, nullable: true, comment: '反向冲销时指向原分账记录' })
  originId?: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** ab_balance 用户余额账户（ER v2.1 §3.3） */
@Entity('ab_balance')
export class Balance {
  @PkColumn()
  id!: number;

  @Index('uk_balance_user', { unique: true })
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId!: number;

  @Column({ type: 'decimal', transformer: moneyTransformer, precision: 12, scale: 2, default: 0, comment: '可用余额' })
  balance!: string;

  @Column({ type: 'decimal', transformer: moneyTransformer, precision: 12, scale: 2, default: 0, comment: '冻结金额' })
  frozen!: string;

  @Column({ name: 'total_in', type: 'decimal', transformer: moneyTransformer, precision: 12, scale: 2, default: 0, comment: '累计收入' })
  totalIn!: string;

  @Column({ name: 'total_out', type: 'decimal', transformer: moneyTransformer, precision: 12, scale: 2, default: 0, comment: '累计支出' })
  totalOut!: string;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** ab_balance_log 余额变动流水（ER v2.1 §3.4 + P2-5 出款字段） */
@Entity('ab_balance_log')
export class BalanceLog {
  @PkColumn()
  id!: number;

  @Index('idx_balance_log_user_time')
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId!: number;

  @Index('idx_balance_log_type')
  @Column({
    type: 'varchar',
    length: 32,
    comment: 'commission/order_pay/withdraw/withdraw_refund/refund',
  })
  type!: string;

  @Column({ type: 'tinyint', comment: '1收入 -1支出' })
  direction!: number;

  @Column({ type: 'decimal', transformer: moneyTransformer, precision: 12, scale: 2 })
  amount!: string;

  @Column({ name: 'balance_after', type: 'decimal', transformer: moneyTransformer, precision: 12, scale: 2, comment: '操作后余额' })
  balanceAfter!: string;

  @Column({ name: 'related_id', type: 'varchar', length: 64, nullable: true })
  relatedId?: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  remark?: string | null;

  /** ---- C11：提现走灵活用工时的通道与代扣税 ---- */
  @Column({ name: 'payout_channel', type: 'varchar', length: 16, nullable: true })
  payoutChannel?: string | null;

  @Column({ name: 'payout_batch_no', type: 'varchar', length: 32, nullable: true })
  payoutBatchNo?: string | null;

  @Column({ name: 'tax_withheld_amount', type: 'decimal', transformer: moneyTransformer, precision: 10, scale: 2, default: 0, comment: '代扣个税' })
  taxWithheldAmount!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}

/**
 * ab_distribution_center 集散中心配置（C4 · 表驱动，默认 4 个，数量可配置）
 * 依据：《ER v2.1》§3.7
 * ⚠️ C9 修订（2026-09-15）：集散中心**复用合作供应商场地 → 场地费默认 0**；
 *    打包改由平台雇佣兼职承担（平台成本项），故 riceFee / packFee 默认均为 0，按实际登记。
 */
@Entity('ab_distribution_center')
export class DistributionCenter {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, comment: '集散中心名，如"集散中心 1（国贸片）"' })
  name!: string;

  @Index('idx_dc_supplier')
  @Column({ name: 'supplier_id', type: 'bigint', transformer: bigintTransformer, comment: '关联供应商（集散中心=某供应商，可同时出餐）' })
  supplierId!: number;

  @Column({ type: 'varchar', length: 256, comment: '场地地址（集散中心复用合作供应商场地）' })
  address!: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 32, nullable: true })
  contactName?: string | null;

  @Column({ name: 'contact_phone', type: 'varchar', length: 20, nullable: true })
  contactPhone?: string | null;

  @Column({ name: 'rice_fee', type: 'decimal', transformer: moneyTransformer, precision: 8, scale: 2, default: 0, comment: '米饭费用（C9 修订：默认并入供应商供价，本项默认 0，按实际登记）' })
  riceFee!: string;

  @Column({ name: 'pack_fee', type: 'decimal', transformer: moneyTransformer, precision: 8, scale: 2, default: 0, comment: '打包费用（C9 修订：改由平台兼职打包承担，本项默认 0，按实际登记）' })
  packFee!: string;

  @Column({ name: 'service_groups', type: 'json', nullable: true, comment: '服务的楼群 id 列表' })
  serviceGroups?: number[] | null;

  @Index('idx_dc_status')
  @Column({ type: 'tinyint', default: 1, comment: '1启用 0停用' })
  status!: number;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'datetime', precision: 3, nullable: true })
  deletedAt?: Date | null;
}
