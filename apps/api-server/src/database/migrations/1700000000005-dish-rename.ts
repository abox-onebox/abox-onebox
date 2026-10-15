import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3 + P1 合并重构（第一批 · 破坏性 DDL）—— 把「菜品 / 菜」概念统一改名为「商品 / 品」
 *
 * ## 改名清单（与实体层 `entities/*.ts` 的 `@Entity` / `@Column` / `@Index` 逐项对齐）
 * - 表（RENAME TABLE）：
 *     ab_dish                         → ab_item
 *     ab_dish_rating                  → ab_item_rating
 *     ab_supplier_dish_daily          → ab_supplier_item_daily
 *     ab_supplier_dish_center_daily   → ab_supplier_item_center_daily
 * - 列（CHANGE）：
 *     dish_id  → item_id  （ab_set_meal_item / ab_item_rating / ab_supplier_item_daily /
 *                          ab_supplier_item_center_daily / ab_supplier_share）
 *     dish_name → item_name（仅 ab_item_rating —— ab_supplier_share 经核对**无** dish_name 列）
 * - 索引（RENAME INDEX）：见下方 INDEX_RENAMES
 *     （idx_dish_category / idx_dish_supplier / idx_supplier_dish_date / uk_supplier_dish_date /
 *      uk_sddc / uk_dish_rating_order_dish / idx_dish_rating_dish_date / idx_dish_rating_user /
 *      idx_sddc_date_center / idx_sddc_supplier）
 *
 * ## 为什么是增量迁移而不是改旧迁移
 * 与 `1700000000001-parity-fix.ts` 同理由：已执行过 init 的环境会静默跳过改后的它，
 * 增量迁移对「已执行过 init 的环境」才是正确的。
 *
 * ## schema-parity 兼容性（重要）
 * 所有 RENAME / CHANGE 语句都以**字面量 SQL** 写进 `TABLE_RENAMES` / `COLUMN_RENAMES` /
 * `INDEX_RENAMES` 常量数组（而非模板字符串拼 `${oldT}`），以便 `schema-parity.ts` 的解析器
 * 能直接读出来、把源A 推演到改名后的结构。改这里的 SQL 时务必同步改数组里的字面量。
 *
 * ## 幂等与可重入（重跑不报错、不重复改）
 * MySQL 不支持 `RENAME TABLE` / `CHANGE COLUMN` / `RENAME INDEX` 的 `IF NOT EXISTS`，
 * 故逐项查 `information_schema` 后再操作；服务器部署用 `git archive` 覆盖后重跑迁移是常态。
 *
 * ## 外键
 * 全库**无任何 FOREIGN KEY 约束**（关系由应用层管理），故无需处理 FK 丢弃/重建。
 *
 * ## 生产库
 * 迁移照跑；**生产库不跑 seed**（既有约定）。先在副本 / 测试库验证后再上生产。
 *
 * ## down()
 * 对称回退：反向 RENAME / CHANGE / RENAME INDEX（列改名保留原类型）。
 */

export async function tableExists(qr: QueryRunner, table: string): Promise<boolean> {
  const rows = await qr.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [table],
  );
  return rows.length > 0;
}

export async function columnExists(
  qr: QueryRunner,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await qr.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [table, column],
  );
  return rows.length > 0;
}

export async function indexExists(qr: QueryRunner, table: string, index: string): Promise<boolean> {
  const rows = await qr.query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [table, index],
  );
  return rows.length > 0;
}

/** 字面量 SQL —— schema-parity 解析器直接读取（不要改成模板字符串拼变量） */
export const TABLE_RENAMES: ReadonlyArray<string> = [
  'RENAME TABLE `ab_dish` TO `ab_item`',
  'RENAME TABLE `ab_dish_rating` TO `ab_item_rating`',
  'RENAME TABLE `ab_supplier_dish_daily` TO `ab_supplier_item_daily`',
  'RENAME TABLE `ab_supplier_dish_center_daily` TO `ab_supplier_item_center_daily`',
];

export const COLUMN_RENAMES: ReadonlyArray<string> = [
  'ALTER TABLE `ab_set_meal_item` CHANGE `dish_id` `item_id` BIGINT UNSIGNED NOT NULL',
  'ALTER TABLE `ab_item_rating` CHANGE `dish_id` `item_id` BIGINT UNSIGNED NOT NULL',
  'ALTER TABLE `ab_item_rating` CHANGE `dish_name` `item_name` VARCHAR(64) NOT NULL',
  'ALTER TABLE `ab_supplier_item_daily` CHANGE `dish_id` `item_id` BIGINT UNSIGNED NOT NULL',
  'ALTER TABLE `ab_supplier_item_center_daily` CHANGE `dish_id` `item_id` BIGINT UNSIGNED NOT NULL',
  'ALTER TABLE `ab_supplier_share` CHANGE `dish_id` `item_id` BIGINT UNSIGNED DEFAULT NULL',
];

