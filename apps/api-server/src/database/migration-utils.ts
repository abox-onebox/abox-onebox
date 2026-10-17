import { QueryRunner } from 'typeorm';

/**
 * 迁移共享工具（位于 `migrations/` 目录之外）
 *
 * ⚠️ 故意放在 `migrations/` 外面：TypeORM 的按目录加载器会扫描 `migrations/*`
 * 下每个文件、把**所有导出的函数**都当成「迁移类」收进去，再 `new` 它们 ——
 * 普通/箭头函数被 `new` 会报 `someClass is not a constructor`，阻断 migration:run。
 * 本模块只被各迁移文件 import，加载器扫不到它，故导出的函数不会污染迁移集合。
 *
 * 三个 `*_RENAMES` 常量数组虽也导出，但数组是对象、加载器只收函数，故安全。
 */

async function tableExists(qr: QueryRunner, table: string): Promise<boolean> {
  const rows = await qr.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [table],
  );
  return rows.length > 0;
}

async function columnExists(qr: QueryRunner, table: string, column: string): Promise<boolean> {
  const rows = await qr.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [table, column],
  );
  return rows.length > 0;
}

async function indexExists(qr: QueryRunner, table: string, index: string): Promise<boolean> {
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

function renameTablePair(sql: string): [string, string] {
  const m = /RENAME TABLE\s+`([^`]+)`\s+TO\s+`([^`]+)`/.exec(sql);
  if (!m) throw new Error(`无法解析 RENAME TABLE 语句：${sql}`);
  return [m[1], m[2]];
}

function columnRenameTriple(sql: string): [string, string, string] {
  const m = /ALTER TABLE\s+`([^`]+)`\s+CHANGE\s+`([^`]+)`\s+`([^`]+)`/.exec(sql);
  if (!m) throw new Error(`无法解析 CHANGE 语句：${sql}`);
  return [m[1], m[2], m[3]];
}

function indexRenameTriple(sql: string): [string, string, string] {
  const m = /ALTER TABLE\s+`([^`]+)`\s+RENAME INDEX\s+`([^`]+)`\s+TO\s+`([^`]+)`/.exec(sql);
  if (!m) throw new Error(`无法解析 RENAME INDEX 语句：${sql}`);
  return [m[1], m[2], m[3]];
}

export {
  tableExists,
  columnExists,
  indexExists,
  renameTablePair,
  columnRenameTriple,
  indexRenameTriple,
};
