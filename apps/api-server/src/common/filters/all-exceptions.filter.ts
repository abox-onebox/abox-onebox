import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ErrorCode } from '../constants/error-code';
import { BizException } from '../exceptions/biz.exception';

/**
 * 全局异常过滤器
 * 把各类异常统一翻译成 { code, message, data, requestId, timestamp }（§1.2）
 *   BizException      → 业务码（默认 HTTP 200；10002/10003/10005 保留真实 HTTP 码）
 *   HttpException     → 依状态码映射（401/403 保留原状态码便于前端拦截登录）
 *   参数校验失败      → 10001，多条错误以「；」拼接
 *   其它未知异常      → 500 + 90001，并打错误日志
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = req?.requestId ?? '';

    let code: number = ErrorCode.INTERNAL_ERROR;
    let message = '系统繁忙，请稍后再试';
    let httpStatus = HttpStatus.OK;
    let payload: Record<string, unknown> | undefined;

    if (exception instanceof BizException) {
      code = exception.code;
      message = exception.message;
      httpStatus = exception.httpStatus;
      payload = exception.payload;
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let raw: unknown = (body as { message?: unknown })?.message ?? exception.message;
      if (Array.isArray(raw)) raw = raw.join('；');
      message = typeof raw === 'string' ? raw : exception.message;

      if (status === HttpStatus.UNAUTHORIZED) {
        code = ErrorCode.UNAUTHORIZED;
        httpStatus = HttpStatus.UNAUTHORIZED;
      } else if (status === HttpStatus.FORBIDDEN) {
        code = ErrorCode.FORBIDDEN;
        httpStatus = HttpStatus.FORBIDDEN;
      } else if (status === HttpStatus.NOT_FOUND) {
        code = ErrorCode.NOT_FOUND;
      } else if (status === HttpStatus.TOO_MANY_REQUESTS) {
        code = ErrorCode.TOO_MANY_REQUESTS;
      } else if (status === HttpStatus.BAD_REQUEST) {
        code = ErrorCode.PARAM_INVALID;
      } else {
        code = ErrorCode.INTERNAL_ERROR;
        httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
      }
    } else {
      httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
      this.logger.error(
        `未捕获异常：${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    // 业务失败默认 HTTP 200；仅 4xx/5xx 语义码沿用真实状态码（见 error-code.ts 口径）
    res
      .status(httpStatus)
      .json({ code, message, data: payload ?? null, requestId, timestamp: Date.now() });
  }
}
