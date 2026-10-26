import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index, VersionColumn } from 'typeorm';
import { bigintTransformer, PkColumn } from './transformers';

/** ab_admin_user 后台账号（运营后台 + 供应商后台，按 role 过滤菜单） */
@Entity('ab_admin_user')
export class AdminUser {
  @PkColumn()
  id!: number;

  @Index('uk_admin_username', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  username!: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 128 })
  passwordHash!: string;

  @Column({ name: 'real_name', type: 'varchar', length: 32, nullable: true })
  realName?: string | null;

  @Column({
    type: 'varchar',
    length: 32,
    default: 'operator',
    comment: 'super_admin/admin/operator/finance/viewer/supplier',
  })
  role!: string;

  /** P2 强制首登改密标记（1=必须改密后才能操作；改密接口清除为 0） */
  @Column({ name: 'must_change_password', type: 'tinyint', default: 0, nullable: false })
  mustChangePassword?: number;

  /** 供应商账号绑定 ab_supplier.id（role=supplier 时使用） */
  @Column({ name: 'supplier_id', type: 'bigint', transformer: bigintTransformer, nullable: true })
  supplierId?: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone?: string | null;

  @Column({ type: 'tinyint', default: 1 })
  status!: number;

  @Column({ name: 'last_login_at', type: 'datetime', precision: 3, nullable: true })
  lastLoginAt?: Date | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** ab_operation_log 操作日志（含 snapshot 变更前后值 · P2-1） */
@Entity('ab_operation_log')
@Index('idx_oplog_user_time', ['adminUserId', 'createdAt'])
@Index('idx_oplog_module_action', ['module', 'action'])
export class OperationLog {
  @PkColumn()
  id!: number;

  @Column({ name: 'admin_user_id', type: 'bigint', transformer: bigintTransformer, nullable: true })
  adminUserId?: number | null;

  @Column({ type: 'varchar', length: 32, comment: '模块名' })
  module!: string;

  @Column({ type: 'varchar', length: 32, comment: '操作类型' })
  action!: string;

  @Column({ name: 'target_id', type: 'varchar', length: 64, nullable: true, comment: '对象ID' })
  targetId?: string | null;

  @Column({ name: 'request_ip', type: 'varchar', length: 64, nullable: true })
  requestIp?: string | null;

  @Column({ name: 'request_data', type: 'json', nullable: true })
  requestData?: unknown;

  @Column({ name: 'response_data', type: 'json', nullable: true })
  responseData?: unknown;

  @Column({ type: 'json', nullable: true, comment: '变更前后值快照（P2-1，审计回放）' })
  snapshot?: unknown;

  // 知识助手「替操作」审计三字段（B3 · 2026-10-18）：仅当请求带 X-KB-* 头时由拦截器填充，普通后台操作恒为 null
  @Column({
    name: 'kb_operator',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '知识助手自报操作人（X-KB-Operator）',
  })
  kbOperator?: string | null;

  @Column({
    name: 'kb_nl_intent',
    type: 'text',
    nullable: true,
    comment: '知识助手自然语言指令（X-KB-NL）',
  })
  kbNlIntent?: string | null;

  @Column({
    name: 'kb_op_block',
    type: 'text',
    nullable: true,
    comment: '知识助手生成的操作块JSON（X-KB-OpBlock）',
  })
  kbOpBlock?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}

/** ab_config 系统配置字典（业务参数运行期可调，权威来源见 docs/） */
@Entity('ab_config')
export class SysConfig {
  @PkColumn()
  id!: number;

  @Index('uk_config_key', { unique: true })
  @Column({ name: 'config_key', type: 'varchar', length: 64 })
  configKey!: string;

  @Column({ name: 'config_value', type: 'text' })
  configValue!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  description?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** ab_message 消息推送日志（订阅消息，保留 90 天） */
@Entity('ab_message')
@Index('idx_msg_user_time', ['userId', 'createdAt'])
export class Message {
  @PkColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer, nullable: true })
  userId?: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  openid?: string | null;

  @Column({ name: 'template_id', type: 'varchar', length: 64, comment: '微信订阅消息模板ID' })
  templateId!: string;

  @Column({ type: 'json' })
  payload!: unknown;

  @Index('idx_msg_status')
  @Column({ type: 'varchar', length: 16, default: 'pending', comment: 'pending/success/fail' })
  status!: string;

  @Column({ name: 'error_msg', type: 'varchar', length: 256, nullable: true })
  errorMsg?: string | null;

  @Column({ name: 'sent_at', type: 'datetime', precision: 3, nullable: true })
  sentAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}