export const INDEX_RENAMES: ReadonlyArray<string> = [
  'ALTER TABLE `ab_item` RENAME INDEX `idx_dish_category` TO `idx_item_category`',
  'ALTER TABLE `ab_item` RENAME INDEX `idx_dish_supplier` TO `idx_item_supplier`',
  'ALTER TABLE `ab_supplier_item_daily` RENAME INDEX `idx_supplier_dish_date` TO `idx_supplier_item_date`',
  'ALTER TABLE `ab_supplier_item_daily` RENAME INDEX `uk_supplier_dish_date` TO `uk_supplier_item_date`',
  'ALTER TABLE `ab_supplier_item_center_daily` RENAME INDEX `uk_sddc` TO `uk_sidc`',
  'ALTER TABLE `ab_item_rating` RENAME INDEX `uk_dish_rating_order_dish` TO `uk_item_rating_order_dish`',
  'ALTER TABLE `ab_item_rating` RENAME INDEX `idx_dish_rating_dish_date` TO `idx_item_rating_dish_date`',
  'ALTER TABLE `ab_item_rating` RENAME INDEX `idx_dish_rating_user` TO `idx_item_rating_user`',
  'ALTER TABLE `ab_supplier_item_center_daily` RENAME INDEX `idx_sddc_date_center` TO `idx_sidc_date_center`',
  'ALTER TABLE `ab_supplier_item_center_daily` RENAME INDEX `idx_sddc_supplier` TO `idx_sidc_supplier`',
];

export function renameTablePair(sql: string): [string, string] {
  const m = /RENAME TABLE\s+`([^`]+)`\s+TO\s+`([^`]+)`/.exec(sql);
  if (!m) throw new Error(`无法解析 RENAME TABLE 语句：${sql}`);
  return [m[1], m[2]];
}

export function columnRenameTriple(sql: string): [string, string, string] {
  const m = /ALTER TABLE\s+`([^`]+)`\s+CHANGE\s+`([^`]+)`\s+`([^`]+)`/.exec(sql);
  if (!m) throw new Error(`无法解析 CHANGE 语句：${sql}`);
  return [m[1], m[2], m[3]];
}

export function indexRenameTriple(sql: string): [string, string, string] {
  const m = /ALTER TABLE\s+`([^`]+)`\s+RENAME INDEX\s+`([^`]+)`\s+TO\s+`([^`]+)`/.exec(sql);
  if (!m) throw new Error(`无法解析 RENAME INDEX 语句：${sql}`);
  return [m[1], m[2], m[3]];
}

export class DishRename1700000000005 implements MigrationInterface {
  name = 'DishRename1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    let tables = 0;
    let columns = 0;
    let indexes = 0;

    for (const sql of TABLE_RENAMES) {
      const [oldT, newT] = renameTablePair(sql);
      const hasOld = await tableExists(queryRunner, oldT);
      const hasNew = await tableExists(queryRunner, newT);
      if (hasOld && !hasNew) {
        await queryRunner.query(sql);
        tables += 1;
      }
    }

    for (const sql of COLUMN_RENAMES) {
      // ⚠️ 解构是 `[表, 旧列, 新列]`。曾错写成 `const [, table, oldC]` —— 丢掉表名、
      //    把「旧列名」当表名、「新列名」当旧列名 ⇒ 判据恒 false ⇒ 6 条列改名**全被静默跳过**
      //    （迁移仍记为已执行，之后再跑也永远跳过）。补救见 1700000000006。
      const [table, oldC] = columnRenameTriple(sql);
      if (await columnExists(queryRunner, table, oldC)) {
        await queryRunner.query(sql);
        columns += 1;
      }
    }

    for (const sql of INDEX_RENAMES) {
      // ⚠️ 同 COLUMN_RENAMES 的坑：解构是 `[表, 旧索引, 新索引]`，不可丢弃第一项
      const [table, oldI] = indexRenameTriple(sql);
      if (await indexExists(queryRunner, table, oldI)) {
        await queryRunner.query(sql);
        indexes += 1;
      }
    }

    console.log(
      `   ↳ DishRename：改名表 ${tables} / 改列 ${columns} / 改名索引 ${indexes}` +
        `（已存在而跳过的项不计入；重跑本迁移为幂等）`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of INDEX_RENAMES) {
      const [table, oldI, newI] = indexRenameTriple(sql);
      if (await indexExists(queryRunner, table, oldI)) {
        await queryRunner.query(`ALTER TABLE \`${table}\` RENAME INDEX \`${newI}\` TO \`${oldI}\``);
      }
    }

    for (const sql of COLUMN_RENAMES) {
      const [table, oldC, newC] = columnRenameTriple(sql);
      if (await columnExists(queryRunner, table, newC)) {
        // 反向 CHANGE：把 `old` `new` 两个反引号标识符对调（类型不变，保留原 DDL 的类型/约束）
        const reverse = sql.replace(
          new RegExp(`CHANGE \`${oldC}\` \`${newC}\``, 'g'),
          `CHANGE \`${newC}\` \`${oldC}\``,
        );
        await queryRunner.query(reverse);
      }
    }

    for (const sql of TABLE_RENAMES) {
      const [oldT, newT] = renameTablePair(sql);
      const hasOld = await tableExists(queryRunner, oldT);
      const hasNew = await tableExists(queryRunner, newT);
      if (hasOld && !hasNew) {
        await queryRunner.query(`RENAME TABLE \`${oldT}\` TO \`${newT}\``);
      }
    }
  }
}
