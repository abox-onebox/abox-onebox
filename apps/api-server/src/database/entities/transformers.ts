import { PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';

/**
 * BIGINT 读取转换器
 *
 * 背景：MySQL 驱动为保证精度，把 BIGINT 以**字符串**返回；而 SQLite 返回 number。
 * 若不做统一，业务代码会同时面对 string | number，极易出现 `'1' !== 1` 之类的隐蔽 bug。
 * 本转换器统一转成 number（MVP 体量下 ID 远小于 Number.MAX_SAFE_INTEGER，安全）。
 */
export const bigintTransformer: ValueTransformer = {
  to: (value: unknown) => value,
  from: (value: unknown) => (value === null || value === undefined ? value : Number(value)),
};

/**
 * DECIMAL 读取转换器（归一化为**两位小数定长字符串**）
 *
 * 背景：同一个 `DECIMAL(10,2)` 列，两个驱动读出来不一样：
 *   · MySQL 驱动 → string，如  "25.80"、"0.00"
 *   · SQLite(NUMERIC 亲和) → number，如 25.8、0
 * 若不统一，`'25.80' === row.price` 这类金额校验在本地必然误判，
 * 且前端展示会出现 25.8 而非 25.80 的价格（C1 定价口径）。
 *
 * 策略：写入原样透传（交给数据库做精度控制），读取统一 `toFixed(scale)` 为字符串。
 * scale 由列定义决定，默认 2（金额列）。费率列（scale 4）请显式传入 4。
 */
export function decimalTransformer(scale = 2): ValueTransformer {
  return {
    to: (value: unknown) => value,
    from: (value: unknown) => {
      if (value === null || value === undefined || value === '') return value;
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(scale) : value;
    },
  };
}

/** 金额专用（scale=2），对应 DECIMAL(x,2) 的绝大多数列 */
export const moneyTransformer: ValueTransformer = decimalTransformer(2);

/** 费率专用（scale=4），对应 DECIMAL(x,4) 的列 */
export const rateTransformer: ValueTransformer = decimalTransformer(4);

/** 经纬度专用（scale=6），对应 DECIMAL(x,6) 的列 */
export const coordTransformer: ValueTransformer = decimalTransformer(6);

/**
 * 当前是否 SQLite 驱动
 *
 * ⚠️ 必须在 dotenv 之后调用：本值在**模块加载期**（装饰器求值时）就被读取，
 *    故入口（main.ts / data-source.ts）首行必须是 `import 'dotenv/config'`。
 */
export const isSqliteDriver = (): boolean => (process.env.DB_DRIVER ?? 'mysql') === 'sqlite';

/**
 * 自增主键列（跨库兼容）
 *
 * 坑：SQLite 规定 `AUTOINCREMENT` 只能挂在 **INTEGER PRIMARY KEY** 上。
 *     若实体统一写 `@PrimaryGeneratedColumn({ type: 'bigint' })`，
 *     SQLite 侧会生成 `bigint PRIMARY KEY AUTOINCREMENT` → SQLITE_ERROR。
 *     而 MySQL 侧确实需要 bigint（对齐已评审的 DDL）。
 *
 * 故按驱动分派：
 *   sqlite → integer（SQLite 的 rowid 本质是 64 位整数，容量无忧）
 *   mysql  → bigint + bigintTransformer（保持 DDL 口径与读取类型一致）
 */
/**
 * MySQL 侧主键选项。
 * 单独抽成常量（非内联字面量）以绕开 TS 对字面量的「多余属性检查」：
 * `transformer` 属于 ColumnOptions、不在 PrimaryGeneratedColumnNumericOptions 声明里，
 * 但 TypeORM 运行时会把它透传给 ColumnMetadata，故实际有效。
 */
const MYSQL_PK_OPTIONS = { type: 'bigint' as const, transformer: bigintTransformer };

export const PkColumn = (): PropertyDecorator =>
  isSqliteDriver()
    ? PrimaryGeneratedColumn({ type: 'integer' })
    : PrimaryGeneratedColumn(MYSQL_PK_OPTIONS);
