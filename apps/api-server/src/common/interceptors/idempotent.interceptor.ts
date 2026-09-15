import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HEADER } from '@abox/shared-types';
import type { Request } from 'express';
import { Observable, defer, from, switchMap, tap } from 'rxjs';

import { KvService } from '../cache/kv.service';
import { ErrorCode } from '../constants/error-code';
import { IDEMPOTENT_KEY, IdempotentOptions } from '../decorators/idempotent.decorator';
import { BizException } from '../exceptions/biz.exception';

/** 占位标记：同一幂等键的首次请求正在处理中 */
const PENDING = '__pending__';

interface CachedResult {
  data: unknown;
  at: number;
}

/**
 * 幂等拦截器（《接口规范》§1.4 / §1.7）
 *
 * 机制：请求头 `Idempotency-Key` + KV 键 `idem:<scope>:<key>`
 *   1. 键不存在       → `setNx` 占位（值 `__pending__`）→ 放行
 *   2. 键 = `__pending__` → 抛 10006「请勿重复提交」（首次仍在处理中）
 *   3. 键 = 首次结果 JSON → 抛 10006 + `data`=首次结果（HTTP 200，端上按成功处理）
 *   4. 业务抛错         → **删除键** → 同键可立即重试（见下方 `error` 分支说明）
 *
 * 设计取舍：重复命中走 **BizException(DUPLICATE_SUBMIT) + payload**，
 * 由全局异常过滤器统一成 `{ code:10006, data:首次结果 }` —— 与文档契约逐字一致，
 * 且无需绕过统一响应包装。
 *
 * ⚠️ 整个流程必须包在 `defer()` 里：入口校验（缺 `Idempotency-Key`）若**同步 throw**，
 *    异常会在「调用方求值 `intercept(...)` 实参」阶段逸出，绕开拦截链与
 *    `firstValueFrom().rejects` 语义；包进 defer 后，所有失败（含入口）统一为
 *    **Observable error**，与 Nest 全局异常过滤器、端上处理方式一致。
 *
 * ⚠️ 本拦截器为**方法级**（`@UseInterceptors` / `@Idempotent`），
 *    在响应包装拦截器**内层**执行，故缓存的是**业务数据本身**（未带外层壳）。
 */
@Injectable()
export class IdempotentInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly kv: KvService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      context.getHandler(),
    );
    if (!options) return next.handle();

    return defer(() => {
      const req = context.switchToHttp().getRequest<Request>();
      const raw = req.headers[HEADER.IDEMPOTENCY_KEY.toLowerCase()];
      const key = typeof raw === 'string' ? raw.trim() : '';

      if (!key) {
        if (options.required === false) return next.handle();
        throw new BizException(
          ErrorCode.PARAM_INVALID,
          `缺少请求头 ${HEADER.IDEMPOTENCY_KEY}（下单/支付创建必填，见《接口规范》§1.7）`,
        );
      }

      const cacheKey = `idem:${options.scope}:${key}`;
      const ttl = options.ttlSec ?? 600;

      return from(this.kv.setNx(cacheKey, PENDING, ttl)).pipe(
        switchMap((acquired) => {
          if (!acquired) return this.replayFirstResult(cacheKey);
          return next.handle().pipe(
            tap({
              next: (data) => {
                const payload: CachedResult = { data: data ?? null, at: Date.now() };
                void this.kv.set(cacheKey, JSON.stringify(payload), ttl).catch(() => undefined);
              },
              error: () => {
                // ⚠️ 业务失败必须**删除占位键**，否则键会一直停在 `__pending__`，
                //    同一幂等键在 TTL 内重试会被误判为「请勿重复提交」（10006），
                //    端上网络重试 / 用户改完再提交就永久卡死。
                //    删除后：失败可重试，而成功结果仍被缓存（不会把失败固化成「幂等成功」）。
                void this.kv.del(cacheKey).catch(() => undefined);
              },
            }),
          );
        }),
      );
    });
  }

  /**
   * 命中已占用的幂等键：
   *   · 占位 `__pending__` → 首次请求仍在处理中 → 10006（无 data）
   *   · 已回填结果        → 10006 + `data` = 首次结果（HTTP 200，端上按成功处理）
   */
  private replayFirstResult(cacheKey: string): Observable<never> {
    return from(this.kv.get(cacheKey)).pipe(
      switchMap((hit) => {
        if (!hit || hit === PENDING) throw new BizException(ErrorCode.DUPLICATE_SUBMIT);
        let first: CachedResult;
        try {
          first = JSON.parse(hit) as CachedResult;
        } catch {
          throw new BizException(ErrorCode.DUPLICATE_SUBMIT);
        }
        throw new BizException(
          ErrorCode.DUPLICATE_SUBMIT,
          undefined,
          undefined,
          (first.data ?? null) as Record<string, unknown>,
        );
      }),
    );
  }
}
