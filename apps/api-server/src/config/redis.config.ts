import { registerAs } from '@nestjs/config';

/**
 * Redis / 队列配置
 *   redis  —— 生产 / 云端（BullMQ 队列 + 定时任务锁 + 缓存）
 *   memory —— 本地零依赖（进程内队列，重启即丢，仅开发期）
 */
export interface RedisConfig {
  driver: 'redis' | 'memory';
  host: string;
  port: number;
  password?: string;
  db: number;
}

export default registerAs('redis', (): RedisConfig => ({
  driver: (process.env.QUEUE_DRIVER ?? 'redis') as 'redis' | 'memory',
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB ?? 0),
}));
