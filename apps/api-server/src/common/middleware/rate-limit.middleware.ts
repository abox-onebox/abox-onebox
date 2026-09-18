import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { KvService } from '../cache/kv.service';
import { ErrorCode, ERROR_MESSAGE } from '../constants/error-code';
import { BizException } from '../exceptions/biz.exception';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';

/**
 * 限流中间件（**M5-6 实装** · 收口《全面检查与测试报告 v1.0》§二 P2-7）
 *
 * ## 改前是什么
 * 本文件是 `export {}` 空占位，依赖里没有 `@nestjs/throttler`，全仓 `10005`
 * **没有任何产生点** —— 「有码无实现」。后果：`POST /auth/login`（小程序侧）与
 * `POST /orders` 可被高频刷，且**不会报任何错**。
 *
 * ## 算法：固定窗口（fixed window）
 * `KvService.incr(key, windowSec)` —— 窗口内第一次自增时种下 TTL，之后累加。
 * 选固定窗口而不是滑动窗口：实现只有一行、语义可解释、超限判定可预测；
 * 代价是窗口边界处最坏可放行 2×max（可接受：本项目的目标是「挡住脚本刷单/撞库」，
 * 不是精确整形）。
 *
 * ⚠️ **多实例部署前必读**：`KvService` 在**内存模式**下是单进程 Map ——
 *    计数**不跨实例**，N 个实例等于限额放大 N 倍。生产须让 `KvService` 走 Redis 后端
 *    （见 `common/cache/kv.service.ts` 的驱动分支与《部署运维手册》环境变量表）。
 *    这是「本地能跑 ≠ 生产有效」的典型一处，故写在这里而不是只写在手册里。
 *
 * ## 维度：为什么只有后台登录端带「账号维度」
 * 中间件跑在**守卫之前**，此时**没有可信身份** —— 只有 IP 与请求体。于是：
 *   · `POST /auth/admin-login` → **IP + `body.username`** 双维度。用户名是这次撞库的
 *     **真实目标**，且它本来就在请求体里，不需要鉴权就能拿到（配合 `auth.service.ts`
 *     既有的失败锁定 `20005`，构成「按账号」与「按来源」两道闸）。
 *   · `POST /orders` → **只有 IP 维度**。这里诚实标注缺口：按账号限流需要**已验证**的
 *     `sub`，而 `JwtService` 由 `AuthModule` 私有持有（未 `exports`、未 `@Global`），
 *     中间件拿不到；**不**用「自己解一遍未验签的 JWT」凑数 —— 那样攻击者可以伪造
 *     `sub` 把**别人的**额度打满（用限流器制造定向拒绝），是**引入**漏洞而不是修漏洞。
 *     正确落点在鉴权之后（守卫 / 控制器内，`req.user.sub` 已验签），列为后续项。
 *   · `POST /auth/login`（微信侧）→ **只有 IP 维度**。同理：微信 `code` 是**一次性**凭据，
 *     每次请求都不同，拿它当账号键等于没有账号维度；真正的账号标识（`openid`）
 *     要换取之后才知道。此处不假装有。
 *
 * ## 超限响应：**复用同一个异常过滤器**，不写第二套
 * `AllExceptionsFilter` 是全局唯一的异常出口。若在本文件里手写一个 429 响应体，
 * 就成了「两种写法、两种形状」—— 正是本批在别处刚收口掉的那类漂移。
 * 故这里构造一个**最小 `ArgumentsHost` 壳**，把 `BizException(TOO_MANY_REQUESTS)`
 * 交给**同一个**过滤器去产出：`code=10005` / `HTTP 429`（`10005` 是
 * `HTTP_STATUS_OVERRIDE` 里保留真实状态码的三个例外之一）/ 字段
 * `{ code, message, data, requestId, timestamp }` 全部自动一致。
 *
 * ## 阈值：按「一栋办公楼共用 NAT 出口」定，刻意**不设**全局写请求兜底
 * 详见 `RATE_LIMIT_RULES` 上方注释 —— 这是本业务**主场景**（同一办公楼 → 同一出口 IP）
 * 决定的，不是随手取的值。
 *
 * ## 失败开放（fail-open）
 * 计数依赖外部存储（内存 Map / Redis）。**取数失败一律放行**并告警：
 * 限流是加固手段，**不能**因为缓存抖动把整个 API 打死（可用性 > 收紧）。
 */

export interface RateLimitRule {
  /** 计数键前缀（改动它会立刻清空既有计数，勿随手改） */
  label: string;
  /** 生效方法；空数组 = 全部方法 */
  methods: string[];
  /** 在归一化路径（已剥 `/api/vN` 前缀与尾斜杠）上匹配 */
  path: RegExp;
  windowSec: number;
  /** 窗口内同一 IP 的上限 */
  maxPerIp: number;
  /** 账号维度上限；`undefined` = 本规则不做账号维度 */
  maxPerAccount?: number;
  /** 账号标识提取（仅在能拿到**稳定**标识时才给这个函数，见文件头「维度」一节） */
  accountOf?: (req: Request) => string | undefined;
}

