import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';

import { ApiResponseDto } from '../dto/api-response.dto';

/**
 * 统一响应包装（《接口规范》§1.2）
 * 约定：Controller 只返回「业务数据」，由本拦截器统一包装成
 *   { code: 0, message: 'ok', data, requestId, timestamp }
 * 禁止在 Controller 里手工拼响应体。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponseDto<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponseDto<T>> {
    const req = context.switchToHttp().getRequest<Request>();
    const requestId = req.requestId ?? '';

    return next.handle().pipe(
      map((data) => ({
        code: 0,
        message: 'ok',
        data: (data === undefined ? null : data) as T,
        requestId,
        timestamp: Date.now(),
      })),
    );
  }
}
