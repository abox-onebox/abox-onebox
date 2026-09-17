import 'reflect-metadata';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

/**
 * schema-parity —— 「迁移」↔「实体」结构机械对账（缺陷 #76 的防复发门禁）
 *
 * ## 为什么必须有这个检查
 * 生产（MySQL）的表结构**只由迁移文件决定**（`data-source.ts` 里 `synchronize: driver === 'sqlite'`），
 * 而本地全部验证（`seed` / `e2e:m1,m2,m3`）都跑 sqlite —— sqlite 下由**实体**同步建表，
 * **迁移一次都不会被执行**。于是「实体改了、迁移忘了改」这件事**不在任何失败路径上**：
 * e2e 全绿，而生产首迁出一个残缺库，第一个查询就炸在 `Unknown column`。
 * M5-1 收尾时实测：唯一迁移比实体**少 2 张表、7 列**（含 C6 审批必需的 `ab_refund.order_status_before`）。
 *
 * ## 两个来源（刻意不同源，互为对照）
 * - **源A「迁移推演」**：解析全部迁移里的 `CREATE TABLE` / `ADD COLUMN` —— 代表**生产真实会得到的结构**
 * - **源B「实体真库」**：让 TypeORM 拿 `ALL_ENTITIES` 在**内存 sqlite** 上真建一次表，再读回 schema
 *   —— 代表**代码真实依赖的结构**
 *
 * ⚠️ 源B **刻意不解析实体源码**：列装饰器形态多（`@Column` / `@VersionColumn` / `@PkColumn` /
 * `@PrimaryColumn` / `@CreateDateColumn`…），手写正则漏一个就是**假绿** —— 本工具诞生时已连踩两版
 * （第一版漏了 `@VersionColumn`，第二版用 `lines.index()` 命中重复行导致列错位）。
 * 让引擎自己建库、再读回来，是**唯一**不会漏的做法。
 *
 * ## 自证能力（每次运行都跑，不是可选开关）
 * 检查器自己也要被验：把源A 里的一列人为删掉，再比对一次 —— **必须报出**该列缺失。
 * 报不出就 exit 1：**「恒绿的检查」比没有检查更糟**（它会让人相信一个不存在的能力）。
 *
 * ## 阻塞与放行（刻意分开，避免误报把人逼到关掉门禁）
 * - **判红**：表名、列名、列类型（归一到类型族后比较）—— 这三样错一个，生产就是 `Table doesn't exist`
 *   / `Unknown column` / 静默截断
 * - **仅打印**：迁移比实体**多**的列（历史字段刻意保留列是项目既有约定，如 `ab_supplier.type`）
 *
 * ## 已知边界（如实标注，未覆盖处一律**报错**而不是静默放过）
 * - 不比长度/精度/默认值/注释：sqlite 与 MySQL 的表述不同源，强行比会得到一屏噪声盖住真问题
 * - 不比索引：见输出末尾的 advisory 段
 * - 未支持的语句形态（`MODIFY COLUMN` / `CHANGE COLUMN` / `RENAME` / `CREATE INDEX`）→ **显式报错**，
 *   要求扩展本解析器，绝不静默跳过（静默跳过 = 假绿）
 * - `DROP TABLE` / `DROP COLUMN` 属 `down()` 方向，不在源A 的关注范围
 *
 * 运行：`node scripts/gate.mjs schema:parity`（或 `ts-node src/database/schema-parity.ts`）
 */
type ColumnShape = { type: string; pk?: boolean };

/** 迁移推演结果 / 实体真库结果：表 → 列 → 形状 */
type Schema = Map<string, Map<string, ColumnShape>>;

/**
 * 类型归一表 —— 把 MySQL DDL 写法与 TypeORM 在 sqlite 上的建表写法收敛到同一族。
 * ⚠️ 遇到未登记的类型**抛错**（见 normType）：新类型必须显式登记，否则该列的类型无人把关。
 */
