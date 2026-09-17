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

  /**
   * 楼层（如 `12F`）
   *
   * 2026-09-15 裁定补回：楼层是**核心组织维度**（同一办公楼内按楼层分群，
   * 取餐/提醒/分发都按楼层聚合）。ER v2.1 曾随 `ab_user.floor` 一并删除属回退，
   * 现按《接口规范》U1 / U3 / L17 契约在 `ab_team_leader` 恢复该列。
   */
  @Column({ type: 'varchar', length: 32, nullable: true, comment: '楼层，如 12F' })
  floor?: string | null;

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

  /**
   * 累计佣金（**事实累计**，非余额）
   *
   * ⚠️ 与下面三列（`withdrawn_amount` / `pending_amount` / `balance`）**性质不同**：
   *    本列由 `CommissionService.creditCommissions()` 在**入账**时累加，是活的；
   *    那三列**从种子之后全仓没有任何写点**（M4-4 修复 · 《缺陷与陷阱》#69）。
   */
  @Column({
    name: 'total_commission',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
  })
  totalCommission!: string;

  /**
   * ⚠️ **历史字段（M4-4 起停用）· 列保留 · 新逻辑不读不写**
   *
   * 语义本应是「累计已提现」，但**全仓从未有过写点** —— 一次都没有。
   * 页面按它展示的「已提现」永远是种子值（示例数据里是 ¥575.86）或 0。
   *
   * 真源改为派生：`SUM(ab_withdraw.actual_amount WHERE status='success')`
   * （**到账口径** —— 平台代扣的个税没到团长手里，不能算进「已提现」），
   * 读取口统一走 `LeaderMoneyService.snapshotOf()`。
   *
   * ⚠️ 为什么**不留着它当快照继续写**：让每个资金写点都顺手更新一遍就是
   *    **第二份真相** —— 漏掉任一个写点（佣金入账 / 下单抵扣 / 退款回退 /
   *    D39 调账 / 提现冻结…）都会让它与真源悄悄分叉，而分叉的表现是
   *    「某个页面显示旧数字」，不报错、无告警。与 M4-0 的
   *    `ab_distribution_center.supplier_id` / `ab_supplier.type` 同一处理。
   */
  @Column({
    name: 'withdrawn_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
  })
  withdrawnAmount!: string;

  /**
   * ⚠️ **历史字段（M4-4 起停用）· 列保留 · 新逻辑不读不写**
   *
   * 语义本应是「待入账佣金」，同样**从未被写过** → 页面恒 0。
   * 真源改为派生：`SUM(ab_commission.amount WHERE status='pending' AND type='normal')`
   * （⭐ 必须排除 `type='reversal'` —— 那是退款冲销的**负额**行，
   * 一起累加会把「待入账」算小甚至算成负数）。
   */
  @Column({
    name: 'pending_amount',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
  })
  pendingAmount!: string;

  /**
   * ⚠️⚠️ **历史字段（M4-4 起停用）· 列保留 · 新逻辑不读不写**
   *
   * 列注释原写「可用余额」，但它**只在种子数据里被赋过值，全仓没有任何写点**
   * —— 于是登录 / 团长资料 / 退出三处出参展示的「余额」是**种子里写死的数字**
   * （示例数据里李明是 ¥575.86），而「余额明细」页走 L11（`ab_balance`）显示真值：
   * **同一个人在同一时刻看到两个不同的余额**，两边都不报错；
   * 他去提现时被 `50004 可提现余额不足` 挡下，而页面上明明写着有几百块。
   *
   * ⭐ **余额的唯一真源是 `ab_balance.balance`**（用户维度；用户与团长共用同一身份，
   *    佣金入账与下单抵扣是同一条余额链路）。所有读点统一走
   *    `LeaderMoneyService.accountOf() / snapshotOf()`（`common/services/leader-money.service.ts`）。
   *
   * 本列**不做迁移删除**（与 M4-0 的 `ab_distribution_center.supplier_id`、
   * `ab_supplier.type` 同一处理）：删列会让生产库的迁移与回滚风险陡增，
   * 而「列留着但没人读」不会产生任何错误的口径。
   * ⚠️ **不要再往这里写值** —— 那会让第二份真相复活。
   */
  @Column({
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 12,
    scale: 2,
    default: 0,
    comment: '[历史字段·已停用] 原「可用余额」；真源见 ab_balance（M4-4 #69）',
  })
  balance!: string;

  /**
   * ---- 收款方式（2026-09-15 补）----
   *
   * 为何必须落库：L12 提现的错误码 `40007 PAYOUT_NOT_BOUND`（未绑定收款方式）
   * 需要「绑定态」这一概念 —— 只有一张 `ab_withdraw` 提现单表无法表达
   * 「此人是否已绑卡」，首次提现将永远拿不到绑定入口而 40007 死锁。
   *
   * 口径：一期 `FLEX_MANUAL`（人工）下，本组字段是运营对公/对私转账的依据；
   *   二期接灵活用工 API 后，以平台侧绑卡为准，本组字段退化为**快照**。
   */
  @Column({
    name: 'payout_type',
    type: 'varchar',
    length: 16,
    nullable: true,
    comment: 'bank 银行卡 / alipay 支付宝',
  })
  payoutType?: string | null;

  @Column({
    name: 'payout_account',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '收款账号（脱敏存储）',
  })
  payoutAccount?: string | null;

  @Column({
    name: 'payout_name',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '收款人姓名',
  })
  payoutName?: string | null;

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
