import { HttpStatus } from '@nestjs/common';
import { ErrorCode, ERROR_MESSAGE } from '../constants/error-code';

/**
 * 业务异常 —— 业务代码只需 `throw new BizException(ErrorCode.ORDER_CUTOFF)`
 * 全局异常过滤器会把它翻译成统一响应体 { code, message, data:null }
 */
export class BizException extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: HttpStatus;

  constructor(code: ErrorCode, message?: string, httpStatus: HttpStatus = HttpStatus.OK) {
    super(message ?? ERROR_MESSAGE[code] ?? '业务异常');
    this.name = 'BizException';
    this.code = code;
    this.httpStatus = httpStatus;
  }

  static of(code: ErrorCode, message?: string): BizException {
    return new BizException(code, message);
  }
}