const TYPE_ALIAS: Record<string, string> = {
  BIGINT: 'BIGINT',
  INT: 'INT',
  INTEGER: 'INT',
  TINYINT: 'TINYINT',
  SMALLINT: 'SMALLINT',
  DECIMAL: 'DECIMAL',
  NUMERIC: 'DECIMAL',
  VARCHAR: 'VARCHAR',
  CHAR: 'CHAR',
  TEXT: 'TEXT',
  // MySQL 的 JSON 在 TypeORM 的 sqlite 映射里落到 text；两者归一，否则每列都报假差异。
  // 代价：真出现「JSON 写成 TEXT」不会被本检查抓到（已列为边界）。
  JSON: 'TEXT',
  DATE: 'DATE',
  DATETIME: 'DATETIME',
  TIMESTAMP: 'DATETIME',
  TIME: 'TIME',
  BLOB: 'BLOB',
  BOOLEAN: 'BOOLEAN',
};

function normType(raw: string): string {
  const base = raw
    .toUpperCase()
    .replace(/\s+UNSIGNED\b/, '')
    .replace(/\(.*\)/, '')
    .trim();
  const mapped = TYPE_ALIAS[base];
  if (!mapped) {
    throw new Error(
      `未登记的类型 「${raw}」 —— 请在 schema-parity.ts 的 TYPE_ALIAS 里显式登记后再跑（不静默放过）`,
    );
  }
  return mapped;
}

const MIGRATION_DIR = join(__dirname, 'migrations');

/** 迁移里「源A 不解析」的**语句形态**：在 up 作用域里出现即报错，要求扩展解析器 */
const UNSUPPORTED_IN_MIGRATION: { pat: RegExp; label: string }[] = [
  { pat: /CHANGE COLUMN\s+`/i, label: 'CHANGE COLUMN' },
  { pat: /RENAME\s+(COLUMN\s+)?`/i, label: 'RENAME' },
  { pat: /CREATE\s+(UNIQUE\s+)?INDEX\s+`/i, label: 'CREATE INDEX' },
  // 删列/删表/删索引在 up() 里出现 = 结构会**减少**，而源A 目前只做「加」的推演
  // → 必须报错要求扩展，**不能静默忽略**（忽略 = 该列在对账里仍然存在 = 假绿）
  { pat: /DROP\s+COLUMN\s+`/i, label: 'DROP COLUMN' },
  { pat: /DROP\s+TABLE/i, label: 'DROP TABLE' },
  { pat: /DROP\s+INDEX\s+`/i, label: 'DROP INDEX' },
];

/**
 * 去掉 TS 注释 —— ⚠️ 必须先剥注释再扫描**任何关键词**。
 *
 * 实战教训（本工具首跑即中）：迁移的**文件头注释**里写了「MySQL 8 不支持
 * `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`」，于是
 * ① 「未支持语句」守卫把**注释里的文字**当成真实语句而报错；
 * ② 更隐蔽的是**条数自检**：`ADD COLUMN` 在源码里出现 10 次（9 条语句 + 1 处注释），
 *    解析到 9 条 → 自检误报「有语句被漏读」。
 * 结论：任何「关键词计数 / 关键词守卫」都只能建立在**剥掉注释后的文本**上。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSDoc）
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1'); // 行注释（避开 http:// 这类「冒号+双斜杠」）
}

/**
 * 源A 的**作用域** = 模块级常量（init 把 DDL 放在 `TABLES` 数组里，`up()` 只是遍历它）
 * ＋ `up()` 方法体；**`down()` 一律排除** —— 它是回退方向，若混进来，里面的
 * `DROP COLUMN` / `DROP TABLE` 会把源A 推演成「迁移后什么都没有」。
 *
 * ⚠️ 这是启发式：若某个模块级常量**只被 down() 使用**（本项目现状里有这种现象：回退用的是
 * 与 up 同形态的 MODIFY 语句），它会一并进入源A。当前影响为零（同类型重复赋值无副作用），
 * 但它是本解析器的**已知边界**。
 */
function upScope(raw: string, file: string): string {
  const upAt = raw.search(/\basync\s+up\s*\(/);
  if (upAt < 0) throw new Error(`${file} 里找不到 \`async up(\` —— 解析器需扩展`);
  const downAt = raw.search(/\basync\s+down\s*\(/);
  const body = downAt > upAt ? raw.slice(upAt, downAt) : raw.slice(upAt);
  return `${raw.slice(0, upAt)}\n${body}`;
}

/** CREATE TABLE IF NOT EXISTS `t` ( ... ) ENGINE=... —— 结尾必须带 ENGINE，避免误吞后面的内容 */
const CREATE_TABLE_RE =
  /CREATE TABLE IF NOT EXISTS\s+`([A-Za-z0-9_]+)`\s*\(([\s\S]*?)\n\s*\)\s*ENGINE/gi;

/** 列定义行：`col` TYPE[(n[,m])] [UNSIGNED] —— 只在非索引行上取 */
const COLUMN_DEF_RE = /^`([A-Za-z0-9_]+)`\s+([A-Z]+(?:\(\d+(?:,\d+)?\))?(?:\s+UNSIGNED)?)/;
const ADD_COLUMN_RE =
  /ADD COLUMN\s+`([A-Za-z0-9_]+)`\s+([A-Z]+(?:\(\d+(?:,\d+)?\))?(?:\s+UNSIGNED)?)/gi;
/**
 * MODIFY COLUMN `c` TYPE —— 会**改变列的形态**，故必须计入源A（否则「迁移里把类型改了、
 * 对账器看不见」= 假绿）。本项目用它做「注释对齐」（`ab_building.status` 三态说明）。
 */
const MODIFY_COLUMN_RE =
  /MODIFY COLUMN\s+`([A-Za-z0-9_]+)`\s+([A-Z]+(?:\(\d+(?:,\d+)?\))?(?:\s+UNSIGNED)?)/gi;
/** 索引/约束行：这些行上的反引号标识符不是列名 */
const INDEX_LINE_RE = /^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN)\b/;

