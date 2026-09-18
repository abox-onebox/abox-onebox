import 'reflect-metadata';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

/**
 * index-parity —— 「迁移里的索引」↔「实体声明的索引」机械对账
 *
 * ## 为什么需要它（`schema:parity` 的**已知边界**）
 * `schema:parity` 只比「表 + 列 + 列类型族」，它自己在注释里明写 **不比索引**
 * （`schema-parity.ts` §已知边界：「不比索引」）。于是「实体加了索引、迁移忘了加」
 * 与 #76（实体改了、迁移忘了改）是**同一族**的缺口，却**不在任何失败路径上**：
 *   · 本地 sqlite 由**实体** synchronize 建表 → 索引按实体声明建出来，e2e 全绿；
 *   · 生产由**迁移**建表 → 索引按迁移 DDL 建出来。
 *   **两边都「成功」，但两边的索引集可以完全不同。**
 *
 * ⚠️ 而「索引不一致」比「列不一致」更隐蔽：缺列会 `Unknown column` 直接炸出来，
 *    索引不一致**一句报错都没有**，只表现为「本地很快、生产很慢」（或反过来）。
 *    本工具首跑实测到的正是这一形态：`ab_order.idx_order_user` 在迁移里是
 *    `(user_id, meal_date)` 复合索引，而实体只声明了 `(user_id)` 单列 ——
 *    生产能用松散索引扫描，本地开发库不行。
 *    **没有门禁的索引 = 一份写在实体里的愿望。**
 *
 * ## 两个来源（刻意不同源）
 * - **源A「迁移推演」**：解析全部迁移的 `KEY` / `UNIQUE KEY`（CREATE TABLE 体内）
 *   与 `ALTER TABLE … ADD [UNIQUE] INDEX`
 * - **源B「实体声明」**：`DataSource` 读 `ALL_ENTITIES` 的 **metadata**（`indices` +
 *   `uniques`）。索引名 / 列 / 唯一性都是**装饰器信息**，与驱动无关 ——
 *   列名用 `ColumnMetadata.databaseName`（下划线真列名），故**不需要**任何
 *   驼峰↔下划线映射表：映射写错会产生一屏假差异。
 *
 * ## 判红 / 仅打印
 * - **判红**：实体有、迁移无 → 生产上这个索引不存在（静默劣化）
 * - **判红**：列集合（有序）或唯一性不一致 → **两边索引不一样**（这是最危险的一档：
 *   本地/生产行为不同，且都自认为成功）
 * - **仅打印**：迁移有、实体无 → 生产多一个本地没有的索引，不影响正确性
 *
 * ## 自证能力（每次运行都跑）
 * ① 删掉一个索引 → **必须**报「实体有 / 迁移无」；
 * ② 把某个索引的唯一性翻转 → **必须**报「唯一性不一致」；
 * ③ 从某个索引的列里删掉一列 → **必须**报「列不一致」。
 * 报不出即 exit 1：「恒绿的检查」比没有检查更糟。
 *
 * ## 已知边界（如实标注）
 * - **不比索引前缀长度 / 排序方向 / 索引类型**（`INDEX` vs `FULLTEXT`）：本项目未使用。
 * - 不判断「这个索引是否真的被用上」（那要 EXPLAIN + 真实数据量，属运维期工作）。
 * - 匿名索引（TypeORM 自动命名）不参与对账 —— 迁移里不会出现它们的名字。
 *
 * 运行：`node scripts/gate.mjs index:parity`（或 `ts-node src/database/index-parity.ts`）
 */

type IndexShape = { unique: boolean; columns: string[] };
/** 表 → 索引名 → 形状 */
type IndexSchema = Map<string, Map<string, IndexShape>>;

const MIGRATION_DIR = join(__dirname, 'migrations');

/** CREATE TABLE 体里的 `KEY \`name\` (\`a\`,\`b\`)` / `UNIQUE KEY \`name\` (...)`（PRIMARY KEY 无名字，天然不匹配） */
const KEY_IN_TABLE_RE = /(UNIQUE\s+)?KEY\s+`([A-Za-z0-9_]+)`\s*\(([^)]*)\)/gi;
/** `ALTER TABLE \`t\` ADD [UNIQUE] INDEX \`name\` (\`a\`,\`b\`)` */
const ALTER_ADD_INDEX_RE =
  /ALTER TABLE\s+`([A-Za-z0-9_]+)`\s+ADD\s+(UNIQUE\s+)?INDEX\s+`([A-Za-z0-9_]+)`\s*\(([^)]*)\)/gi;
