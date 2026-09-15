import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { KvService } from '../../src/common/cache/kv.service';
import { ErrorCode } from '../../src/common/constants/error-code';
import { IdempotentInterceptor } from '../../src/common/interceptors/idempotent.interceptor';
import { BizException } from '../../src/common/exceptions/biz.exception';

/**
 * 幂等拦截器（《接口规范》§1.4）
 *   · 首次请求 → 放行并缓存业务数据
 *   · 重复请求 → `code:10006` + `data` = 首次结果（HTTP 200）
 *   · 处理中重复 → `code:10006`（无 data）
 *   · 缺请求头 → `10001`
 *
 * 这是 M1 验收标准 4「同一幂等键重复下单只产生一单」的核心保障。
 */
describe('幂等拦截器', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function build(options: { scope: string; ttlSec?: number; required?: boolean } | undefined) {
    const kv = new KvService({ get: () => 'memory' } as never);
    const reflector = { get: () => options } as unknown as Reflector;
    const interceptor = new IdempotentInterceptor(reflector, kv);
    return { interceptor, kv };
  }

  function ctx(key?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: key ? { 'idempotency-key': key } : {} }),
      }),
      getHandler: () => ({}),
    } as unknown as ExecutionContext;
  }

  const handler = (data: unknown): CallHandler => ({ handle: () => of(data) });

  it('无 Idempotency-Key → 10001（下单/支付创建为必填，§1.7）', async () => {
    const { interceptor } = build({ scope: 'order' });
    await expect(firstValueFrom(interceptor.intercept(ctx(), handler({ a: 1 })))).rejects.toThrow(
      BizException,
    );
    try {
      await firstValueFrom(interceptor.intercept(ctx(), handler({ a: 1 })));
    } catch (e) {
      expect((e as BizException).code).toBe(ErrorCode.PARAM_INVALID);
    }
  });

  it('未标注 @Idempotent 的接口直接放行', async () => {
    const { interceptor } = build(undefined);
    const data = await firstValueFrom(interceptor.intercept(ctx(), handler({ ok: 1 })));
    expect(data).toEqual({ ok: 1 });
  });

  it('首次放行并写入缓存；重复请求回放首次结果（10006 + data）', async () => {
    const { interceptor, kv } = build({ scope: 'order' });
    const first = { orderNo: 'AB2026091500000001', payAmountFen: 2580 };

    const r1 = await firstValueFrom(interceptor.intercept(ctx('key-1'), handler(first)));
    expect(r1).toEqual(first);

    await flush(); // 等 tap 内的异步写缓存落地
    expect(await kv.get('idem:order:key-1')).toContain('AB2026091500000001');

    // 第二次：即使 handler 返回不同数据，也必须回放首次结果
    try {
      await firstValueFrom(
        interceptor.intercept(ctx('key-1'), handler({ orderNo: 'AB2026091500000002' })),
      );
      throw new Error('应当抛出 10006');
    } catch (e) {
      const err = e as BizException;
      expect(err).toBeInstanceOf(BizException);
      expect(err.code).toBe(ErrorCode.DUPLICATE_SUBMIT);
      expect(err.payload).toEqual(first);
    }
  });

  it('不同幂等键互不影响', async () => {
    const { interceptor } = build({ scope: 'order' });
    const a = await firstValueFrom(interceptor.intercept(ctx('k-a'), handler({ n: 'a' })));
    await flush();
    const b = await firstValueFrom(interceptor.intercept(ctx('k-b'), handler({ n: 'b' })));
    expect(a).toEqual({ n: 'a' });
    expect(b).toEqual({ n: 'b' });
  });

  it('首次请求仍在处理中（占位未回填）→ 10006 且不带 data', async () => {
    const { interceptor, kv } = build({ scope: 'order' });
    await kv.set('idem:order:busy', '__pending__', 600);
    try {
      await firstValueFrom(interceptor.intercept(ctx('busy'), handler({ n: 1 })));
      throw new Error('应当抛出 10006');
    } catch (e) {
      const err = e as BizException;
      expect(err.code).toBe(ErrorCode.DUPLICATE_SUBMIT);
      expect(err.payload).toBeUndefined();
    }
  });

  it('业务失败不写缓存 → 失败可重试（不会把失败固化为幂等成功）', async () => {
    const { interceptor, kv } = build({ scope: 'order' });
    const failing: CallHandler = {
      handle: () => {
        throw new BizException(ErrorCode.ORDER_CUTOFF);
      },
    };
    await expect(
      firstValueFrom(interceptor.intercept(ctx('retry'), failing)),
    ).rejects.toBeInstanceOf(BizException);

    await flush();
    expect(await kv.get('idem:order:retry')).toBe('__pending__');
  });

  it('required:false 时缺头也放行（用于非关键写接口）', async () => {
    const { interceptor } = build({ scope: 'order', required: false });
    const data = await firstValueFrom(interceptor.intercept(ctx(), handler({ ok: true })));
    expect(data).toEqual({ ok: true });
  });
});
