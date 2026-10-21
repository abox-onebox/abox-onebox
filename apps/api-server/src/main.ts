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
import { judgeProdMock } from './common/utils/prod-mock-gate';
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
 *
 * ## `PROVIDER_MODE` 为什么在这里（2026-09-25 补）
 *
 * 它**不是密钥**，但漏配的后果比漏配密钥更隐蔽：默认值是 `mock`，而 mock 意味着
 * 「任意 code 免密登录任意身份」+「支付自动置为已支付」。也就是说——
 * **服务照常起、接口照常通、健康检查照常绿，但整条登录与支付链是假的**。
 *
 * （`app.config.ts` 已把生产的默认值改成 `real`，这里再要求**显式配置**，
 *   两道保险：即便将来有人又动了默认值，漏配仍然起不来。）
 */
const REQUIRED_IN_PROD = ['JWT_SECRET', 'PROVIDER_MODE'] as const;

function assertProdSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = REQUIRED_IN_PROD.filter((k) => !process.env[k]?.trim());
  if (!missing.length) return;
  Logger.error(
    `启动中止：生产环境必须显式配置 ${missing.join(' / ')}。` +
      '这些项都有内置默认值，漏配的后果是「服务看起来一切正常，但安全模型是假的」，' +
      '且不会随时间减轻。宁可起不来，不可带着假安全上线。',
    'Bootstrap',
  );
  if (missing.includes('PROVIDER_MODE')) {
    Logger.error(
      '尤其 `PROVIDER_MODE`：漏配会落到 mock —— 任意 code 免密登录任意身份、' +
        '下单后支付自动置为已支付。请在 .env.prod 里显式写 `PROVIDER_MODE=real`。',
      'Bootstrap',
    );
  }
  process.exit(1);
}

/**
 * 「生产禁 mock」启动硬闸（λ-1 · 2026-10-09 · 审查报告 #8 收口）
 *
 * ## 为什么 `assertProdSecrets()` 挡不住这件事
 *
 * 上面那条只看 `PROVIDER_MODE` **有没有配**（`!process.env[k]?.trim()`），
 * **不看配的是什么值** ⇒ `NODE_ENV=production` + `PROVIDER_MODE=mock` 完全合法。
 * 而 mock 在生产不是降级，是安全模型整体失效（三条后果写在 `prod-mock-gate.ts` 头注）。
 * 项目记忆里线上就是 `PROVIDER_MODE=mock` ⇒ 这是**线上正在跑的形态**，不是假设风险。
 *
 * ## ⚠️ 两个刻意的取舍
 *
 *   1. **`providerMode` 取自配置，不重读 `process.env.PROVIDER_MODE`**
 *      —— `app.config.ts` 的生产默认值是 `'real'`，直接读 env 会把「漏配时的默认值分岔」
 *      绕过去 ⇒ 判的就不是运行时真正生效的那个值，这道闸形同虚设。
 *   2. **它不在 `assertProdSecrets()` 旁边执行**：那条跑在 `NestFactory.create` 之前，
 *      那时 `ConfigService` 还不存在。故本闸放在**能取到 cfg 的第一时间**
 *      （`app.get(ConfigService)` 之后、`listen()` 之前）—— 仍然是「起不来」，
 *      只是晚到 app 已创建；要赶在 `listen()` 前，这一点没有妥协。
 *
 * ## 逃生开关 `ALLOW_MOCK_IN_PROD`
 *
 * 只认 `1` / `true`（大小写不敏感），其余一律视为未开 —— 判据在
 * `common/utils/prod-mock-gate.ts`（纯函数，探针 `scripts/probes/prod-mock-gate.mjs`
 * 用四场景 + 反证验过，不是「理论上会拦」）。
 * ⚠️ 开了就用 **`Logger.error` 而不是 warn**：这是「正在裸奔」级别的现状，
 *     warn 会被忽略；日志里必须说全三件事（现状 / 意味着什么 / 怎么关）。
 */
function assertProdProviderMode(cfg: ConfigService): void {
  const verdict = judgeProdMock({
    nodeEnv: process.env.NODE_ENV,
    // ⭐ 生效值（来自配置）—— 不是 process.env.PROVIDER_MODE，理由见上
    providerMode: cfg.get<string>('app.drivers.providerMode'),
    allowMockInProd: process.env.ALLOW_MOCK_IN_PROD,
  });
  if (!verdict.allow) {
    Logger.error(verdict.reason ?? 'PROD_MOCK_GATE 启动中止（理由缺失）', 'Bootstrap');
    process.exit(1);
  }
  if (verdict.escapeOn && verdict.notice) {
    Logger.error(verdict.notice, 'Bootstrap');
  }
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
  // 知识助手「替操作」跨域调用 /admin 写接口（阶段 2 前置）
  // 详见 _ABox一盒_替操作_阶段2前置_CORS与身份层设计.md §一
  // 该来源为 WorkBuddy 固定发布域名；并入白名单后跨域放行即生效。
  // 可逆：删除此 3 行即回退（仍可由服务器 CORS_ORIGINS 环境变量等价配置）。
  const KB_OPS_ORIGIN = 'https://abox-kb.app.workbuddy.host';
  if (!list.includes(KB_OPS_ORIGIN)) list.push(KB_OPS_ORIGIN);
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

  // ⭐ 能取到配置的**第一时间**就拦（DI 时序说明见函数头注）：早于 listen ⇒ 拦住就起不来
  assertProdProviderMode(cfg);

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
  // ⭐ 企业微信回调 URL 不含 /api/v1 前缀（见《企业微信KB助手部署操作卡/后台配置教程》）：
  // 必须把 wecom 路由从全局前缀里排除，使其直接挂在 /wecom/kb/callback，
  // 否则请求打到 /wecom/... 会因「前缀缺失」匹配不到控制器而返回 10004。
  // （nginx /wecom/ 反代块也是按无前缀转发的，两边口径必须一致。）
  app.setGlobalPrefix(prefix, { exclude: ['wecom/(.*)'] });

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
