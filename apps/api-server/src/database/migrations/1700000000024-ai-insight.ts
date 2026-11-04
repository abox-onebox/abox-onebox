import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 新建第 37 张表 `ab_ai_insight` · AI 产出留档（2026-11-04）
 *
 * ## 缺口本身
 *
 * 企微助手已有 15 个 AI 生成能力 + 每日 09:00 自动编排，但**产出不留档**：
 * - 会话 `SESSION_TTL_MS = 10 分钟`，过期后 AI 的结论即不可追；
 * - 每日编排推完只留一行 `已推送摘要给 xxx（N 字）` 日志，N 字是什么无从查；
 * - 后台没有任何 AI 结果页。
 *
 * 后果：**同一份数据再跑一次结论会漂**（LLM 非确定），所以「上次 AI 怎么说」永久丢失，
 * 「AI 建议采纳率」「建议准不准」两个问题都无法回答 —— AI 化无法迭代。
 *
 * ## 表设计要点
 * - `content` 用 `TEXT` 而非 `MEDIUMTEXT`：`schema-parity.ts` 的 `TYPE_ALIAS`
 *   **没有登记 MEDIUMTEXT/LONGTEXT**，写了会抛「未登记的类型」；且 sqlite 侧
 *   实体 `type:'text'` 建出 TEXT，两侧才归一。单份 AI 报告最长几 KB，64KB 足够。
 * - `meta_json` 存 JSON **文本**而不是 MySQL `JSON` 类型：与 `ab_sys_config.config_value`
 *   同口径（项目既有约定），避免 sqlite/MySQL 在 JSON 类型上的行为差异。
 * - **无外键**：既有约定 —— FK 只存在于文档，不进 DDL。
 * - **无 `version` 列**：本表是「生成即定稿 + 单次状态翻转」（open → adopted/dismissed），
 *   不是并发争抢资源。同一行被两人同时标记的后果是「后写的赢」，可接受（且 `decided_at`
 *   会覆盖，不会出现半更新状态）。
 * - **两个索引都是 `(枚举列, created_at)` 复合**：列表页的两种固定查法分别是
 *   「按节点看该节点的历史」与「看待办/已采纳」，单列索引会让 created_at 排序回表。
 *
 * ## ⚠️ 与实体逐列一致（schema:parity / index:parity 判据）
 * 实体在 `entities/ai-insight.entity.ts` 的 `AiInsight`：列名 / 类型 / 长度 / 精度
 * 须逐项一致；索引名与列序须逐名逐列一致。本表只由迁移在**生产**建出，
 * 本地 sqlite 由实体 synchronize 建出 —— 两侧不齐两道门禁同时转红。
 *
 * ## 幂等与可重入
 * `CREATE TABLE IF NOT EXISTS`（MySQL 8 天然幂等）；`down()` 对称 `DROP TABLE IF EXISTS`。
 */
const NEW_TABLE = `CREATE TABLE IF NOT EXISTS \`ab_ai_insight\` (
   \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
   \`kind\` VARCHAR(64) NOT NULL COMMENT 'AI 节点标识（与生成脚本同名）',
   \`title\` VARCHAR(255) NOT NULL COMMENT '列表展示用的一句话标题',
   \`content\` TEXT NOT NULL COMMENT 'AI 输出全文（markdown，不截断）',
   \`meta_json\` TEXT DEFAULT NULL COMMENT 'JSON：mode/耗时/入参摘要/payload',
   \`source\` VARCHAR(16) NOT NULL DEFAULT 'chat' COMMENT '触发来源：chat/admin/cron',
   \`status\` VARCHAR(16) NOT NULL DEFAULT 'open' COMMENT 'open 待看 / adopted 已采纳 / dismissed 已忽略',
   \`actor_id\` BIGINT UNSIGNED DEFAULT NULL COMMENT '生成者 admin_user.id（cron 为 NULL）',
   \`actor_name\` VARCHAR(64) DEFAULT NULL COMMENT '生成者姓名快照',
   \`decided_at\` DATETIME(3) DEFAULT NULL COMMENT '标记采纳/忽略的时刻（open 时为 NULL）',
   \`decided_by\` VARCHAR(64) DEFAULT NULL COMMENT '标记人姓名快照',
   \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   PRIMARY KEY (\`id\`),
   KEY \`idx_ai_insight_kind_created\` (\`kind\`,\`created_at\`),
   KEY \`idx_ai_insight_status_created\` (\`status\`,\`created_at\`)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 产出留档（15 个节点的结论可回看/可标记）'`;

export class AiInsight1700000000024 implements MigrationInterface {
  name = 'AiInsight1700000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(NEW_TABLE);
    console.log('   ↳ AiInsight：建表 ab_ai_insight（IF NOT EXISTS，重跑幂等）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `ab_ai_insight`');
  }
}
