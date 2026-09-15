import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, moneyTransformer, rateTransformer, PkColumn } from './transformers';

/**
 * ab_team_leader 团长表
 *   C2 —— 4 级佣金 8%/9%/10%/12%（见习/正式/金牌/首席），默认见习 8%
 *   C3 —— 提交申请即生效（agreed_at 勾选协议，无人工审核）
 *   C11 —— 佣金由灵活用工平台代发代扣，实际打款与代扣税额见 ab_commission
 *
 * 字段依据：《ER v2.1》§4.2 + 《表结构评审意见 v1.0》P0-1（补 level / month_orders /
 * invited_formal_count / last_order_at，费率默认改 0.0800）
 */
@Entity('ab_team_leader')
export class TeamLeader {
  @PkColumn()
  id!: number;

  @Index('uk_team_leader_user', { unique: true })
  @Column({
    name: 'user_id',
    type: 'bigint',
    transformer: bigintTransformer,
    comment: '关联 ab_user.id',
  })
  userId!: number;

  @Index('idx_team_leader_building')
  @Column({ name: 'building_id', type: 'bigint', transformer: bigintTransformer })
  buildingId!: number;

  @Column({ type: 'varchar', length: 20, comment: '必填（脱敏存储）' })
  phone!: string;

  @Column({ name: 'real_name', type: 'varchar', length: 32 })
  realName!: string;

  /** 等级：trainee 见习 / formal 正式 / gold 金牌 / chief 首席（C2） */
  @Index('idx_team_leader_level_status')
  @Column({ type: 'varchar', length: 16, default: 'trainee' })
  level!: string;

  @Column({ name: 'level_updated_at', type: 'datetime', precision: 3, nullable: true })
  levelUpdatedAt?: Date | null;

  @Column({
    name: 'commission_rate',
    type: 'decimal',
    transformer: rateTransformer,
    precision: 5,
    scale: 4,
    default: 0.08,
    comment: '当前费率，随 level 联动（0.08/0.09/0.10/0.12）',
  })
  commissionRate!: string;

  @Column({ name: 'total_orders', type: 'int', default: 0 })
  totalOrders!: number;

  @Column({
    name: 'month_orders',
    type: 'int',
    default: 0,
    comment: '当月完成份数（C2 月单，每日跑批刷新）',
  })
  monthOrders!: number;

  @Column({
    name: 'invited_formal_count',
    type: 'int',
    default: 0,
    comment: '累计介绍并已转正团长数（C2 第二条件，由 ab_leader_invite 汇总）',
  })
  invitedFormalCount!: number;

  @Column({
    name: 'total_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
  })
  totalAmount!: string;

  @Column({
    name: 'total_commission',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
  })
  totalCommission!: string;

  @Column({
    name: 'withdrawn_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
  })
  withdrawnAmount!: string;

  @Column({
    name: 'pending_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
  })
  pendingAmount!: string;

  @Column({
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
    comment: '可用余额',
  })
  balance!: string;

  @Column({ type: 'tinyint', default: 1, comment: '1在职 2停职' })
  status!: number;

  @Column({
    name: 'agreed_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '勾选同意《团长合作协议》时间（C3：提交即生效，无人工审核）',
  })
  agreedAt?: Date | null;

  @Column({ name: 'agree_version', type: 'varchar', length: 16, nullable: true })
  agreeVersion?: string | null;

  @Index('idx_team_leader_last_order')
  @Column({
    name: 'last_order_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '最近促成订单时间（C2：见习 30 天未促单自动失效）',
  })
  lastOrderAt?: Date | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'datetime', precision: 3, nullable: true })
  deletedAt?: Date | null;
}

/**
 * ab_leader_invite 团长推荐关系（C2 晋级审计）
 * 依据：《表结构评审意见 v1.0》P0-4（第 24 张表）
 *   一个用户只绑定一个邀请人（uk_invite_invitee）；
 *   inviter_leader_id 可空以支持 C3 自荐申请；
 *   is_formal 为冗余位，避免高频 JOIN ab_team_leader 判等级。
 */
@Entity('ab_leader_invite')
export class LeaderInvite {
  @PkColumn()
  id!: number;

  @Index('idx_invite_inviter')
  @Column({
    name: 'inviter_leader_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '邀请人团长 id；自荐申请为 NULL',
  })
  inviterLeaderId?: number | null;

  @Index('uk_invite_invitee', { unique: true })
  @Column({
    name: 'invitee_user_id',
    type: 'bigint',
    transformer: bigintTransformer,
    comment: '被邀请用户 id（唯一）',
  })
  inviteeUserId!: number;

  @Column({
    name: 'invitee_leader_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '被邀请人转任团长后的 id',
  })
  inviteeLeaderId?: number | null;

  @Column({ name: 'invite_code', type: 'varchar', length: 32, nullable: true })
  inviteCode?: string | null;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'link',
    comment: 'link链接/qrcode小程序码/poster海报/self自荐',
  })
  channel!: string;

  @Column({ name: 'bind_at', type: 'datetime', precision: 3, comment: '绑定时间（注册时）' })
  bindAt!: Date;

  @Column({
    name: 'invitee_level',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: '被邀请人等级快照',
  })
  inviteeLevel?: string | null;

  @Column({
    name: 'is_formal',
    type: 'tinyint',
    default: 0,
    comment: '被邀请人是否已达正式及以上（C2 计数口径）',
  })
  isFormal!: number;

  @Index('idx_invite_formal_at')
  @Column({
    name: 'formal_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '被邀请人转正时间',
  })
  formalAt?: Date | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  remark?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
