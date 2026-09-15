import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import appConfig from './app.config';
import databaseConfig from './database.config';
import redisConfig from './redis.config';
import storageConfig from './storage.config';
import wechatConfig from './wechat.config';

/**
 * 全局配置模块 —— 配置的唯一加载入口
 * 读取顺序：apps/api-server/.env → 仓库根 .env（后者兜底）
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      load: [appConfig, databaseConfig, redisConfig, storageConfig, wechatConfig],
      cache: true,
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}
