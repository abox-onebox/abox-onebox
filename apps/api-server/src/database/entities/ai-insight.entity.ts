import { Column, CreateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, PkColumn } from './transformers';

/**
 * ab_ai_insight · AI 产出留档（第 37 张表 · 2026-11-04）
 *
 * ## 为什么要有这张表
 *
 * 到 2026-11 为止，企微助手已经有 **15 个 AI 生成能力**（选品提案 / 招募提案 /
 * 发券策略 / 需求预测 / 增长实验 / 风控对账 / 流失召回 / 团长健康 / 经营健康分 /
 * 社群排期 / 退款根因 / 开团草稿 / 运营日报 / 招募页 / 提审包），外加每日 09:00 自动编排。
 * 它们**生成完就消失了**：
 * - 企微会话 `SESSION_TTL_MS = 10 分钟`，过期后连上下文都没了，更别说 AI 的结论；
 * - 每日编排推完只剩一行日志「已推送摘要给 xxx（N 字）」——**N 字是什么，事后无从查**；
 * - 后台从来没有 AI 结果页（`admin-web` 里与本表相关的只有「开团草稿」那一页）。
 *
 * 直接后果是三个问题一个都答不上来：
 * 1. 「上周 AI 说该上哪几个品」→ 只能重新生成一遍，而**同样的数据再跑一次结论会漂**
 *    （LLM 非确定），所以「上次那个说法」永久丢失；
 * 2. 「AI 建议了 12 次，我们采纳了几次」→ 无记录，AI 化的价值无法评估；
 * 3. 「这条建议准不准」→ 没有台账就没有回看，等于每次都从零开始猜。
 *
 * ⇒ 本表把「AI 说了什么」变成**可检索、可标记、可复盘**的记录。它不改变任何
 * 生成逻辑，只增加一次写入（纯增量）——15 个节点共用同一张表。
 *
 * ## 为什么不按节点各建一张表
 * 15 个节点的输出形态一致（一段给人看的文本 + 入参 + 耗时），差异只在 `kind`。
 * 各建一张表会让「看最近 AI 都说了什么」变成 15 次 UNION，而收益只有字段级微调。
 *
 * ## `content` 存全文，不存摘要
 * 摘要正是**丢掉关键信息**的那个环节：2026-11-04 就踩过——服务层 `slice(0,5)` 把
 * 「AI 判定零食提案与正餐模板无匹配」这条唯一有信息量的结论截掉了，页面显示成
 * 「AI 未给」，看起来像 AI 没干活。全文入库 + 前端按需展开，才不会被二次截断。
 *
 * ## `payload_json` 是为「下一批」留的钩子
 * 本批只做「看 + 标记采纳/忽略」。但 AI 建议 → 一键执行（像开团草稿那样
 * 生成草稿→确认写库）是明确方向，故预留 `payload_json` 存**结构化动作**
 * （如 `{action:'assign_meal', rows:[...]}`）。将来补执行端点时不必改表。
 * 现在一律写 `null`，不做半成品抽象。
 *
 * ## 与 `ab_operation_log` 的分工
 * 操作日志记「谁做了什么改库动作」，本表记「AI 判断了什么」。二者正交：
 * AI 生成**不改业务数据**，故不进操作日志；人采纳建议后的实际动作由各自业务表
 * 的操作日志负责。混在一起会让「AI 到底动了什么」无法单独回答（答案是「什么都没动」）。
 */
@Entity('ab_ai_insight')
@Index('idx_ai_insight_kind_created', ['kind', 'createdAt'])
@Index('idx_ai_insight_status_created', ['status', 'createdAt'])
export class AiInsight {
  @PkColumn()
  id!: number;

  /**
   * 节点标识（与脚本/方法是同一个词，便于反查）：
   * `daily-report` / `meal-proposal` / `recruit-proposal` / `coupon-strategy` /
   * `demand-forecast` / `growth-experiment` / `risk-recon` / `churn-recall` /
   * `leader-health` / `health-score` / `community-plan` / `refund-cluster` /
   * `launch-draft` / `campaign` / `launch-pack` / `daily-orchestrate`
   */
  @Column({ type: 'varchar', length: 64, comment: 'AI 节点标识（与生成脚本同名）' })
  kind!: string;

  /** 给人看的一句话标题（列表页只显示这个，点开看全文） */
  @Column({ type: 'varchar', length: 255, comment: '列表展示用的一句话标题' })
  title!: string;

  /**
   * AI 输出全文（markdown 原文，不做任何截断）。
   * ⚠️ 用 `TEXT` 而非 `MEDIUMTEXT`：`schema:parity.ts` 的 `TYPE_ALIAS`
   *    **没有登记 MEDIUMTEXT/LONGTEXT**，写了会直接抛「未登记的类型」。
   *    而 TypeORM 在 sqlite 侧把 `text` 建成 TEXT，两侧归一。
   */
  @Column({ type: 'text', comment: 'AI 输出全文（markdown，不截断）' })
  content!: string;

  /**
   * 结构化附加信息（JSON 文本）：`{ mode, elapsedMs, input, payload }`
   * - `mode`：`llm` = 真调模型 / `rules` = 降级到规则兜底（**必须记**：
   *   两者可信度差一个量级，事后复盘时「这条是占位模式產出的」是关键前提）
   * - `elapsedMs`：耗时（判断「卡住了」还是「正常慢」）
   * - `input`：入参摘要（日期档位 / 楼群数 / 是否指定范围），便于复现
   * - `payload`：留待「一键执行」批次的占位，本批恒为 null
   */
  @Column({
    name: 'meta_json',
    type: 'text',
    nullable: true,
    comment: 'JSON：mode/耗时/入参摘要/payload',
  })
  metaJson?: string | null;

  /**
   * 触发来源：
   * - `chat`：同事在企微说一句触发
   * - `admin`：后台页面点按钮触发
   * - `cron`：每日 09:00 自动编排（**这条最重要**：无人值守的产出也要能回看）
   */
  @Column({
    type: 'varchar',
    length: 16,
    default: 'chat',
    comment: '触发来源：chat/admin/cron',
  })
  source!: string;

  /**
   * 处置状态：`open` 待看 / `adopted` 采纳 / `dismissed` 忽略
   *
   * ⚠️ 只有整条建议一个状态，不做「逐条采纳」。因为 AI 输出是 markdown 文本，
   * 没有稳定的条目边界，硬切会切错（且切出来的 id 无处安放）。等 `payload_json`
   * 有结构化条目后，采纳粒度再细化——**先做能对的，不做看着细的**。
   */
  @Column({
    type: 'varchar',
    length: 16,
    default: 'open',
    comment: 'open 待看 / adopted 已采纳 / dismissed 已忽略',
  })
  status!: string;

  /** 生成者（`ab_admin_user.id`）；cron 无人值守时为 NULL */
  @Column({
    name: 'actor_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '生成者 admin_user.id（cron 为 NULL）',
  })
  actorId?: number | null;

  /** 生成者姓名快照（账号改名后仍能看懂当时是谁触发的） */
  @Column({ name: 'actor_name', type: 'varchar', length: 64, nullable: true })
  actorName?: string | null;

  /** 标记采纳/忽略的时刻；`status='open'` 时为 NULL */
  @Column({ name: 'decided_at', type: 'datetime', precision: 3, nullable: true })
  decidedAt?: Date | null;

  /** 标记人姓名快照 */
  @Column({ name: 'decided_by', type: 'varchar', length: 64, nullable: true })
  decidedBy?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}
