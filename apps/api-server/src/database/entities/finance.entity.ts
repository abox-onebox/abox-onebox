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

  @Column({
    type: 'decimal',
    transformer: rateTransformer,
    precision: 5,
    scale: 4,
    comment: '结算时费率快照 0.08/0.09/0.10/0.12',
  })
  rate!: string;

  @Column({
    name: 'base_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    comment: '计佣基数',
  })
  baseAmount!: string;

  @Column({ type: 'int', comment: '计入份数（实发）' })
  quantity!: number;

  @Column({
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    comment: '佣金金额（正=入账，负=冲销）',
  })
  amount!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'normal',
    comment: 'normal正常/reversal退款冲销（C9）',
  })
  type!: string;

  @Index('idx_commission_status')
  @Column({
    type: 'varchar',
    length: 16,
    default: 'pending',
    comment: 'pending待结算/settled已打款/cancelled已冲销',
  })
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

  @Column({
    name: 'payout_batch_no',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '出款批次号',
  })
  payoutBatchNo?: string | null;

  @Column({
    name: 'tax_withheld_amount',
    type: 'decimal',
    transformer: moneyTransformer,
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
 * ab_supplier_share 供应商**采购应付**结算流水
 *   C9（2026-09-15 修订）—— 成本项**可配置、不写死**：
 *     · 供应商供价 —— 与各供应商**逐菜协商**（成交价落库）
 *     · 场所摊销 —— ABox **自有持证场所**（自营口径 2026-09-16；默认 0 仅表示未登记）
 *     · 打包人工 / 配送费 —— 由**平台**承担（雇佣兼职打包 + 安排货拉拉送货）
 *     · 平台毛利 = 售价 − 成本合计 − 佣金（**结果值**，不预设）
 *   退款走 type='reversal' 反向冲减
 *   C11 —— 只记录**应付**，实际付款由财务人工对公转账日结，channel 恒为 manual
 * 依据：《表结构评审意见 v1.0》P0-6
 *
 * ⚠️ 【自营口径 2026-09-16 · 详见《ABox一盒自营结算口径定义v1.0.md》】
 *   本表语义从「分账流水」改为「**半成品采购应付**」：
 *   - **payee_type 恒 `supplier`**；`distribution_center` **冻结**（历史可读，新单不再产生 ——
 *     加工场所属 ABox 自己，付场地费给自己无财务意义）
 *   - **quantity = 实收量**（`ab_supplier_dish_daily.actual_quantity`），**不是订单销量**；
 *     `unit_price` = 逐菜协商采购价；`amount` = quantity × unit_price
 *   - `invoice_no` 重要性上升（自营下是税前扣除凭证）
 *   - ⭐ **用户退款不再冲减本表**（半成品在出餐日已交付）—— `type='reversal'` 改义为
 *     「应付单生成后发现算错」的**纠错冲销**，不再由退款触发。
 *     该改动需同步回退 `modules/finance/reversal.service.ts` 的 `reverseSupplierShares`
 *     （M3-9 前置项）。
 */
@Entity('ab_supplier_share')
export class SupplierShare {
  @PkColumn()
  id!: number;

  @Index('uk_share_no', { unique: true })
  @Column({ name: 'share_no', type: 'varchar', length: 32, comment: '应付单号' })
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

  @Column({
    name: 'payee_id',
    type: 'bigint',
    transformer: bigintTransformer,
    comment: '供应商或集散中心 id',
  })
  payeeId!: number;

  @Column({
    name: 'dish_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '菜品（采购应付按菜品逐项计）',
  })
  dishId?: number | null;

  @Column({ type: 'int', comment: '份数' })
  quantity!: number;

  @Column({
    name: 'unit_price',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 8,
    scale: 2,
    comment: '单位结算金额（按菜品协商价 / 场地费 / 打包人工 / 配送费分项落库）',
  })
  unitPrice!: string;

  @Column({
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    comment: '应付金额（正=应付，负=纠错冲销）',
  })
  amount!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'normal',
    comment: 'normal正常/reversal反向冲销（C9）',
  })
  type!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'manual',
    comment: 'manual人工对公转账（当前唯一渠道 · C10/C11）/ wxpay 预留（自营下不适用）',
  })
  channel!: string;

  @Column({
    name: 'payment_voucher_no',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '付款凭证号（银行回单号）',
  })
  paymentVoucherNo?: string | null;

  @Column({
    name: 'invoice_no',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '供应商发票号（税前扣除凭证）',
  })
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

  @Column({
    name: 'paid_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '实际付款日（人工转账完成）',
  })
  paidAt?: Date | null;

  @Column({
    name: 'origin_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '纠错冲销时指向原应付行',
  })
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

  @Column({
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
    comment: '可用余额',
  })
  balance!: string;

  @Column({
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
    comment: '冻结金额',
  })
  frozen!: string;

  @Column({
    name: 'total_in',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
    comment: '累计收入',
  })
  totalIn!: string;

  @Column({
    name: 'total_out',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
    comment: '累计支出',
  })
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

  @Column({
    name: 'balance_after',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    comment: '操作后余额',
  })
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

  @Column({
    name: 'tax_withheld_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    default: 0,
    comment: '代扣个税',
  })
  taxWithheldAmount!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}

