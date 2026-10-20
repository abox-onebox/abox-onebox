import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * U15 页面停留埋点：新建第 30 张表 `ab_page_track`（只增表 · 2026-10-20）
 *
 * ## 这支迁移为什么存在
 * 「统计/监控用户在每个页面的停留情况」此前落在任何表里都没有 —— 系统里没有
 * 任何埋点基础设施（无统计 SDK、无 `wx.reportAnalytics`），而 `use-subscribe-message.ts`
 * 里「U15 上报一期未实装」正是这个缺口的既有预留。本表 + `modules/track` 端点补上它。
 *
 * ## 表设计要点（与实体 `PageTrack` 逐列一致 —— schema:parity / index:parity 判据）
 * - **匿名口径**：无 openid / user_id 列。端上不采、后端不存 —— 「不存」比
 *   「存了不用」更干净（数据不出现在任何导出、备份、日志里）。
 * - `enter_at` / `leave_at` BIGINT 毫秒（端上 `Date.now()`）：时长自洽，不受
 *   服务端时钟与客户端时钟偏移影响；服务端时钟只认 `created_at`。
 * - `idx_page_track_page_created (page, created_at)`：后台聚合的口径
 *   （`GROUP BY page` + 按 `created_at` 切区间）。
 * - 只增表：无 version / updated_at（埋点行落库即终态）。
 *
 * ## 幂等与可重入
 * `CREATE TABLE IF NOT EXISTS`（MySQL 8 天然幂等）；`down()` 对称 `DROP TABLE IF EXISTS`。
 *
 * ## 与实体的关系
 * `system.entity.ts` 的 `PageTrack` 已同步声明同名同类级索引（名称 + 列序 + 唯一性
 * 逐项一致 —— `index:parity` 判据）。本地 sqlite 由实体 synchronize 建表、生产由
 * 本迁移建表，两侧不齐会在两道 parity 门禁上转红。
 */
const NEW_TABLE = `CREATE TABLE IF NOT EXISTS \`ab_page_track\` (
   \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
   \`page\` VARCHAR(128) NOT NULL COMMENT '页面路由路径（如 pages/index/index）',
   \`page_query\` VARCHAR(256) DEFAULT NULL COMMENT '页面 query 序列化（如 buildingId=3；无 query 为 NULL）',
   \`enter_at\` BIGINT UNSIGNED NOT NULL COMMENT '进入时刻（端上 Date.now() 毫秒）',
   \`leave_at\` BIGINT UNSIGNED NOT NULL COMMENT '离开时刻（端上 Date.now() 毫秒）',
   \`duration_ms\` INT NOT NULL COMMENT '停留毫秒（端上计算，封顶 24h）',
   \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   PRIMARY KEY (\`id\`),
   KEY \`idx_page_track_page_created\` (\`page\`,\`created_at\`)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='页面停留埋点（U15 · 匿名聚合 · 不采集身份 · 只增）'`;

export class PageTrack1700000000014 implements MigrationInterface {
  name = 'PageTrack1700000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(NEW_TABLE);
    console.log('   ↳ PageTrack：建表 ab_page_track（IF NOT EXISTS，重跑幂等）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `ab_page_track`');
  }
}
