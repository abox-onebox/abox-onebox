import { randomBytes } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/** 挂到 req 上的请求 ID（响应拦截器 / 异常过滤器 / 日志共用） */
export const REQUEST_ID_HEADER = 'X-Request-Id';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

/**
 * 请求 ID 中间件（《接口规范》§1.2）
 *   优先沿用端上注入的 `X-Request-Id`（便于端到端串联），缺省由服务端生成
 *   格式：`req_<毫秒时间戳>_<6位十六进制>`
 *   同时回写响应头，并在 req 上留存供统一响应体 / 异常过滤器读取。
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER.toLowerCase()];
  const id =
    typeof incoming === 'string' && incoming.trim().length > 0
      ? incoming.trim()
      : `req_${Date.now()}_${randomBytes(3).toString('hex')}`;

  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}
