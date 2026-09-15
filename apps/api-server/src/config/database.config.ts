import { registerAs } from '@nestjs/config';
import { join } from 'path';

/**
 * 数据库配置
 *   约束：金额 DECIMAL(10,2) · 时间 DATETIME(3) UTC+8 · 表名前缀 ab_
 *   mysql  —— 生产 / 云端（连接 docker-compose 的 mysql:8.0 或云数据库）
 *   sqlite —— 本地零依赖（无需 Docker，开发期 synchronize 自动建表）
 */
export interface MysqlConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  synchronize: boolean;
}
export interface SqliteConfig {
  path: string;
  /** 开发期由 Entity 自动建表（免迁移）；生产恒为 false */
  synchronize: boolean;
}
export interface DatabaseConfig {
  driver: 'mysql' | 'sqlite';
  mysql: MysqlConfig;
  sqlite: SqliteConfig;
}

const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v === '' ? fallback : v === 'true' || v === '1';

export default registerAs('database', (): DatabaseConfig => {
  const driver = (process.env.DB_DRIVER ?? 'mysql') as 'mysql' | 'sqlite';
  const rawPath = process.env.SQLITE_PATH ?? './data/abox-dev.sqlite';

  return {
    driver,
    mysql: {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      username: process.env.DB_USER ?? 'root',
      password: process.env.DB_PASSWORD ?? 'root123',
      database: process.env.DB_DATABASE ?? 'abox_onebox',
      synchronize: bool(process.env.DB_SYNCHRONIZE, false),
    },
    sqlite: {
      // 相对路径按「仓库根」解析，保证从 apps/api-server 启动也能落到同一个文件
      path: rawPath.startsWith('.') ? join(process.cwd(), '..', '..', rawPath) : rawPath,
      synchronize: true,
    },
  };
});
