import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';

import { bigintTransformer, moneyTransformer, PkColumn } from './transformers';

/**
 * ab_withdraw 提现申请单
 *
 * ⚠️ **2026-09-15 补入（数据层 P0 缺口）**：L12/L13（团长提现申请 / 提现记录）
 *    与 D45/D46（后台提现审批）都要求一张「提现申请单」，但 ER v2.1 与实体层
 *    均无该表 —— 余额流水（`ab_balance_log`）只能记发生额，无法承载
 *    「待审批」这一**中间态**，M2 验收标准 4（提现申请可提交并进入待审批）无法落地。
 *    故按 C11 出款口径补齐本表，并同步 ER v2.1 / 接口规范 / 评审意见。
 *
 * 口径：
 *   · 申请即**冻结**可用余额（`WITHDRAW_FROZEN_STATUS`），驳回/失败原路解冻
 *   · 到账金额 = 申请金额 − 平台代扣个税（C11 灵活用工代扣代缴，团长拿到手金额）
 *   · 一期 `payout_channel = FLEX_MANUAL`（人工登记回单号），二期切 `FLEX_API`
 *   · 供应商 / 集散的应付**不走本表** —— 那条线是人工对公转账（C10），
 *     只用 `ab_supplier_share` 记应付 + 回单号，不接支付通道
 */
@Entity('ab_withdraw')
export class Withdraw {
  @PkColumn()
  id!: number;

  @Index('uk_withdraw_no', { unique: true })
  @Column({ name: 'withdraw_no', type: 'varchar', length: 32, comment: '提现单号 WD+yyyyMMdd+8位' })
  withdrawNo!: string;

  @Index('idx_withdraw_leader_time')
  @Column({ name: 'leader_id', type: 'bigint', transformer: bigintTransformer })
  leaderId!: number;

  @Column({
    name: 'user_id',
    type: 'bigint',
    transformer: bigintTransformer,
    comment: 'ab_user.id（余额账户口径）',
  })
  userId!: number;

  @Column({
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    comment: '申请金额（元）',
  })
  amount!: string;

  @Column({
    name: 'tax_withheld_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 10,
    scale: 2,
    default: 0,
    comment: '平台代扣个税（C11）',
  })
  taxWithheldAmount!: string;

  @Column({
    name: 'actual_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
    comment: '实际到账 = amount − tax_withheld_amount',
  })
  actualAmount!: string;

  /** ---- C11 出款通道 ---- */
  @Column({
    name: 'payout_channel',
    type: 'varchar',
    length: 16,
    default: 'FLEX_MANUAL',
    comment: 'FLEX_MANUAL 灵活用工人工 / FLEX_API 灵活用工 API',
  })
  payoutChannel!: string;

  @Column({
    name: 'payout_batch_no',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '出款批次号（人工登记）',
  })
  payoutBatchNo?: string | null;

  /** ---- 收款信息（脱敏存储） ---- */
  @Column({ name: 'receive_type', type: 'varchar', length: 16, default: 'bank' })
  receiveType!: string;

  @Column({
    name: 'receive_account',
    type: 'varchar',
    length: 64,
    comment: '收款账号（脱敏存储）',
  })
  receiveAccount!: string;

  @Column({ name: 'receive_name', type: 'varchar', length: 32, comment: '收款人姓名' })
  receiveName!: string;

  @Index('idx_withdraw_status')
  @Column({
    type: 'varchar',
    length: 16,
    default: 'pending',
    comment:
      'pending待审批/approved已批准/paying打款中/success已到账/rejected已驳回/failed打款失败',
  })
  status!: string;

  /** ---- 审批（后台 · D46） ---- */
  @Column({
    name: 'auditor_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '审批人（ab_admin_user.id）',
  })
  auditorId?: number | null;

  @Column({ name: 'audit_at', type: 'datetime', precision: 3, nullable: true })
  auditAt?: Date | null;

  @Column({ name: 'audit_remark', type: 'varchar', length: 256, nullable: true })
  auditRemark?: string | null;

  @Column({ name: 'fail_reason', type: 'varchar', length: 256, nullable: true })
  failReason?: string | null;

  @Column({
    name: 'paid_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '实际到账时间',
  })
  paidAt?: Date | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