/**
 * ab_message_template 通知模板（M3-12 · D59/D60 载体 · 第 27 张表）
 *
 * ## 为什么单独一张表，而不是塞进 `ab_config`
 *
 * `CONFIG_SPECS` 的类型系统是**扁平标量**（money / percent / int / text / time）——
 * 它撑得住「最低提现金额」，撑不住「一个场景 + 多渠道 + 变量白名单 + 启用闸门」。
 * 硬塞进去只有两条路：把 JSON 塞进 `config_value`（则 D58 的白名单与单点校验失效，
 * 校验逻辑四散 → 立刻多出第二个真相），或把模板拆成十几个扁平键（则「一个场景」
 * 这个整体概念在库里不复存在，`ab_message.template_id` 也无从对应）。
 *
 * ## ⭐ 本表只存「可编辑部分」，场景定义留在代码里
 *
 * `scene` / 渠道 / 触发时机 / 变量白名单 / 是否必推 —— 全部是**代码事实**
 * （见 `modules/admin/template/message-template.specs.ts`），**不落库**。
 * 落了库就会漂移成「库里写着走微信群、代码只发订阅消息」这种无法自证的矛盾。
 *
 * ## ⭐ 必须直说的事实：微信订阅消息的文案**不由本表决定**
 *
 * 微信订阅消息的内容格式在**微信公众平台**按模板定义（`thing1` / `time2` 这类
 * keyword），服务端只能往 `data` 里填值。所以后台改文案**改不了用户看到的推送**。
 * 本表三个字段的真实效力：
 *   · `enabled`            总开关 —— **真生效**（代码据此决定投不投递）
 *   · `wechatTemplateId`   微信侧模板 ID —— **真生效**（发送时传给微信）
 *   · `groupContent`       微信群人工通知文案 —— **存档用途**（一期由人工复制粘贴发群）
 *
 * 若把 `groupContent` 做成「改了用户就会看到新文案」的承诺，就是本项目反复栽过的
 * 那一类错（见《接口规范》§6.7 的 `wiring` 三态）：**给了输入框，却没接上线**。
 */
@Entity('ab_message_template')
export class MessageTemplate {
  @PkColumn()
  id!: number;

  /**
   * 场景键 —— 取值必须来自 `MESSAGE_TEMPLATE_SPECS`（D60 **不可改**）
   *
   * 唯一索引同时是**防重闸门**：同一场景两行会让「退款通知用哪一行」变成随机。
   */
  @Index('uk_msg_tpl_scene', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  scene!: string;

  /** 总开关：1 启用 / 0 关闭（**真生效**） */
  @Column({ type: 'tinyint', default: 0 })
  enabled!: number;

  /** 微信订阅消息模板 ID（微信公众平台创建；**真生效**） */
  @Column({ name: 'wechat_template_id', type: 'varchar', length: 64, nullable: true })
  wechatTemplateId?: string | null;

  /** 微信群人工通知文案（含 `{{变量}}`，变量须在该场景白名单内；**存档用途**） */
  @Column({ name: 'group_content', type: 'text', nullable: true })
  groupContent?: string | null;

  /** 最近修改人（`ab_admin_user.id`） */
  @Column({ name: 'updated_by', type: 'bigint', transformer: bigintTransformer, nullable: true })
  updatedBy?: number | null;

  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/**
 * ab_operation_request 替操作「高危审批」申请单（阶段 3 · 2026-10-18）
 *
 * ## 与 ab_operation_log 的关系
 * 本表是「申请单」线（待审 → 已执行/已驳回），oplog 是「每一次写操作的审计行」。
 * 审批通过后**执行**那一步仍会写一条 ab_operation_log（B3 三字段由服务端从本单回填，
 * 见 OperationRequestExecutor），二者靠 snapshot.request_id 关联（不额外加列）。
 *
 * ## 状态机（两步执行：approve 仅置 approved，execute 才调原目标接口）
 *   pending → approved → executed
 *   pending → rejected（终态）；executed / rejected 不可再改。
 *
 * ## 安全边界
 * 全部 /admin 作用域，复用 AdminGuard + @Roles；执行复用原目标接口（不另写业务）。
 */
@Entity('ab_operation_request')
@Index('idx_opreq_status', ['status'])
@Index('idx_opreq_submitter', ['submitterAdminId'])
export class OperationRequest {
  @PkColumn()
  id!: number;

  @Column({ name: 'op_code', type: 'varchar', length: 48, comment: 'OPS_CATALOG 的 op 代码' })
  opCode!: string;

  @Column({ name: 'op_label', type: 'varchar', length: 96, comment: '操作中文名（冗余存）' })
  opLabel!: string;

  /** 危险档：本期仅 admin 进审批流 */
  @Column({ type: 'varchar', length: 16, default: 'admin', comment: 'operator/admin' })
  risk!: string;

  @Column({ type: 'json', comment: '校验后的真实参数（执行时即作为目标接口 body）' })
  params!: unknown;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'pending',
    comment: 'pending/approved/rejected/executed',
  })
  status!: string;

