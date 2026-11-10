import { raw as rawParser } from 'body-parser';
import type { NextFunction, Request, Response } from 'express';

/**
 * 企业微信回调「原始报文」捕获（2026-11-10 生产实测收口）
 *
 * ## 为什么需要它（两个缺陷叠加，缺一不可）
 *
 * `WecomKbController.handle()` 读 `req.rawBody` 拿原始 XML，再交给 WXBizMsgCrypt
 * 验签解密。但线上实测三种 Content-Type（text/xml / application/xml /
 * application/json）**一律**走进 `handlePost()` 的「缺少 Encrypt 节点」分支 ——
 * 即 `req.rawBody` 恒为 undefined。原因是两条链路同时断了：
 *
 *   ① **作用域断了**：`AppModule.configure()` 用 `forRoutes('*')` 注册
 *      `createRequestBodyMiddleware()`，经 RouteInfoPathExtractor 展开后只覆盖
 *      `/api/v1$` + `/api/v1/*`（全局前缀会加到中间件上）。而 `main.ts` 用
 *      `setGlobalPrefix(prefix, { exclude: ['wecom/(.*)'] })` 把企微回调挂成了
 *      **裸路径** `/wecom/kb/callback` ⇒ 请求体中间件根本没作用于它。
 *      对照实验佐证：发合法 `application/json`（body 内嵌 `<Encrypt>`）也报
 *      「缺少 Encrypt 节点」；若中间件生效，`verify` 会挂上 rawBody 并走到
 *      「签名不符」分支。
 *
 *   ② **解析器断了**：即便把 ① 修好，`request-body.middleware.ts` 只注册了
 *      `json` + `urlencoded` 两个 body-parser；企微回调发的是 **XML**，两个解析器
 *      都会 `skip parsing` 直接 next，`verify` 回调永不触发 ⇒ rawBody 仍不挂。
 *
 * ## 为什么单独挂一个，而不是改全局请求体中间件
 *
 * `createRequestBodyMiddleware()` 是 2026-10-27「GET 带体把只读请求打成 10001」
 * 事故的收口件，判据分散在 `request-body.policy.ts`，全局生效面 300+ 端点。
 * 为一个 XML 回调去动它的作用域与解析器，等于把已收口的事故面重新打开。
 * 故这里用一个独立中间件，在 `main.ts` 用 `app.use(mw)` 全局挂载，再由
 * **中间件自己精确判路径**，只处理 `/wecom/kb/callback`：
 *   · Express 层 `app.use` **不受** `setGlobalPrefix` 影响（见 rate-limit.middleware
 *     的 normalizePath 注释），裸路径能判到；
 *   · 挂在 `NestFactory.create()` 之后 / `app.init()` 之前 ⇒ 排在
 *     `configure()` 注册的中间件**之前**，先把原始流读出来；
 *   · ⚠️ 刻意**不用** `app.use('/wecom/kb/callback', mw)`：Express 的前缀挂载会
 *     trim_prefix 临时改写 `req.url`，而 Nest 的路由注册在它后面，多一层时序耦合。
 *     全局 `app.use(mw)` + 内部 `return next()` 是零副作用的最小形态；
 *   · 影响面收敛到这一个端点，其他接口只多一次字符串比较，行为一字不变。
 *
 * ## GET 握手
 *
 * 企微后台填 URL 时发的是 **GET**（只有 query：msg_signature/timestamp/nonce/
 * echostr），没有请求体。GET/HEAD 必须直接 next，不能让 raw parser 去等一个
 * 不存在的流；否则 `verifyUrl()` 的握手会被拖住甚至挂起。
 *
 * ## 与 `rawBody: true` 的关系
 *
 * `NestFactory.create(..., { rawBody: true, bodyParser: false })` 里的 `rawBody`
 * 只作用于 Nest **自己注册**的那组解析器，而 `bodyParser: false` 已把它们关掉；
 * 所以裸路径上的 rawBody 只能由本中间件提供，两者不冲突、也不重复读流
 * （`request-body.middleware` 不作用于本路径）。
 */
/** 与 `WecomKbController` 的 @Controller('wecom/kb') + @Post('callback') 对齐 */
export const WECOM_CALLBACK_PATH = '/wecom/kb/callback';

type RawBodyRequest = Request & { rawBody?: Buffer };

/** body-parser 的 `verify`：把**未经任何改写**的原始 Buffer 挂到 req.rawBody */
function captureRawBody(req: RawBodyRequest, _res: Response, buffer: Buffer): boolean {
  if (Buffer.isBuffer(buffer)) req.rawBody = buffer;
  return true;
}

/**
 * 只对企微回调路径使用。`type: () => true` 是刻意的：企微不同版本会发
 * `text/xml` / `application/xml`，写死白名单总有一天漏一种；反正这个中间件
 * 的挂载路径已经收窄到单个端点，这里再按 Content-Type 收窄没有安全收益，
 * 反而会重演「换一种 Content-Type 就整条链路静默失效」。
 *
 * `limit: '1mb'` 与业务一致（企微单条消息远小于此），超限由 body-parser
 * 抛 413，不会无限读流。
 */
export function createWecomRawBodyMiddleware(): (
  req: RawBodyRequest,
  res: Response,
  next: NextFunction,
) => void {
  const parseRaw = rawParser({
    type: () => true,
    limit: '1mb',
    verify: captureRawBody,
  });

  return (req: RawBodyRequest, res: Response, next: NextFunction): void => {
    // 精确判路径：只认裸路径本体（可带 query），不认 /wecom/kb/callback/xxx 子路径。
    // 用 originalUrl 而非 url：前者不受任何上游 mount / trim_prefix 影响。
    const path = (req.originalUrl ?? '').split('?')[0].replace(/\/+$/, '');
    if (path !== WECOM_CALLBACK_PATH) return next();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    return parseRaw(req, res, next);
  };
}