/**
 * ⚠️ 这些数字是**防护阈值**，不是业务参数，故**不放 `ab_config`** ——
 * 放进配置表意味着运营可以把它改成 0 而让全站 429，且没有任何校验会拦。
 *
 * ## 阈值为什么是「宽」的（本业务的**主场景**约束）
 * 本产品的用户是**同一栋办公楼的白领**，他们**共用同一个 NAT 出口 IP**。
 * 于是「按 IP 限流」在这里有两种相反的失手方式：
 *   · 阈值太紧 → 群公告一响、一个办公楼几十人同时下单，**整栋楼被 429**（把正常用户当脚本杀）
 *   · 阈值太松 → 挡不住脚本
 * 取值按「**能容纳一整栋楼的一分钟突发**，但仍远低于脚本能力」来定：
 *   · `auth:login` 60/分 —— 一次授权登录一次，60 人同时打开 App 也不会撞；
 *   · `order:create` 120/分 —— 下单窗口有 **10 小时**（T-1 14:00–24:00），
 *     120/分 = 2/秒持续，脚本一刷新就超，而「120 人挤在同一分钟」不是常态。
 * **刻意不设「全局写请求 IP 兜底」**：那正是最容易误伤 NAT 的一条 ——
 * 一个上限会把整栋楼的写操作一起打掉，而它拦住的只是「没被上面三条覆盖的端点」。
 * 需要更细的防护时，正确的方向是**加具体规则**，不是收紧兜底。
 */
export const RATE_LIMIT_RULES: RateLimitRule[] = [
  {
    label: 'auth:admin-login',
    methods: ['POST'],
    path: /^\/auth\/admin-login$/,
    windowSec: 60,
    maxPerIp: 10,
    maxPerAccount: 5,
    accountOf: (req) => {
      const u = (req.body as { username?: unknown } | undefined)?.username;
      return typeof u === 'string' && u.trim() ? u.trim().toLowerCase() : undefined;
    },
  },
  {
    label: 'auth:login',
    methods: ['POST'],
    path: /^\/auth\/login$/,
    windowSec: 60,
    maxPerIp: 60,
  },
  {
    label: 'order:create',
    methods: ['POST'],
    path: /^\/orders$/,
    windowSec: 60,
    maxPerIp: 120,
  },
];

/** 不参与限流：探针与静态资源（把它们打掉 = 自伤；探针另有分级机制） */
const SKIP_PATH = /^\/(?:health|docs|static)(?:\/|$)/;

/**
 * 限流总开关：`ABOX_RATE_LIMIT=off` 关闭（默认**开启**）。**生产环境恒为开启。**
 *
 * ## 为什么需要它（不是「图测试方便」）
 * 阈值是按「一栋办公楼共用 NAT 出口」定的（见上方 `RATE_LIMIT_RULES` 注释）：
 * `auth:admin-login` **IP 10/分 · 账号 5/分**。而 **e2e 套件自己**一轮会打
 * **54 次** `admin-login`（`finance` / `sanweiwu` 等同一账号各被复用近 10 次）——
 * 远超阈值，于是套件会被**自己的防护**打成 429 而红。
 *
 * 把它「调大到套件不红」是错的：那等于拿测试阈值替换生产阈值，防护随之失效。
 * 正确的切法是**把两件事分开**：
 *   · 主线 e2e（m1/m2/m3，验业务逻辑）→ `off`，限流不是它们的被测对象；
 *   · 限流**自身**的验收（`e2e-m3.mjs` §33）→ **另起一台开启限流的实例**做真实 HTTP 断言。
 * 于是「中间件到底有没有挂在请求链上」**仍被自动化验证** —— 这正是本批真实踩到的坑：
 * 注册点选错时中间件一次都不跑，而编译、启动、日志全都看不出异常。
 *
 * ⚠️ 与 `ABOX_SHIFT_TO_HOUR` 同款约束：**`NODE_ENV=production` 时无条件忽略本开关**
 *    （写成 `off` 也无效），只打一条 WARN —— 生产不会因为漏配一个环境变量而失去防护。
 * ⚠️ 刻意**不提供**「放大倍数」这类中间档：倍数会让「阈值是否够宽」失去检验对象。
 * ⚠️ 本函数在模块加载期**不执行**，实际读取时刻见 `createRateLimitMiddleware`
 *    （那时 dotenv 已加载、`configure()` 正在跑）。
 */
export function rateLimitEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') {
    if (process.env.ABOX_RATE_LIMIT === 'off') {
      new Logger('RateLimit').warn(
        'ABOX_RATE_LIMIT=off 在 production 环境被忽略：限流恒开启（避免漏配环境变量导致防护静默失效）',
      );
    }
    return true;
  }
  return process.env.ABOX_RATE_LIMIT !== 'off';
}

/** `/api/v1/x/` → `/x`（`setGlobalPrefix` 不影响 `app.use`，故此处要自己剥） */
export function normalizePath(originalUrl: string): string {
  const raw = originalUrl.split('?')[0].replace(/^\/api\/v\d+/, '');
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
}