/**
 * `ALTER TABLE \`T\`` 的 T 在 `ADD COLUMN` / `MODIFY COLUMN` **之前** —— 取「语句内最近的那一条」定表。
 * 找不到即报错：宁可拒绝运行，也不要把列挂到错误的表上（挂错表 = 对账结论整体失真）。
 */
function tableOfStatement(raw: string, file: string, kind: string, at: number): string {
  const alter = [...raw.slice(0, at).matchAll(/ALTER TABLE\s+`([A-Za-z0-9_]+)`/gi)].pop();
  if (!alter) throw new Error(`${file} 里有一条 ${kind} 找不到所属 ALTER TABLE —— 解析器需扩展`);
  return alter[1];
}

/**
 * 源A —— 把全部迁移「跑完之后的结构」推演出来。
 *
 * 读 `.ts` 与 `.js` 两种（dev 走 `src/*.ts`、生产 `dist/*.js`，同 #72 的双匹配口径）；
 * 并把 `` \` `` 还原成 `` ` `` —— 模板字面量里的反引号在**源码文本**里带转义，两种形态都要能读。
 */
export function migrationSchema(): { schema: Schema; stats: { tables: number; columns: number } } {
  const files = readdirSync(MIGRATION_DIR)
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();
  if (files.length === 0) throw new Error(`迁移目录里一个文件都没有：${MIGRATION_DIR}`);

  const schema: Schema = new Map();

  for (const f of files) {
    // 顺序：还原模板字面量里的反引号 → 剥注释 → 只取 up 作用域。三者都必须在解析之前。
    const scope = upScope(
      stripComments(readFileSync(join(MIGRATION_DIR, f), 'utf8')).replace(/\\`/g, '`'),
      f,
    );

    // ⚠️ 计数器**必须按文件重置**：上一版写在外层作用域，导致第二支迁移的自检拿「本文件源码条数」
    // 去比「全部文件累计解析条数」（本文件 2 张表 → 报 27）而误报。自检的第一受益者是自己。
    let createSeen = 0;
    let addSeen = 0;
    let modifySeen = 0;

    for (const { pat, label } of UNSUPPORTED_IN_MIGRATION) {
      if (pat.test(scope)) {
        throw new Error(
          `${f} 的 up 作用域里出现本解析器尚未支持的语句形态「${label}」—— 请先扩展 ` +
            `schema-parity.ts 的解析，不要让它静默跳过（跳过 = 假绿）`,
        );
      }
    }

    // ---- CREATE TABLE ----
    for (const m of scope.matchAll(CREATE_TABLE_RE)) {
      createSeen += 1;
      const table = m[1];
      const cols = schema.get(table) ?? new Map<string, ColumnShape>();
      for (const line of m[2].split('\n')) {
        const st = line.trim();
        if (!st || INDEX_LINE_RE.test(st)) continue;
        // 一行可能写多列（`id` …, `user_id` …）→ 按逗号切段，每段只看第一个列名
        for (const seg of st.split(',')) {
          const cd = COLUMN_DEF_RE.exec(seg.trim());
          if (cd) cols.set(cd[1], { type: normType(cd[2]) });
        }
      }
      schema.set(table, cols);
    }

    // ---- ADD COLUMN（增量迁移）----
    for (const m of scope.matchAll(ADD_COLUMN_RE)) {
      addSeen += 1;
      const table = tableOfStatement(scope, f, 'ADD COLUMN', m.index);
      const cols = schema.get(table) ?? new Map<string, ColumnShape>();
      cols.set(m[1], { type: normType(m[2]) });
      schema.set(table, cols);
    }

    // ---- MODIFY COLUMN（改形态，如注释对齐时顺带写的类型）----
    for (const m of scope.matchAll(MODIFY_COLUMN_RE)) {
      modifySeen += 1;
      const table = tableOfStatement(scope, f, 'MODIFY COLUMN', m.index);
      const cols = schema.get(table);
      // 只更新「两侧都认识的列」的形态；MODIFY 不该凭空造列（凭空造列 = 迁移写错了，让缺列检查去报）
      const existing = cols?.get(m[1]);
      if (existing) existing.type = normType(m[2]);
    }

    // ---- 解析器完备性自检：源码里出现的次数必须与解析到的条数相等 ----
    const createCount = (scope.match(/CREATE TABLE IF NOT EXISTS/gi) ?? []).length;
    const addCount = (scope.match(/ADD COLUMN/gi) ?? []).length;
    const modifyCount = (scope.match(/MODIFY COLUMN/gi) ?? []).length;
    if (createCount !== createSeen || addCount !== addSeen || modifyCount !== modifySeen) {
      throw new Error(
        `${f} 解析条数不符：CREATE TABLE 源码 ${createCount} / 解析 ${createSeen}，` +
          `ADD COLUMN 源码 ${addCount} / 解析 ${addSeen}，` +
          `MODIFY COLUMN 源码 ${modifyCount} / 解析 ${modifySeen} —— 有语句被漏读，先修解析器`,
      );
    }
  }

  let columns = 0;
  for (const cols of schema.values()) columns += cols.size;
  return { schema, stats: { tables: schema.size, columns } };
}

/**
 * 源B —— 让 TypeORM 用 `ALL_ENTITIES` 在**内存 sqlite** 上真建一次表，再读回结构。
 *
 * ⚠️ 必须先置 `DB_DRIVER=sqlite` 再**动态导入**实体：`PkColumn()`（`transformers.ts`）在
 * **装饰器求值期**就读 `process.env.DB_DRIVER` 来决定主键列类型（sqlite → `integer`、
 * mysql → `bigint`）。若用静态 `import`，实体模块会先于赋值被加载 → 主键按 `bigint` 生成
 * `bigint PRIMARY KEY AUTOINCREMENT` → SQLite 直接报 `AUTOINCREMENT is only allowed on an
 * INTEGER PRIMARY KEY`。故这里刻意「先赋 env，后 await import」，且**强制** sqlite
 * （本检查本身与「当前环境想连哪个库」无关）。
 *
 * 用 `:memory:` 且不经 `data-source.ts`：既不会碰到本地开发库，也不依赖任何环境变量。
 */
export async function entitySchema(): Promise<{
  schema: Schema;
  stats: { tables: number; columns: number };
}> {
  process.env.DB_DRIVER = 'sqlite';
  const { ALL_ENTITIES } = await import('./entities');

  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ALL_ENTITIES,
    synchronize: true,
  });
  await ds.initialize();
  try {
    const qr = ds.createQueryRunner();
    const tables = await qr.getTables();
    const schema: Schema = new Map();
    for (const t of tables) {
      if (!t.name.startsWith('ab_')) continue; // 只比业务表
      const cols = new Map<string, ColumnShape>();
      for (const c of t.columns) {
        // 主键列标记出来：`PkColumn()` **刻意按驱动分派类型**（sqlite→`integer` / mysql→`bigint`），
        // 故主键的类型差异是**设计**而非缺陷 —— 见 diffSchemas 里的豁免。
        const pk = t.primaryColumns.some((pc) => pc.name === c.name);
        cols.set(c.name, { type: normType(c.type), pk });
      }
      schema.set(t.name, cols);
    }
    let columns = 0;
    for (const cols of schema.values()) columns += cols.size;
    return { schema, stats: { tables: schema.size, columns } };
  } finally {
    await ds.destroy();
  }
}

