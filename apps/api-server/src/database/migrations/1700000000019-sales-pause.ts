import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W1 一键停售：新建第 34 张表 `ab_sales_pause`（ADR-N1N2W1 · 2026-10-26）
 *
 * ## ⭐ 这张表为什么存在，而不是在 `ab_config` 里加一个键
 *
 * 「一键停售」的硬要求是**立刻生效**。`BizConfigService` 有 60 秒进程内缓存
 * （`biz-config.service.ts`），走配置路线必然出现最长 60 秒的放单窗口，且**毫无报错** ——
 * 运营点了停售、后台显示成功，这一分钟内用户照常下单。
 *
 * ⇒ 停售状态是**有时效的数据**（起止出餐日 + 原因 + 停售人 + 恢复人 + 恢复时刻），
 *    不是「口径参数」。它需要一个**可查询、可审计、可按出餐日点查**的落点。
 *
 * ## 表设计要点
 * - `meal_date_from` / `meal_date_to` 均为 `DATE`，**两端含首尾**；允许 `from == to`。
 * - **无唯一约束**：刻意允许重叠区间（「停售明天」+「停售下周一」是两条独立记录，
 *   各自独立恢复，先恢复一条不该连带解了另一条）。
 * - **无外键**：既有约定 —— FK 只存在于文档，不进 DDL。
 * - **无 `version` 列**：append-only + 单行 `resumed_at` 更新，不是并发争抢资源。
 * - `resumed_at IS NULL` = 仍生效；恢复是**打标记**而非删行（停售区间是审计事实）。
 * - `reason` 强制 `NOT NULL`：停售文案会下发到用户端，逼运营留一句人话。
 *
 * ## ⚠️ 与实体逐列一致（schema:parity / index:parity 判据）
 *
 * 实体在 `entities/system.entity.ts` 的 `SalesPause`：
 *   · 列名 / 类型 / 长度 / 精度须逐项一致；
 *   · 索引名 `idx_sales_pause_range` 与列序 `(meal_date_from, meal_date_to)` 须逐名逐列一致。
 * 本表只由迁移在**生产**建出，本地 sqlite 由实体 synchronize 建出 ——
 * 两侧不齐会在两道 parity 门禁上转红。
 *
 * ## 幂等与可重入
 * `CREATE TABLE IF NOT EXISTS`（MySQL 8 天然幂等）；`down()` 对称 `DROP TABLE IF EXISTS`。
 */
const NEW_TABLE = `CREATE TABLE IF NOT EXISTS \`ab_sales_pause\` (
   \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
   \`meal_date_from\` DATE NOT NULL COMMENT '停售起始出餐日（含）',
   \`meal_date_to\` DATE NOT NULL COMMENT '停售截止出餐日（含）',
   \`reason\` VARCHAR(255) NOT NULL COMMENT '停售原因（后台必填，随用户端文案下发）',
   \`created_by\` BIGINT UNSIGNED DEFAULT NULL COMMENT '停售人 admin_user_id',
   \`resumed_at\` DATETIME(3) DEFAULT NULL COMMENT '恢复时刻（NULL = 仍生效）',
   \`resumed_by\` BIGINT UNSIGNED DEFAULT NULL,
   \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
   PRIMARY KEY (\`id\`),
   KEY \`idx_sales_pause_range\` (\`meal_date_from\`,\`meal_date_to\`)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='全局停售区间（W1 · ADR-N1N2W1）'`;

export class SalesPause1700000000019 implements MigrationInterface {
  name = 'SalesPause1700000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(NEW_TABLE);
    console.log('   ↳ SalesPause：建表 ab_sales_pause（IF NOT EXISTS，重跑幂等）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `ab_sales_pause`');
  }
}
