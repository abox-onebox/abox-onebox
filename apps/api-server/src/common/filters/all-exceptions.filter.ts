import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import { ErrorCode } from '../constants/error-code';
import { BizException } from '../exceptions/biz.exception';

/**
 * 全局异常过滤器
 * 把各类异常统一翻译成 { code, message, data: null, ts }
 *   BizException      → 业务码（HTTP 200）
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

    let code: number = ErrorCode.INTERNAL_ERROR;
    let message = '系统繁忙，请稍后再试';
    let httpStatus = HttpStatus.OK;

    if (exception instanceof BizException) {
      code = exception.code;
      message = exception.message;
      httpStatus = exception.httpStatus;
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

    res.status(httpStatus).json({ code, message, data: null, ts: Date.now() });
  }
}