type Diff = {
  /** 实体有、迁移无 —— 生产会 `Table doesn't exist` / `Unknown column`（#76 形态，**必须为零**） */
  missingInMigration: { table: string; column: string; type: string }[];
  missingTables: string[];
  /** 两侧都有但类型族不同 —— 生产会静默截断/比较错（**必须为零**） */
  typeMismatch: { table: string; column: string; migration: string; entity: string }[];
  /** 迁移有、实体无 —— 历史字段等，**仅打印不判红** */
  extraInMigration: { table: string; column: string }[];
};

export function diffSchemas(mig: Schema, ent: Schema): Diff {
  const d: Diff = {
    missingInMigration: [],
    missingTables: [],
    typeMismatch: [],
    extraInMigration: [],
  };
  for (const [table, ecols] of ent) {
    const mcols = mig.get(table);
    if (!mcols) {
      d.missingTables.push(table);
      continue;
    }
    for (const [col, shape] of ecols) {
      const m = mcols.get(col);
      if (!m) d.missingInMigration.push({ table, column: col, type: shape.type });
      // 主键不做类型比较：`PkColumn()` 按驱动给出 `integer`(sqlite) / `bigint`(mysql)，是刻意分派
      // （`transformers.ts`：SQLite 的 AUTOINCREMENT 只能挂 INTEGER PRIMARY KEY）。非主键才比。
      else if (m.type !== shape.type && !shape.pk)
        d.typeMismatch.push({ table, column: col, migration: m.type, entity: shape.type });
    }
    for (const col of mcols.keys())
      if (!ecols.has(col)) d.extraInMigration.push({ table, column: col });
  }
  return d;
}