  /** 自报操作人（来自知识助手 X-KB-Operator）；后台手动建单时为空 */
  @Column({ name: 'submitter_kb', type: 'varchar', length: 64, nullable: true })
  submitterKb?: string | null;

  /** 后台手动建单 / 代为提交人的 admin_user_id */
  @Column({
    name: 'submitter_admin_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
  })
  submitterAdminId?: number | null;

  @Column({
    name: 'submitter_nl',
    type: 'text',
    nullable: true,
    comment: '自然语言原文（X-KB-NL）',
  })
  submitterNl?: string | null;

  @Column({
    name: 'submitter_op_block',
    type: 'json',
    nullable: true,
    comment: '操作块 JSON（X-KB-OpBlock 原文）',
  })
  submitterOpBlock?: unknown;

  @Column({ name: 'approver_id', type: 'bigint', transformer: bigintTransformer, nullable: true })
  approverId?: number | null;

  @Column({ name: 'approved_at', type: 'datetime', precision: 3, nullable: true })
  approvedAt?: Date | null;

  @Column({ name: 'reject_reason', type: 'varchar', length: 255, nullable: true })
  rejectReason?: string | null;

  /** 执行回执（成功后回填目标接口返回值；含 request_id 关联网页） */
  @Column({ type: 'json', nullable: true })
  snapshot?: unknown;

  @Column({ name: 'executed_at', type: 'datetime', precision: 3, nullable: true })
  executedAt?: Date | null;

  @Column({ name: 'recalled_at', type: 'datetime', precision: 3, nullable: true })
  recalledAt?: Date | null;

  @Column({ name: 'recalled_by', type: 'bigint', transformer: bigintTransformer, nullable: true })
  recalledBy?: number | null;

  @Column({ name: 'recall_reason', type: 'varchar', length: 255, nullable: true })
  recallReason?: string | null;

  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/**
 * ab_op_blocklist 知识助手禁止清单（P1-c · 2026-10-19）
 *
 * 管理员在后台把某些 op 列入禁止，助手（KB）无论直执行还是提交审批都被服务端拦截。
 * 与前端 localStorage 自解禁无关，是服务端权威闸。
 */
@Entity('ab_op_blocklist')
@Index('uk_op_block_op', ['opCode'], { unique: true })
export class OpBlocklist {
  @PkColumn()
  id!: number;

  @Column({ name: 'op_code', type: 'varchar', length: 48, comment: 'OPS_CATALOG 的 op 代码' })
  opCode!: string;

  @Column({
    name: 'note',
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: '禁止原因（管理员填写）',
  })
  note?: string | null;

  @Column({
    name: 'created_by',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '列入人 admin_user_id',
  })
  createdBy?: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/**
 * ab_page_track 页面停留埋点（U15 · 2026-10-20 实装 · 第 30 张表）
 *
 * ## 口径：匿名聚合（刻意不绑身份）
 * 只记「哪个页面、进来/离开时刻、停了多久」，**不采集 openid / 用户身份**。
 * 端上埋点模块（`apps/miniprogram/src/utils/track.ts`）不发身份字段；后端 DTO
 * （`modules/track/dto/track.dto.ts`）在 whitelist + forbidNonWhitelisted 的
 * ValidationPipe 下**不声明任何身份字段** —— 即便有人构造带 openid 的报文也会被
 * 整体拒绝（fail-closed，而不是「收下但不用」）。日后若要做「绑定用户」的个人
 * 行为分析，须单独立项：加字段 + 隐私指引披露 + 用户同意机制，三件一起。
 *
 * ## 为什么 enter/leave 是 BIGINT 毫秒而不是 DATETIME
 * 停留时长 = 端上 `Date.now()` 差值，与**服务端**时钟无关；客户端时钟偏移只
 * 影响 enter/leave 的绝对值，不影响 `duration_ms` 的自洽性。服务端自己的时钟
 * 只认 `created_at`（落库时刻，DATETIME(3)）。若用 DATETIME 存进出时刻，跨时区
 * 与时钟偏移会把「时长」变成一个需要二次解释的值。
 *
 * ## 只增表
 * 无 version / updated_at —— 埋点行落库即终态，写上反而暗示「会改」（同
 * `ab_dish_rating` 的约定）。
 */
@Entity('ab_page_track')
@Index('idx_page_track_page_created', ['page', 'createdAt'])
export class PageTrack {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 128, comment: '页面路由路径（如 pages/index/index）' })
  page!: string;