const CREATE_TABLE_RE =
  /CREATE TABLE IF NOT EXISTS\s+`([A-Za-z0-9_]+)`\s*\(([\s\S]*?)\n\s*\)\s*ENGINE/gi;
const COL_IN_LIST_RE = /`([A-Za-z0-9_]+)`/g;

/**
 * ⚠️ 必须先剥注释再扫描：迁移的**文件头注释**里就写着
 * 「MySQL 8 不支持 `CREATE INDEX IF NOT EXISTS`」，不剥注释会把注释里的文字当语句
 * （`schema-parity.ts` 首跑即中过这一枪）。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

/** 源A 的作用域 = 模块级常量 + `up()`；`down()` 是回退方向，必须排除（同 schema-parity） */
function upScope(raw: string, file: string): string {
  const upAt = raw.search(/\basync\s+up\s*\(/);
  if (upAt < 0) throw new Error(`${file} 里找不到 \`async up(\` —— 解析器需扩展`);
  const downAt = raw.search(/\basync\s+down\s*\(/);
  const body = downAt > upAt ? raw.slice(upAt, downAt) : raw.slice(upAt);
  return `${raw.slice(0, upAt)}\n${body}`;
}

const colsOf = (list: string): string[] => [...list.matchAll(COL_IN_LIST_RE)].map((m) => m[1]);

export function migrationIndexes(): {
  schema: IndexSchema;
  stats: { tables: number; indexes: number };
} {
  const files = readdirSync(MIGRATION_DIR)
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();
  if (files.length === 0) throw new Error(`迁移目录里一个文件都没有：${MIGRATION_DIR}`);

  const schema: IndexSchema = new Map();
  const put = (table: string, name: string, unique: boolean, columns: string[]) => {
    const m = schema.get(table) ?? new Map<string, IndexShape>();
    m.set(name, { unique, columns });
    schema.set(table, m);
  };

  for (const f of files) {
    const scope = upScope(
      stripComments(readFileSync(join(MIGRATION_DIR, f), 'utf8')).replace(/\\`/g, '`'),
      f,
    );

    let keySeen = 0;
    let alterSeen = 0;

    for (const m of scope.matchAll(CREATE_TABLE_RE)) {
      for (const k of m[2].matchAll(KEY_IN_TABLE_RE)) {
        keySeen += 1;
        put(m[1], k[2], !!k[1], colsOf(k[3]));
      }
    }
    for (const m of scope.matchAll(ALTER_ADD_INDEX_RE)) {
      alterSeen += 1;
      put(m[1], m[3], !!m[2], colsOf(m[4]));
    }

    // ---- 解析器完备性自检：源码里出现的次数必须与解析到的条数相等 ----
    const keyCount = (scope.match(/(UNIQUE\s+)?KEY\s+`/gi) ?? []).length;
    const alterCount = (scope.match(/ADD\s+(UNIQUE\s+)?INDEX\s+`/gi) ?? []).length;
    if (keyCount !== keySeen) {
      throw new Error(
        `${f}：CREATE TABLE 体里的索引源码 ${keyCount} 处 / 解析 ${keySeen} 处 —— 有语句被漏读，先修解析器`,
      );
    }
    if (alterCount !== alterSeen) {
      throw new Error(
        `${f}：ALTER … ADD INDEX 源码 ${alterCount} 处 / 解析 ${alterSeen} 处 —— 有语句被漏读，先修解析器`,
      );
    }
  }

  let indexes = 0;
  for (const m of schema.values()) indexes += m.size;
  return { schema, stats: { tables: schema.size, indexes } };
}

export async function entityIndexes(): Promise<{
  schema: IndexSchema;
  stats: { tables: number; indexes: number };
}> {
  process.env.DB_DRIVER = 'sqlite';
  const { ALL_ENTITIES } = await import('./entities');

  // ⚠️ 索引信息来自**装饰器 metadata**，与驱动无关 —— 但 `PkColumn()` 在装饰器求值期
  //    读 `DB_DRIVER`，故仍需「先赋 env、后动态 import」（同 schema-parity 的教训）。
  //    也**刻意不真连库**：sqlite 的 `PRAGMA index_list` 会带上 TypeORM 自建的匿名索引，
  //    反而引入与迁移无关的噪声。
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ALL_ENTITIES,
  });
  await ds.initialize();
  try {
    const schema: IndexSchema = new Map();
    for (const md of ds.entityMetadatas) {
      const t = md.tableName;
      if (!t.startsWith('ab_')) continue;
      const m = new Map<string, IndexShape>();
      for (const ix of md.indices) {
        if (!ix.name) continue; // 匿名索引不参与对账
        // `databaseName` 是真列名（下划线）—— 与迁移 DDL 同源，不需要任何映射表
        m.set(ix.name, { unique: !!ix.isUnique, columns: ix.columns.map((c) => c.databaseName) });
      }
      // `@Unique(...)` 形态：TypeORM 记为 `uniques`，迁移侧同样是 `UNIQUE KEY`，
      // 故合并到同一张表里比（否则一条 `@Unique` 会被误报成「迁移有 / 实体无」）
      for (const uq of md.uniques) {
        if (uq.name)
          m.set(uq.name, { unique: true, columns: uq.columns.map((c) => c.databaseName) });
      }
      schema.set(t, m);
    }
    let indexes = 0;
    for (const m of schema.values()) indexes += m.size;
    return { schema, stats: { tables: schema.size, indexes } };
  } finally {
    await ds.destroy();
  }
}

type Diff = {
  /** 实体声明了、迁移里没有 —— 生产上该索引不存在，**必须为零** */
  missingInMigration: { table: string; index: string }[];
  /** 列（有序）不一致 —— 本地与生产的索引**不是同一个**，**必须为零** */
  columnMismatch: { table: string; index: string; entity: string; migration: string }[];
  /** 唯一性不一致 —— 生产上防重能力与实体声明不符，**必须为零** */
  uniqueMismatch: { table: string; index: string; entity: boolean; migration: boolean }[];
  /** 迁移有、实体无 —— 仅打印 */
  extraInMigration: { table: string; index: string }[];
};

export function diffIndexes(mig: IndexSchema, ent: IndexSchema): Diff {
  const d: Diff = {
    missingInMigration: [],
    columnMismatch: [],
    uniqueMismatch: [],
    extraInMigration: [],
  };
  for (const [table, eidx] of ent) {
    const midx = mig.get(table);
    if (!midx) continue; // 表级缺失由 schema:parity 负责报，这里不重复报
    for (const [name, shape] of eidx) {
      const m = midx.get(name);
      if (!m) {
        d.missingInMigration.push({ table, index: name });
        continue;
      }
      if (m.columns.join(',') !== shape.columns.join(','))
        d.columnMismatch.push({
          table,
          index: name,
          entity: shape.columns.join(','),
          migration: m.columns.join(','),
        });
      if (m.unique !== shape.unique)
        d.uniqueMismatch.push({ table, index: name, entity: shape.unique, migration: m.unique });
    }
    for (const name of midx.keys())
      if (!eidx.has(name)) d.extraInMigration.push({ table, index: name });
  }
  return d;
}

const clone = (s: IndexSchema): IndexSchema =>
  new Map([...s].map(([t, m]) => [t, new Map([...m].map(([n, v]) => [n, { ...v }]))]));

/** 自证：人为制造三种缺口，确认**每一种**都报得出来（空数组 = 通过） */
function selfTest(mig: IndexSchema, ent: IndexSchema): string[] {
  const problems: string[] = [];

  let victim: { table: string; index: string } | null = null;
  for (const [table, eidx] of ent) {
    const midx = mig.get(table);
    if (!midx) continue;
    for (const name of eidx.keys()) {
      if (midx.has(name)) {
        victim = { table, index: name };
        break;
      }
    }
    if (victim) break;
  }
  if (!victim) {
    problems.push('自检无法执行：实体与迁移没有任何同名索引 —— 对账器已失去对照面');
    return problems;
  }

  // ① 删掉索引 → 必须报「实体有 / 迁移无」
  const c1 = clone(mig);
  c1.get(victim.table)?.delete(victim.index);
  if (
    !diffIndexes(c1, ent).missingInMigration.some(
      (x) => x.table === victim!.table && x.index === victim!.index,
    )
  ) {
    problems.push(
      `自检失败：人为删掉 \`${victim.table}.${victim.index}\` 后，对账器**没有报出**该索引缺失` +
        ` —— 这个检查是恒绿的，等于不存在`,
    );
  }

  // ② 翻转唯一性 → 必须报「唯一性不一致」
  const c2 = clone(mig);
  const t2 = c2.get(victim.table)?.get(victim.index);
  if (t2) {
    t2.unique = !(ent.get(victim.table)?.get(victim.index)?.unique ?? false);
    if (
      !diffIndexes(c2, ent).uniqueMismatch.some(
        (x) => x.table === victim!.table && x.index === victim!.index,
      )
    ) {
      problems.push(
        `自检失败：把 \`${victim.table}.${victim.index}\` 的唯一性翻转后，对账器没有报出「唯一性不一致」`,
      );
    }
  }

  // ③ 从列里删一列 → 必须报「列不一致」
  const c3 = clone(mig);
  const t3 = c3.get(victim.table)?.get(victim.index);
  if (t3 && t3.columns.length > 0) {
    t3.columns = t3.columns.slice(0, -1);
    if (
      !diffIndexes(c3, ent).columnMismatch.some(
        (x) => x.table === victim!.table && x.index === victim!.index,
      )
    ) {
      problems.push(
        `自检失败：从 \`${victim.table}.${victim.index}\` 的列里删掉一列后，` +
          `对账器没有报出「列不一致」—— 那样「复合索引被写成单列」这类缺陷会被放过去`,
      );
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const mig = migrationIndexes();
  const ent = await entityIndexes();
  const d = diffIndexes(mig.schema, ent.schema);

  console.log('index-parity —— 迁移 ↔ 实体 索引对账（schema:parity 的边界补位）');
  console.log(`  源A 迁移推演：${mig.stats.tables} 表 / ${mig.stats.indexes} 个索引`);
  console.log(
    `  源B 实体声明：${ent.stats.tables} 表 / ${ent.stats.indexes} 个索引（读装饰器 metadata）`,
  );
  console.log();

  const selfProblems = selfTest(mig.schema, ent.schema);
  console.log(
    selfProblems.length === 0 ? '✔ 自检：对账器确实能报出人为制造的缺口' : '✘ 自检未通过',
  );
  for (const p of selfProblems) console.log(`   ${p}`);
  console.log();

  if (d.missingInMigration.length) {
    console.log(
      `✘ 迁移缺索引（${d.missingInMigration.length}）：生产上这些索引**不存在**，` +
        `查询会退化为全表扫描而**不报任何错**`,
    );
    for (const x of d.missingInMigration) console.log(`   - ${x.table}.${x.index}`);
    console.log();
  }
  if (d.columnMismatch.length) {
    console.log(
      `✘ 索引列不一致（${d.columnMismatch.length}）：**本地库与生产的索引不是同一个** ——` +
        `两边都不报错，只表现为性能与查询计划不同`,
    );
    for (const x of d.columnMismatch)
      console.log(`   - ${x.table}.${x.index}  实体=(${x.entity}) 迁移=(${x.migration})`);
    console.log();
  }
  if (d.uniqueMismatch.length) {
    console.log(`✘ 唯一性不一致（${d.uniqueMismatch.length}）：生产上防重能力与实体声明不符`);
    for (const x of d.uniqueMismatch)
      console.log(`   - ${x.table}.${x.index}  实体 unique=${x.entity} 迁移 unique=${x.migration}`);
    console.log();
  }
  if (d.extraInMigration.length) {
    console.log(
      `ℹ 迁移比实体多出的索引（${d.extraInMigration.length}）—— 生产多一个本地没有的索引，仅提示：`,
    );
    for (const x of d.extraInMigration) console.log(`   · ${x.table}.${x.index}`);
    console.log();
  }

  const bad = d.missingInMigration.length + d.columnMismatch.length + d.uniqueMismatch.length;
  if (selfProblems.length || bad > 0) {
    console.log(`✘ index-parity 未通过：${bad} 处索引差异 + ${selfProblems.length} 处自检失败`);
    console.log(
      '  处理办法：结构差异一律改**迁移**（不改实体）—— 生产结构只由迁移决定；' +
        '但**反向**也成立：实体的索引声明必须与迁移逐名逐列一致，否则本地与生产是两套索引。' +
        '新增索引请追加一支增量迁移（沿 `1700000000001-parity-fix.ts` 的 information_schema 幂等守卫）。',
    );
    process.exit(1);
  }
  console.log(`✔ 索引一致：${ent.stats.indexes} 个索引，迁移与实体逐名逐列对齐`);
}

// 被 import 时（单测 / 复用）不自动执行
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('✖ index-parity 执行失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