function blockingCount(d: Diff): number {
  return d.missingTables.length + d.missingInMigration.length + d.typeMismatch.length;
}

/**
 * 自证能力 —— 人为制造一个已知缺口，确认它**一定报得出来**。
 * 返回失败原因数组（空数组 = 自检通过）。
 */
function selfTest(mig: Schema, ent: Schema): string[] {
  const problems: string[] = [];
  // 挑一个「两侧都有」的列，从源A 的深拷贝里删掉
  let victim: { table: string; column: string } | null = null;
  for (const [table, ecols] of ent) {
    const mcols = mig.get(table);
    if (!mcols) continue;
    for (const col of ecols.keys()) {
      if (mcols.has(col)) {
        victim = { table, column: col };
        break;
      }
    }
    if (victim) break;
  }
  if (!victim) return ['自检无法执行：实体与迁移没有任何同名表列 —— 对账器已失去对照面'];

  const cloned: Schema = new Map([...mig].map(([t, cols]) => [t, new Map(cols)]));
  cloned.get(victim.table)?.delete(victim.column);
  const d = diffSchemas(cloned, ent);
  const hit = d.missingInMigration.some(
    (x) => x.table === victim.table && x.column === victim.column,
  );
  if (!hit) {
    problems.push(
      `自检失败：人为删掉 \`${victim.table}\`.${victim.column} 后，对账器**没有报出**该列缺失` +
        ` —— 这个检查是恒绿的，等于不存在`,
    );
  }
  // 反向自检：把整张表删掉，必须报出「缺表」
  const firstTable = [...ent.keys()].find((t) => mig.has(t));
  if (firstTable) {
    const cloned2: Schema = new Map([...mig].map(([t, cols]) => [t, new Map(cols)]));
    cloned2.delete(firstTable);
    const d2 = diffSchemas(cloned2, ent);
    if (!d2.missingTables.includes(firstTable)) {
      problems.push(`自检失败：人为删掉整张表 \`${firstTable}\` 后，对账器没有报出「缺表」`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const mig = migrationSchema();
  const ent = await entitySchema();
  const d = diffSchemas(mig.schema, ent.schema);

  console.log('schema-parity —— 迁移 ↔ 实体 结构对账');
  console.log(`  源A 迁移推演：${mig.stats.tables} 表 / ${mig.stats.columns} 列`);
  console.log(
    `  源B 实体真库：${ent.stats.tables} 表 / ${ent.stats.columns} 列（内存 sqlite · synchronize 真建表）`,
  );
  console.log();

  const selfProblems = selfTest(mig.schema, ent.schema);
  console.log(
    selfProblems.length === 0 ? '✔ 自检：对账器确实能报出人为制造的缺口' : '✘ 自检未通过',
  );
  for (const p of selfProblems) console.log(`   ${p}`);
  console.log();

  if (d.missingTables.length) {
    console.log(`✘ 迁移缺整表（${d.missingTables.length}）：生产首迁后这些表不存在`);
    for (const t of d.missingTables) console.log(`   - ${t}`);
    console.log();
  }
  if (d.missingInMigration.length) {
    console.log(
      `✘ 迁移缺列（${d.missingInMigration.length}）：生产上该表任何查询都会 Unknown column`,
    );
    for (const x of d.missingInMigration) console.log(`   - ${x.table}.${x.column}  (${x.type})`);
    console.log();
  }
  if (d.typeMismatch.length) {
    console.log(`✘ 类型族不一致（${d.typeMismatch.length}）：`);
    for (const x of d.typeMismatch)
      console.log(`   - ${x.table}.${x.column}  迁移=${x.migration} 实体=${x.entity}`);
    console.log();
  }
  if (d.extraInMigration.length) {
    console.log(
      `ℹ 迁移比实体多出的列（${d.extraInMigration.length}）—— 历史字段刻意保留列属项目约定，仅提示：`,
    );
    for (const x of d.extraInMigration) console.log(`   · ${x.table}.${x.column}`);
    console.log();
  }

  const bad = blockingCount(d);
  if (selfProblems.length || bad > 0) {
    console.log(`✘ schema-parity 未通过：${bad} 处结构差异 + ${selfProblems.length} 处自检失败`);
    console.log(
      '  处理办法：结构差异改**迁移**（不改实体）—— 生产结构只由迁移决定；' +
        '若实体确实要删列，请把它登记为历史字段并保留列。',
    );
    process.exit(1);
  }
  console.log(`✔ 结构一致：${ent.stats.tables} 表 / ${ent.stats.columns} 列，迁移与实体逐列对齐`);
}

// 被 import 时（单测 / 复用）不自动执行
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('✖ schema-parity 执行失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