  @Column({
    name: 'page_query',
    type: 'varchar',
    length: 256,
    nullable: true,
    comment: '页面 query 序列化（如 buildingId=3；无 query 为 NULL）',
  })
  pageQuery?: string | null;

  @Column({
    name: 'enter_at',
    type: 'bigint',
    transformer: bigintTransformer,
    comment: '进入时刻（端上 Date.now() 毫秒）',
  })
  enterAt!: number;

  @Column({
    name: 'leave_at',
    type: 'bigint',
    transformer: bigintTransformer,
    comment: '离开时刻（端上 Date.now() 毫秒）',
  })
  leaveAt!: number;

  @Column({ name: 'duration_ms', type: 'int', comment: '停留毫秒（端上计算，封顶 24h）' })
  durationMs!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}

/**
 * ab_sales_pause 全局停售区间（W1 · ADR-N1N2W1 · 第 34 张表）
 *
 * ## ⭐ 为什么是独立表而不是 `ab_config` 的一个键
 *
 * `BizConfigService` 有 **60 秒进程内缓存**，而「一键停售」的语义就是**立刻** ——
 * 走配置路线会有最长 60 秒的放单窗口，且**无任何报错**：运营点下停售、页面显示成功，
 * 这一分钟内用户照常下单成功。这正是本项目反复栽的那一类错（给了输入框，却没接上线）。
 * （生产当前只有 1 个 api 容器：`docker-compose.prod.yml:88–96`，无 replicas，
 *   故「立刻」在本部署形态下是可达的 —— 多副本时须另行评估。）
 *
 * ## ⭐ 生效判定 = 「区间覆盖该出餐日 ∧ resumed_at IS NULL」
 *
 * 判定是**点查**（`meal_date_from <= :d AND meal_date_to >= :d`），两端**含首尾**。
 * 刻意**允许重叠区间**：「停售明天」+「停售下周一」是两条独立记录，各自独立恢复 ——
 * 运营先恢复其中一条，不该连带把另一条也解了。故**无唯一约束**。
 * 允许 `from == to`（「停售明日」就是这个形态），不做第二套开关。
 *
 * ## ⚠️ 恢复是「写 `resumed_at`」，不是删行
 *
 * 停售区间是**审计事实**（谁在什么时候停了哪几天、又因为什么停的）。删行会让
 * 「上个月到底停过哪几天」事后查无此事，故只打恢复标记（+ 恢复人），行永久保留。
 *
 * ## ⚠️ 多词列必须显式写 `name:`
 *
 * 本仓 TypeORM 默认命名策略**不做** camelCase→snake_case 转换（见 `OpBlocklist` 同文件写法）。
 * 漏写会在生产建出 `mealDateFrom` 而迁移里是 `meal_date_from`，`schema:parity` 会**同时**
 * 报「迁移缺列」+「迁移多出列」—— 既造噪声又掩盖真问题。
 *
 * ## 无 version 列
 *
 * append-only + 单行 `resumed_at` 更新，不是并发争抢资源，不加乐观锁。
 */
@Entity('ab_sales_pause')
@Index('idx_sales_pause_range', ['mealDateFrom', 'mealDateTo'])
export class SalesPause {
  @PkColumn()
  id!: number;

  @Column({ name: 'meal_date_from', type: 'date', comment: '停售起始出餐日（含）' })
  mealDateFrom!: string;

  @Column({ name: 'meal_date_to', type: 'date', comment: '停售截止出餐日（含）' })
  mealDateTo!: string;

  @Column({ type: 'varchar', length: 255, comment: '停售原因（后台必填，随用户端文案下发）' })
  reason!: string;

  @Column({ name: 'created_by', type: 'bigint', transformer: bigintTransformer, nullable: true })
  createdBy?: number | null;

  @Column({
    name: 'resumed_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '恢复时刻（NULL = 仍生效）',
  })
  resumedAt?: Date | null;

  @Column({ name: 'resumed_by', type: 'bigint', transformer: bigintTransformer, nullable: true })
  resumedBy?: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
