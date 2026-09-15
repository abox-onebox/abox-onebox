import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';

import { ALL_ENTITIES } from './entities';

/**
 * 数据库模块
 *
 * 按 DB_DRIVER 分派（本地零依赖 ↔ 生产）：
 *   mysql  —— 类型严格、synchronize=false，结构由 migration 管理
 *   sqlite —— 开发期 synchronize=true，启动即自动建表，无需 Docker
 *
 * 跨库注意：Entity 仅使用两种驱动共有的类型（bigint / varchar / decimal / datetime / json / tinyint），
 *          MySQL 专属的 UNSIGNED、分区、字符集等只在 migration SQL 中体现。
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): TypeOrmModuleOptions => {
        const driver = cfg.get<string>('app.drivers.db') ?? 'mysql';

        if (driver === 'sqlite') {
          return {
            type: 'better-sqlite3',
            database: cfg.get<string>('database.sqlite.path'),
            entities: ALL_ENTITIES,
            synchronize: true,
            logging: ['error', 'warn'],
          } as TypeOrmModuleOptions;
        }

        return {
          type: 'mysql',
          host: cfg.get<string>('database.mysql.host'),
          port: cfg.get<number>('database.mysql.port'),
          username: cfg.get<string>('database.mysql.username'),
          password: cfg.get<string>('database.mysql.password'),
          database: cfg.get<string>('database.mysql.database'),
          charset: 'utf8mb4',
          timezone: '+08:00',
          entities: ALL_ENTITIES,
          synchronize: cfg.get<boolean>('database.mysql.synchronize') ?? false,
          logging: ['error', 'warn'],
        } as TypeOrmModuleOptions;
      },
    }),
  ],
})
export class DatabaseModule {}
