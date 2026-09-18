// 必须最先执行：Entity 的列类型在「模块加载期」就依赖 process.env.DB_DRIVER
// （见 entities/transformers.ts 的 PkColumn），晚于 AppModule 加载就会读到默认值。
import 'dotenv/config';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { resolve } from 'path';

import { AppModule } from './app.module';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { clockShiftMs, isClockShifted, now, toBjIso } from './common/utils/time';

/**
 * 生产环境「密钥必配」体检（M5-7 · 缺陷 #83 收口）
 *
 * ## 为什么要有它
 *
 * `app.config.ts` 给 `jwtSecret` 留了兜底值 `'change_me_before_go_live'`。
 * 开发期这是便利，**生产期是事故**：漏配一个环境变量，就变成「任何人都能用
 * 这个公开字符串自签一个超管 token」。而且它**不会自愈** —— 漏配一天就危险一天。
 *
 * ## 为什么是「启动失败」而不是打一条 WARN
 *
 * 因为 WARN 会被忽略。这类配置错误在运行期没有任何可见症状（服务照常起、
 * 接口照常通），只有被人拿到密钥才暴露 —— 典型的「代价不对称」：
 * 起不来的代价是运维5分钟；起得来的代价可能是全部数据。
 *
 * ## 清单
 *
 * 只放**无条件下必然需要**的项。按驱动条件才需要的密钥（如 `MINIO_SECRET_KEY`
 * 仅在 `STORAGE_DRIVER=minio` 时）不放这里 —— 误判「没配就退出」比漏判更糟，
 * 会让运维学会「随便塞个值绕过」。
 */
const REQUIRED_IN_PROD = ['JWT_SECRET'] as const;

function assertProdSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = REQUIRED_IN_PROD.filter((k) => !process.env[k]?.trim());
  if (!missing.length) return;
  Logger.error(
    `启动中止：生产环境必须显式配置 ${missing.join(' / ')}。` +
      '这些值有内置默认值，漏配的后果是「用公开字符串签发管理员令牌」，且不会随时间减轻。' +
      '宁可起不来，不可带着公开密钥上线。',
    'Bootstrap',
  );
  process.exit(1);
}

/**
 * 基础安全响应头（M5-7 加固 · 报告 §二 P2-3）
 *
 * ⚠️ **为什么不装 helmet**：本仓库环境装不了新依赖（`pnpm` 不可用，见项目纪律），
 *    而这几条纯 Express 就能给。完整 CSP / HSTS 待引入 helmet 后补（已登记待办）。
 * ⚠️ **为什么可以放在 `init()` 之前**：与限流不同，它**不读请求体** ——
 *    `app.use()` 排在路由前后对它没有影响（`requestIdMiddleware` 同理）。
 */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/**
 * CORS 白名单解析（M5-7 加固 · 报告 §二 P2-3）
 *
 * 旧写法是 `NestFactory.create(..., { cors: true })` —— 那等于**反射任意 Origin**：
 * 任何站点都能让受害者的浏览器带着自己的 token 打本 API（且响应可读）。
 *
 * 新口径（**默认拒绝，按需开口**）：
 *   · 配了 `CORS_ORIGINS`（逗号分隔）→ 严格白名单；
 *   · 未配 + 非生产 → 放行（本地 `local-test` / Vite 组合端口不必逐个登记）；
 *   · 未配 + 生产 → **不允许任何跨域**（同源部署不受影响，这也是推荐形态）。
 */
function corsOriginOf(cfg: ConfigService): string[] | boolean {
  const list = (cfg.get<string>('app.corsOrigins') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length) return list;
  return cfg.get<string>('app.env') === 'production' ? false : true;
}

