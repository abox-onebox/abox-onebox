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

/**
 * `PROVIDER_MODE` 的默认值 —— **按环境分岔，绝不能写死 `'mock'`**
 *
 * ⚠️ 这里曾是一处真缺陷：默认值恒为 `'mock'`。生产若漏配 `PROVIDER_MODE`，
 *    服务会以「**任意 code 免密登录任意身份** + **支付自动置为已支付**」的形态跑起来，
 *    而且**服务照常起、接口照常通、健康检查照常绿、没有任何报错**
 *    —— 典型的「做完了，但生产一跑就出事，且没有任何症状」。
 *
 * 所以分岔：
 *   · 非生产 → `mock`：本地零依赖开发与 e2e 全链路都依赖它，**不能动**；
 *   · 生产   → `real`：漏配时去连真实微信通道，会**响亮失败**，
 *              而不是静默放行免密登录与自动支付。
 *
 * 另有第二道保险：`main.ts` 的 `REQUIRED_IN_PROD` 要求生产**显式配置**本变量
 * （漏配即启动中止），两道一起才把这个口子堵住。
 */
const DEFAULT_PROVIDER_MODE: ProviderMode = process.env.NODE_ENV === 'production' ? 'real' : 'mock';

export interface AppConfig {
  env: string;
  /**
   * 构建版本（部署时由镜像构建注入 git sha）
   *
   * 为什么必须进配置而不是散读 `process.env`：灰度与回滚的验收判据是
   * 「现在的容器跑的是哪个版本」，而 `GET /health/ready` 会把它回显出来 ——
   * 探针是唯一不需要登录就能问「你跑的是哪一版」的入口。
   * 缺省 `dev` 表示「没人注入过」，本身就是有效信息（本地直跑）。
   */
  version: string;
  port: number;
  baseUrl: string;
  apiPrefix: string;
  /**
   * CORS 允许来源（逗号分隔 · M5-7 加固）
   *
   * 空字符串 = **未配置**，由 `main.ts` 按环境决定：开发放行（本地各端口组合不必逐个登记）、
   * 生产**一律不跨域**（同源部署不受影响）。生产要开跨域就显式列出域名。
   */
  corsOrigins: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  /** 后台访问令牌有效期（比小程序的 7d 短得多 —— 后台是高权限面） */
  adminJwtExpiresIn: string;
  /** 后台刷新令牌有效期（与小程序 refresh 同量级） */
  adminRefreshExpiresIn: string;
  /** 后台连续登录失败锁定阈值（次） */
  adminLoginMaxAttempts: number;
  /** 后台登录锁定时长（秒） */
  adminLoginLockSeconds: number;
  drivers: {
    db: DbDriver;
    queue: QueueDriver;
    storage: StorageDriver;
    providerMode: ProviderMode;
  };
  /** 定时任务 / 队列消费者总开关（开发期可关，避免无意义跑批） */
  tasksEnabled: boolean;
  /**
   * 队列重试参数（M4-3）
   *
   * 两驱动（redis / memory）共用同一组数字，语义对齐：
   * 失败重试 `attempts` 次，退避 `backoffBaseMs * 2^(attempt-1)`。
   * e2e 通过 `QUEUE_BACKOFF_BASE_MS=20` 把退避压到毫秒级，否则验证重试要真等好几秒。
   */
  queue: {
    attempts: number;
    backoffBaseMs: number;
    /** redis 驱动的 Worker 并发（memory 驱动为串行泵，不受此项影响） */
    concurrency: number;
  };
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
  version: str(process.env.APP_VERSION, 'dev'),
  port: num(process.env.APP_PORT, 3000),
  baseUrl: str(process.env.APP_BASE_URL, 'http://localhost:3000'),
  apiPrefix: str(process.env.API_PREFIX, '/api/v1'),
  corsOrigins: str(process.env.CORS_ORIGINS, ''),
  // 生产环境缺失即**启动失败**（见 `main.ts` 的 `assertProdSecrets`）；
  // 此处仅为**开发**默认值，它永远到不了生产，故不构成「带病上线」风险。
  // security-scan:allow（理由见上两行 · 标记必须紧邻，勿与代码行隔开）
  jwtSecret: str(process.env.JWT_SECRET, 'change_me_before_go_live'),
  jwtExpiresIn: str(process.env.JWT_EXPIRES_IN, '7d'),
  adminJwtExpiresIn: str(process.env.ADMIN_JWT_EXPIRES_IN, '12h'),
  adminRefreshExpiresIn: str(process.env.ADMIN_REFRESH_EXPIRES_IN, '7d'),
  adminLoginMaxAttempts: num(process.env.ADMIN_LOGIN_MAX_ATTEMPTS, 5),
  adminLoginLockSeconds: num(process.env.ADMIN_LOGIN_LOCK_SECONDS, 900),
  drivers: {
    db: str(process.env.DB_DRIVER, 'mysql') as DbDriver,
    queue: str(process.env.QUEUE_DRIVER, 'redis') as QueueDriver,
    storage: str(process.env.STORAGE_DRIVER, 'local') as StorageDriver,
    providerMode: str(process.env.PROVIDER_MODE, DEFAULT_PROVIDER_MODE) as ProviderMode,
  },
  tasksEnabled: bool(process.env.TASKS_ENABLED, true),
  queue: {
    attempts: num(process.env.QUEUE_ATTEMPTS, 3),
    backoffBaseMs: num(process.env.QUEUE_BACKOFF_BASE_MS, 1000),
    concurrency: num(process.env.QUEUE_CONCURRENCY, 2),
  },
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
    providerMode: str(process.env.PROVIDER_MODE, DEFAULT_PROVIDER_MODE) as ProviderMode,
  };
}
