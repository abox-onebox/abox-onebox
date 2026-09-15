import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { join, resolve } from 'path';
import { DataSource, DataSourceOptions, LogLevel } from 'typeorm';

import { ALL_ENTITIES } from './entities';

/**
 * ⚠️ 必须与 Nest 侧 `ConfigModule.envFilePath` 保持同一顺序，否则会出现
 *    「服务能起来、但 db:seed / db:migrate 读不到同一个 .env」的诡异问题。
 *    `import 'dotenv/config'` 只加载 `cwd/.env`，读不到仓库根 .env —— 故此处显式两段加载。
 *    先加载者优先（dotenv 默认不覆盖已存在的变量）。
 */
loadDotenv({ path: resolve(process.cwd(), '.env') });
loadDotenv({ path: resolve(process.cwd(), '../../.env') });

/**
 * TypeORM DataSource（供 CLI 迁移 / 种子使用，非 Nest DI 场景）
 *
 * 支持双驱动：
 *   DB_DRIVER=mysql  → 生产结构，由 migration 管理（synchronize 恒 false）
 *   DB_DRIVER=sqlite → 本地零依赖，开发期可直接用 Nest 的 synchronize 建表
 *
 * 约束：金额 DECIMAL(10,2)；时间 DATETIME(3) · UTC+8；表名前缀 ab_
 */
const driver = process.env.DB_DRIVER ?? 'mysql';
const repoRoot = resolve(__dirname, '../../../..');

const sqlitePath = process.env.SQLITE_PATH ?? './data/abox-dev.sqlite';
const sqliteDb = sqlitePath.startsWith('.') ? join(repoRoot, sqlitePath) : sqlitePath;

/** 日志级别需为可变数组：`as const` 会推出 readonly 元组，赋给 LogLevel[] 会报 TS2322 */
const LOG_LEVELS: LogLevel[] = ['error', 'warn'];

const baseOptions = {
  entities: ALL_ENTITIES,
  migrations: [join(__dirname, 'migrations/*.ts')],
  // sqlite = 本地零依赖开发模式：直接由实体同步建表（无需跑 MySQL 专用 DDL 迁移）
  // mysql  = 结构由 migration 管理，synchronize 恒 false
  synchronize: driver === 'sqlite',
  logging: LOG_LEVELS,
};

const options: DataSourceOptions =
  driver === 'sqlite'
    ? {
        type: 'better-sqlite3',
        database: sqliteDb,
        ...baseOptions,
      }
    : {
        type: 'mysql',
        host: process.env.DB_HOST ?? '127.0.0.1',
        port: Number(process.env.DB_PORT ?? 3306),
        username: process.env.DB_USER ?? 'root',
        password: process.env.DB_PASSWORD ?? 'root123',
        database: process.env.DB_DATABASE ?? 'abox_onebox',
        charset: 'utf8mb4',
        timezone: '+08:00',
        ...baseOptions,
      };

export default new DataSource(options);
