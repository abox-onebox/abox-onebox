import { QueryRunner } from 'typeorm';

/**
 * 迁移共享工具（位于 `migrations/` 目录之外）
 *
 * ⚠️ 故意放在 `migrations/` 外面：TypeORM 的按目录加载器会扫描 `migrations/*`
 * 下每个文件、把**所有导出的函数**都当成「迁移类」收进去，再 `new` 它们 ——
 * 普通/箭头函数被 `new` 会报 `someClass is not a constructor`，阻断 migration:run。
 * 本模块只被各迁移文件 import，加载器扫不到它，故导出的函数不会污染迁移集合。
 *
 * ⚠️ 三个 `*_RENAMES` 常量数组**不在这里**——它们在 `1700000000005-dish-rename.ts`
 * （迁移文件内，模块级、位于 `up()` 之前）。原因：`schema-parity` 解析器只扫 `migrations/*.ts`，
 * 若把数组放本模块（`migrations/` 之外）解析器扫不到 ⇒ 改名对源A 不可见 ⇒ 误报缺表/缺列。
 * 故数组留在迁移文件内、辅助函数留本模块，二者职责分离。
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
