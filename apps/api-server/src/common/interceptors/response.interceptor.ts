import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

import { ApiResponseDto } from '../dto/api-response.dto';

/**
 * 统一响应包装
 * 约定：Controller 只返回「业务数据」，由本拦截器统一包装成
 *   { code: 0, message: 'ok', data, ts }
 * 禁止在 Controller 里手工拼响应体。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponseDto<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponseDto<T>> {
    return next.handle().pipe(
      map((data) => ({
        code: 0,
        message: 'ok',
        data: (data === undefined ? null : data) as T,
        ts: Date.now(),
      })),
    );
  }
}