/** 取来源 IP（未配 `trust proxy` 时是直连地址；反代后须在部署层开 `trust proxy`） */
function ipOf(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/** 命中即返回该规则；否则 `null`（**首个**命中者生效，故具体规则要排在兜底前面） */
export function matchRule(path: string, method: string): RateLimitRule | null {
  const m = method.toUpperCase();
  for (const r of RATE_LIMIT_RULES) {
    if (r.methods.length > 0 && !r.methods.includes(m)) continue;
    if (r.path.test(path)) return r;
  }
  return null;
}

/** 最小 `ArgumentsHost` 壳 —— 让中间件也能走**同一个**异常过滤器 */
function hostOf(req: Request, res: Response): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

/**
 * 计数 + 判定。返回被触发的描述（含维度与限额），未超限返回 `null`。
 *
 * 抽成独立导出函数是为了让 e2e / 单测能**直接调它**，不必起 HTTP。
 */
export async function checkRateLimit(
  kv: KvService,
  rule: RateLimitRule,
  req: Request,
): Promise<{ dimension: string; key: string; count: number; limit: number } | null> {
  const once = async (
    dimension: string,
    suffix: string,
    limit: number | undefined,
  ): Promise<{ dimension: string; key: string; count: number; limit: number } | null> => {
    if (limit === undefined) return null;
    const key = `rl:${rule.label}:${dimension}:${suffix}`;
    const count = await kv.incr(key, rule.windowSec);
    return count > limit ? { dimension, key, count, limit } : null;
  };

  const byIp = await once('ip', ipOf(req), rule.maxPerIp);
  if (byIp) return byIp;

  if (rule.maxPerAccount !== undefined && rule.accountOf) {
    const account = rule.accountOf(req);
    if (account) return await once('acct', account, rule.maxPerAccount);
  }
  return null;
}

/**
 * 生成 Express 中间件。`kv` 由调用方（`AppModule` 的构造器注入）传入。
 *
 * ## 注册点：`AppModule.configure()` —— **不要**挪到 `main.ts` 的 `app.use()`
 * `NestApplication.init()` 内部顺序固定为：`registerParserMiddleware()` →
 * `registerModules()`（跑 `configure()`）→ `registerRouter()`。而 `app.use()`
 * 只能把中间件**追加到 Express 栈尾**，于是：
 *   · 在 `init()` **之前** `app.use` → 排在 body-parser 前 → `req.body` 恒为
 *     `undefined` → **账号维度静默失效**（IP 维度照常，外部看不出异常）；
 *   · 在 `init()` **之后** `app.use` → 排在路由后 → 请求已被控制器处理完，
 *     中间件**一次都不执行**（连日志都没有，比上一种更隐蔽）。
 * `configure()` 天然夹在两者之间，是唯一同时满足「拿得到请求体」与「挡得住请求」
 * 的注册点。**验证方式不是读代码，而是跑 §33 的 429 断言** —— 位置错了不会报错。
 *
 * ## 关于「Nest 中间件的异常不进异常过滤器」
 * 这个说法只在**中间件抛出**时成立。本文件不抛异常，而是把 `BizException` 直接
 * 交给 `AllExceptionsFilter` 实例去产出响应（见文件头「超限响应」一节），
 * 因此无论用哪种方式注册都不受影响 —— 这条限制不再是选注册点的理由。
 */
export function createRateLimitMiddleware(kv: KvService) {
  const logger = new Logger('RateLimit');
  // 复用一个过滤器实例：它无构造依赖、无内部状态
  const filter = new AllExceptionsFilter();
  // 创建时读一次：本函数在 `configure()` 里被调用，此时 dotenv 已加载
  const enabled = rateLimitEnabled();
  if (!enabled) {
    logger.warn('限流已通过 ABOX_RATE_LIMIT=off 关闭（仅限非生产环境；生产恒开启）');
  }

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!enabled) {
      next();
      return;
    }
    const path = normalizePath(req.originalUrl ?? req.url);
    if (SKIP_PATH.test(path)) {
      next();
      return;
    }
    const rule = matchRule(path, req.method);
    if (!rule) {
      next();
      return;
    }

    checkRateLimit(kv, rule, req)
      .then((hit) => {
        if (!hit) {
          next();
          return;
        }
        logger.warn(
          `限流命中 ${rule.label}（${hit.dimension}=${hit.key.slice(hit.key.lastIndexOf(':') + 1)}）` +
            `${hit.count}/${hit.limit} · ${req.method} ${path} · ip=${ipOf(req)}`,
        );
        // 交给同一个异常过滤器产出 —— 响应体与「抛 BizException(10005)」逐字节一致
        filter.catch(new BizException(ErrorCode.TOO_MANY_REQUESTS), hostOf(req, res));
      })
      .catch((e: unknown) => {
        // fail-open：限流器自身故障不得阻断业务
        logger.warn(`限流计数失败，本次放行：${(e as Error)?.message ?? e}`);
        next();
      });
  };
}

/** 供日志 / e2e 断言引用（文案与实现同源，避免两处各写一遍） */
export const RATE_LIMIT_MESSAGE = ERROR_MESSAGE[ErrorCode.TOO_MANY_REQUESTS];