/**
 * ab_distribution_center 集散中心配置（C4 · 表驱动，默认 4 个，数量可配置）
 * 依据：《ER v2.1》§3.7
 *
 * ## ⭐ 自营口径下本表的语义（2026-09-16 路线裁定 + M4-0 落地）
 *
 * 本表 = **ABox 自有加工 / 出餐场所**（中央厨房 / 加工点）。
 * 半成品由各供应商送到这里 → ABox 完成**热加工 / 复温**（要有加热设备、温度记录、留样，
 * 否则会被认定为「经营外购即食食品」而非自制）→ 打包 → 配送到楼。
 * 沿用「集散中心」这个名字是因为原型 / PRD / 既有页面都用它指代「餐从哪儿发」，
 * 术语统一（→「加工场所」）登记为**文案级待办**，本次只做语义修正。
 *
 * 四条随之而来的口径：
 *   · `supplierId` **已停用**（见下方列注释）—— 场所属 ABox 自己，不归属供应商；
 *   · 本表**不是应付对象**（`ab_supplier_share.payee_type='distribution_center'` 已冻结）；
 *     场地摊销 / 打包人工 / 配送费都是 ABox **自身履约成本**，不出付款单；
 *   · `riceFee` / `packFee` 科目保留，仅作成本登记（**默认 0 = 未登记，不是免费**）；
 *   · 场地必须是 ABox **自有持证场所**（证照地址 = 线上店铺地址 = 实际出餐地址）。
 *
 * ⚠️ C9 修订（2026-09-15）→ 自营口径（2026-09-16）：不再向任何合作方支付场地费 / 打包费。
 */
@Entity('ab_distribution_center')
export class DistributionCenter {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, comment: '集散中心名，如"集散中心 1（国贸片）"' })
  name!: string;

  /**
   * ⚠️ **自营下已停用（历史字段 · 2026-09-16 路线裁定）**
   *
   * 「集散中心 = 某供应商的场地」建立在「供应商入驻 + 供应商自己承担集散」之上；
   * 单主体自营 + 半成品供应链后，集散中心即 **ABox 自有加工 / 出餐场所**，
   * 与任何合作供应商都没有归属关系 —— 故本列语义失效。
   *
   * **保留本列**只为兼容自营前的历史行（种子 / 演示数据）与 `idx_dc_supplier` 索引，
   * **任何新逻辑不得读取或写入**：D30/D31 已停收该字段、D29 不再按它筛选或展示。
   *
   * 判据是「这一列还有没有业务含义」：没有就不是「一个可空字段」，而是**历史字段**。
   * 留着读它，会让「某场所属于某供应商」这个自营下不成立的关系悄悄复活；
   * 而删列要动 migration + 索引，代价大于收益（同 `ab_supplier.share_rate` 的处理）。
   */
  @Index('idx_dc_supplier')
  @Column({
    name: 'supplier_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '⚠️ 已停用（自营前历史字段）：加工场所属 ABox 自有，不归属供应商',
  })
  supplierId?: number | null;

  @Column({ type: 'varchar', length: 256, comment: '场地地址（ABox 自有持证场所）' })
  address!: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 32, nullable: true })
  contactName?: string | null;

  @Column({ name: 'contact_phone', type: 'varchar', length: 20, nullable: true })
  contactPhone?: string | null;

  @Column({
    name: 'rice_fee',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 8,
    scale: 2,
    default: 0,
    comment: '米饭费用（C9 修订：默认并入供应商供价，本项默认 0，按实际登记）',
  })
  riceFee!: string;

  @Column({
    name: 'pack_fee',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 8,
    scale: 2,
    default: 0,
    comment: '打包费用（C9 修订：改由平台兼职打包承担，本项默认 0，按实际登记）',
  })
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
