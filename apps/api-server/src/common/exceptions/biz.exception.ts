import { HttpStatus } from '@nestjs/common';
import { ERROR_MESSAGE, ErrorCode, HTTP_STATUS_OVERRIDE } from '../constants/error-code';

/**
 * 业务异常 —— 业务代码只需 `throw new BizException(ErrorCode.ORDER_CUTOFF)`
 * 全局异常过滤器会把它翻译成统一响应体 { code, message, data:null, requestId, timestamp }
 *
 * HTTP 状态码：默认 **200**（业务失败由 `code` 表达，见 error-code.ts 头部口径）；
 * 仅 UNAUTHORIZED / FORBIDDEN / TOO_MANY_REQUESTS 沿用真实 HTTP 码，
 * 供端上做「跳登录 / 无权限页 / 限流提示」的全局拦截分支。
 */
export class BizException extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: HttpStatus;
  /** 附加数据（如 U11 截单携带 data.leaderContact） */
  readonly payload?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    httpStatus?: HttpStatus,
    payload?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_MESSAGE[code] ?? '业务异常');
    this.name = 'BizException';
    this.code = code;
    this.httpStatus = httpStatus ?? ((HTTP_STATUS_OVERRIDE[code] as HttpStatus) || HttpStatus.OK);
    this.payload = payload;
  }

  static of(code: ErrorCode, message?: string): BizException {
    return new BizException(code, message);
  }
}
