import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { json as jsonParser, urlencoded as urlencodedParser } from 'body-parser';

import {
  carriesBody,
  hasRequestBodySemantics,
  judgeBodyFailure,
} from '../http/request-body.policy';

/**
 * 请求体解析中间件（**取代 Nest 默认注册的 body-parser**）
 *
 * ## 它接替的是谁
 * `NestApplication.init()` 里的 `registerParserMiddleware()`
 * （`@nestjs/core/nest-application.js:97`）会先挂两个解析器，而且它排在
 * `configure()` **之前** —— 也就是说：在 Nest 内部拿不到"比默认解析器更靠前"的位置。
 * 所以要让这次修复生效，只能从源头接管：`main.ts` 传 `bodyParser: false` 关掉默认解析器，
 * 再由本中间件在 `configure()` 里挂上。`configure()` 是「无解析器」时唯一一个
 * 「路由之前、socket 之后」的位置（`AppModule.configure()` 头注释已有同样的记载）。
 *
 * ## 与 Nest 默认解析器的差异（只有两处，且都是这次要修的东西）
 *   1. **GET / HEAD / OPTIONS 不解析体**：先把体 drain 掉再 `next()` —— 多出来的体
 *      不再能把一个只读请求打成 10001（2026-10-27 事故的直接机制）。
 *   2. **体不合法时报受控文案，并且必落日志**。默认那一路是不打日志的：
 *      传输层错误经 `mapExternalException` → `BadRequestException(err.message)` →
 *      `AllExceptionsFilter` 伪装成 10001 下发，**服务端不留任何痕迹**，
 *      所以当时「日志 0 条、健康检查全绿、还能自愈」。
 *
 * ## 刻意保持不变（避免把修复写成重写）
 *   · json / urlencoded 两个解析器的配置与 Nest 完全一致（`extended:true`、
 *     默认 `strict:true`、`verify` 挂 `req.rawBody`）。
 *     ⚠️ 尤其**不能丢 `rawBody`**：`/pay/notify` 的微信支付 V3 验签要用**原始报文**
 *     （`payment.controller.ts:66` 读 `req.rawBody`）。
 *   · 仍然在无体 / 空体时把 `req.body` 兜成 `{}`，保证下游拿到的形状不变
 *     （`@Body()`、以及限流中间件的账号维度 `req.body?.username`）。
 *
 * ⛔ 本文件**不放任何判据**：方法是否有体语义、失败怎么裁决，全部取自
 *    `common/http/request-body.policy.ts`，这里只负责按裁决执行。
 */
const logger = new Logger('RequestBody');

type RawBodyRequest = Request & { rawBody?: Buffer };

export function createRequestBodyMiddleware(): (
  req: RawBodyRequest,
  res: Response,
  next: NextFunction,
) => void {
  const captureRawBody = (req: RawBodyRequest, _res: Response, buffer: Buffer): boolean => {
    if (Buffer.isBuffer(buffer)) req.rawBody = buffer;
    return true;
  };

  const parseJson = jsonParser({ verify: captureRawBody });
  const parseForm = urlencodedParser({ extended: true, verify: captureRawBody });

  /** 统一收口：按 policy 的裁决决定「丢弃」还是「受控拒绝」，两种结局都留痕 */
  function settle(err: unknown, req: RawBodyRequest, next: NextFunction): void {
    const verdict = judgeBodyFailure(req.method, err);
    if (verdict.kind === 'ignore') {
      logger.warn(
        `${req.method} ${req.originalUrl} 携带了请求体，但该方法不定义请求体语义 → 丢弃` +
          `（引擎原文：${(err as Error)?.message ?? String(err)}）`,
      );
      req.body = req.body || {};
      return next();
    }
    logger.warn(
      `${req.method} ${req.originalUrl} 请求体非法 → 拒绝（10001）· 引擎原文：${verdict.rawMessage}`,
    );
    /**
     * ⭐ 刻意保持 `SyntaxError` 类型：`@nestjs/core` 的 `RoutesResolver#mapExternalException`
     *   只认 SyntaxError / URIError → 仍由它映射成 400 → `AllExceptionsFilter` → code:10001。
     *   ⇒ 响应体的组装**只有 filter 一处**，本中间件绝不自己再拼一份 `{code,message,...}`。
     */
    return next(new SyntaxError(verdict.message));
  }

  return (req, res, next) => {
    req.body = req.body || {};

    // 无请求体语义的方法：不读、不解析、不许失败。
    // drain 而不是放任 —— 残留字节会留在 keep-alive 连接里被下一个请求读走。
    if (!hasRequestBodySemantics(req.method)) {
      /**
       * ⭐ **丢弃 ≠ 静默**：只在**确实带了体**时告警（判据 `carriesBody`）。
       *    2026-10-27 那条事故之所以拖了一整天，就是因为这条路径连一条日志都没有 ——
       *    「GET 被体打成 10001」和「GET 的体被丢弃」都不留痕。
       *    ⚠️ 不能无差别打：正常 GET 全都没有体，无差别打等于把日志刷爆。
       */
      if (carriesBody(req.headers['content-length'], req.headers['transfer-encoding'])) {
        logger.warn(
          `${req.method} ${req.originalUrl} 携带了请求体，但该方法不定义请求体语义 → 丢弃` +
            `（RFC 9110 §9.3；Content-Length=${req.headers['content-length'] ?? '-'}` +
            `${req.headers['transfer-encoding'] ? ` · Transfer-Encoding=${req.headers['transfer-encoding']}` : ''}）。` +
            '若调用方是刻意发体，请改 POST 或把参数放进 query —— 这条日志即定位依据。',
        );
      }
      req.resume();
      return next();
    }

    parseJson(req, res, (jsonErr: unknown) => {
      if (jsonErr != null) return settle(jsonErr, req, next);
      parseForm(req, res, (formErr: unknown) => {
        if (formErr != null) return settle(formErr, req, next);
        return next();
      });
    });
  };
}