async function bootstrap() {
  assertProdSecrets();

  // rawBody: 微信支付 V3 回调需用**原始报文**验签（/pay/notify）
  // ⚠️ 这里**不再传 `cors` 选项** —— 见 `corsOriginOf`：要在读到配置之后再决定，
  //    故改为下面的 `enableCors()`（顺序上仍早于 `listen`）。
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.disable('x-powered-by');

  /**
   * 优雅关闭（M5-0）
   *
   * ⚠️ 必须显式开启：Nest **默认不监听进程信号**。不调用它时，容器收到
   *    SIGTERM / SIGINT（`docker stop`、滚动更新、K8s 驱逐）会**直接退出**，
   *    于是 `KvService.onModuleDestroy` 与 `QueueService.onModuleDestroy`
   *    （关闭 Redis 连接 / 排空队列 backend）**永远不会执行** ——
   *    代码看起来写了关闭逻辑，实际一次都没跑过。
   *
   * 关掉 `SIGTERM` 期间的「半截任务」风险：关闭钩子会等在途请求结束，
   * 而跑批是 `@Cron` 触发的独立流程（不在此列）—— 故**滚动更新仍须避开禁发窗口**，
   * 见《ABox一盒部署运维手册v1.0.md》§6。
   */
  app.enableShutdownHooks();

  const cfg = app.get(ConfigService);

  // 请求链路 ID（《接口规范》§1.2）：优先沿用 X-Request-Id，缺省服务端生成
  app.use(requestIdMiddleware);
  app.use(securityHeaders);

  const corsOrigin = corsOriginOf(cfg);
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
    // 端上要读 `X-Request-Id`（报障时贴给技术），故必须显式暴露
    exposedHeaders: ['X-Request-Id'],
  });
  if (Array.isArray(corsOrigin)) {
    Logger.log(`CORS 白名单：${corsOrigin.join(' · ')}`, 'Bootstrap');
  } else if (corsOrigin === true) {
    Logger.warn('CORS 未配白名单且非生产环境：当前放行任意来源（生产将默认不跨域）', 'Bootstrap');
  }

  const prefix = cfg.get<string>('app.apiPrefix') ?? '/api/v1';
  app.setGlobalPrefix(prefix);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // STORAGE_DRIVER=local 时暴露本地静态目录，供图片直链访问
  if (cfg.get<string>('app.drivers.storage') === 'local') {
    const rawDir = cfg.get<string>('storage.local.dir') ?? './data/uploads';
    const dir = resolve(process.cwd(), '..', '..', rawDir);
    app.useStaticAssets(dir, { prefix: '/static/' });
    Logger.log(`静态目录已挂载：/static/ → ${dir}`, 'Bootstrap');
  }

  // Swagger（开发期 /docs）
  const config = new DocumentBuilder()
    .setTitle('ABox 一盒 · API')
    .setDescription('办公楼白领团餐平台接口 —— 契约见 docs/ABox一盒接口规范v1.0.md')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  /**
   * ⚠️ 限流中间件**不在这里注册**（M5-6）
   *
   * 曾在此处写 `await app.init(); app.use(createRateLimitMiddleware(...))`，结果是
   * **中间件一次都没执行**：`app.use()` 只能往 Express 栈尾追加，而 `init()` 已经把
   * 路由挂完了 → 限流排到路由之后 → 请求早在控制器里被处理掉。它「看起来对」
   * （编译过、启动无警告、日志无异常），只有真发请求才会暴露。
   * 现改为 `AppModule.configure()` 注册（那里夹在 body-parser 与路由之间）。
   * 完整原因与验证方式见 `app.module.ts` 的 `configure()` 注释。
   */

  const port = cfg.get<number>('app.port') ?? 3000;
  await app.listen(port);

  const d = cfg.get<{ db: string; queue: string; storage: string; providerMode: string }>(
    'app.drivers',
  ) ?? { db: '?', queue: '?', storage: '?', providerMode: '?' };
  const version = cfg.get<string>('app.version') ?? 'dev';
  Logger.log(
    `API 已启动：http://localhost:${port}${prefix}  Swagger: /docs  ·  版本 ${version}  ·  环境 ${cfg.get<string>('app.env') ?? '?'}`,
    'Bootstrap',
  );
  Logger.log(
    `驱动：db=${d.db} · queue=${d.queue} · storage=${d.storage} · provider=${d.providerMode}`,
    'Bootstrap',
  );
  if (d.providerMode === 'mock') {
    Logger.warn(
      '当前为 MOCK 模式：登录用 code=dev:1001；支付成功自动回调（可关 MOCK_PAY_AUTO_SUCCESS）',
      'Bootstrap',
    );
  }

  // 时钟注入告警（e2e 专用；机制与边界见 common/utils/time.ts 顶部注释）
  if (isClockShifted()) {
    const shiftMin = Math.round(clockShiftMs() / 60_000);
    Logger.warn(
      `时钟注入已启用：ABOX_SHIFT_TO_HOUR 生效，now() = ${toBjIso(now())}` +
        `（真实时刻 ${shiftMin >= 0 ? '+' : ''}${shiftMin} 分钟）· ` +
        `@Cron 仍按真实钟触发 —— 跑批请走补跑接口，勿以本时间为准排查线上问题`,
      'Bootstrap',
    );
  }
}

void bootstrap();
