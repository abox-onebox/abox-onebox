import { registerAs } from '@nestjs/config';

/**
 * 应用配置
 *
 * 【驱动开关】—— 本地零依赖开发 ↔ 云端生产，只改环境变量，不改代码：
 *   DB_DRIVER      mysql | sqlite        —— 无 Docker 也能本地跑（sqlite 自动建表）
 *   QUEUE_DRIVER   redis | memory        —— 无 Redis 也能本地跑（进程内队列）
 *   STORAGE_DRIVER cos | minio | local   —— 无 COS 也能本地跑（落本地磁盘）
 *   PROVIDER_MODE  mock | real           —— 无微信/灵活用工账号也能跑通全链路
 */
export type DbDriver = 'mysql' | 'sqlite';
export type QueueDriver = 'redis' | 'memory';
export type StorageDriver = 'cos' | 'minio' | 'local';
export type ProviderMode = 'mock' | 'real';

export interface AppConfig {
  env: string;
  port: number;
  baseUrl: string;
  apiPrefix: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  drivers: {
    db: DbDriver;
    queue: QueueDriver;
    storage: StorageDriver;
    providerMode: ProviderMode;
  };
  /** 定时任务 / 队列消费者总开关（开发期可关，避免无意义跑批） */
  tasksEnabled: boolean;
  /** Mock 行为参数（PROVIDER_MODE=mock 时生效） */
  mock: {
    wxOpenidPrefix: string;
    payAutoSuccess: boolean;
    payCallbackDelayMs: number;
  };
}

const str = (v: string | undefined, fallback: string): string =>
  v && v.trim().length ? v.trim() : fallback;
const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v === '' ? fallback : v === 'true' || v === '1';

export default registerAs('app', (): AppConfig => ({
  env: str(process.env.NODE_ENV, 'development'),
  port: num(process.env.APP_PORT, 3000),
  baseUrl: str(process.env.APP_BASE_URL, 'http://localhost:3000'),
  apiPrefix: str(process.env.API_PREFIX, '/api/v1'),
  jwtSecret: str(process.env.JWT_SECRET, 'change_me_before_go_live'),
  jwtExpiresIn: str(process.env.JWT_EXPIRES_IN, '7d'),
  drivers: {
    db: str(process.env.DB_DRIVER, 'mysql') as DbDriver,
    queue: str(process.env.QUEUE_DRIVER, 'redis') as QueueDriver,
    storage: str(process.env.STORAGE_DRIVER, 'local') as StorageDriver,
    providerMode: str(process.env.PROVIDER_MODE, 'mock') as ProviderMode,
  },
  tasksEnabled: bool(process.env.TASKS_ENABLED, true),
  mock: {
    wxOpenidPrefix: str(process.env.MOCK_WX_OPENID_PREFIX, 'mock_openid_'),
    payAutoSuccess: bool(process.env.MOCK_PAY_AUTO_SUCCESS, true),
    payCallbackDelayMs: num(process.env.MOCK_PAY_CALLBACK_DELAY_MS, 800),
  },
}));

/** 便利：从 process.env 直接取驱动开关（data-source.ts 等非 DI 场景用） */
export function readDrivers() {
  return {
    db: str(process.env.DB_DRIVER, 'mysql') as DbDriver,
    queue: str(process.env.QUEUE_DRIVER, 'redis') as QueueDriver,
    storage: str(process.env.STORAGE_DRIVER, 'local') as StorageDriver,
    providerMode: str(process.env.PROVIDER_MODE, 'mock') as ProviderMode,
  };
}
