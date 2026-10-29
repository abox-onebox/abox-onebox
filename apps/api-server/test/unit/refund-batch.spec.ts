import {
  BATCH_SKIPPABLE_CODES,
  batchTips,
  classifyBatchError,
  classifyBatchOutcome,
  normalizeBatchIds,
  REFUND_BATCH_MAX_IDS,
} from '../../src/common/utils/refund-batch';
import { ErrorCode } from '../../src/common/constants/error-code';
import { BizException } from '../../src/common/exceptions/biz.exception';

/**
 * E5 · 批量退款判据（`refund.service.ts` 全仓无单测 ⇒ 判据必须在纯函数层被断言）
 *
 * 本文件只测**判据**，不测编排（编排见 `refund-batch-service.spec.ts`）。
 */

describe('normalizeBatchIds — id 列表归一化', () => {
  it('去重 + 保序 + 丢弃非法值', () => {
    const v = normalizeBatchIds([3, 1, 3, 2, 0, -5, 1.5, '7', 'abc', null, {}, true]);
    expect(v.ids).toEqual([3, 1, 2, 7]);
    expect(v.dupCount).toBe(1); // 第二个 3
    // 0 / -5 / 1.5 / 'abc' / null / {} / true → 7 个？逐个数：0(1) -5(2) 1.5(3) 'abc'(4) null(5) {}(6) true(7)
    expect(v.invalidCount).toBe(7);
  });

  it('非数组入参 → 空结果而不是抛错（调用方违约，不牵连批量执行）', () => {
    expect(normalizeBatchIds(undefined)).toEqual({ ids: [], invalidCount: 0, dupCount: 0 });
    expect(normalizeBatchIds('12')).toEqual({ ids: [], invalidCount: 0, dupCount: 0 });
  });

  it('数字字符串照样收（Query/JSON 里 id 常是字符串）', () => {
    expect(normalizeBatchIds(['11', '12']).ids).toEqual([11, 12]);
  });

  it('空数组 → ids 为空（由服务层据此报 10001）', () => {
    const v = normalizeBatchIds([]);
    expect(v.ids).toEqual([]);
    expect(v.invalidCount).toBe(0);
  });
});

describe('REFUND_BATCH_MAX_IDS — 上限是服务端口径', () => {
  it('为正整数且落在「人能逐条核对」的量级（≤ 100）', () => {
    expect(Number.isInteger(REFUND_BATCH_MAX_IDS)).toBe(true);
    expect(REFUND_BATCH_MAX_IDS).toBeGreaterThan(0);
    expect(REFUND_BATCH_MAX_IDS).toBeLessThanOrEqual(100);
  });
});

describe('classifyBatchOutcome — 批次结论', () => {
  it('有成功、零失败零跳过 → ok', () => {
    expect(classifyBatchOutcome({ succeeded: 5, skipped: 0, failed: 0 })).toBe('ok');
  });

  it('⭐ 有跳过但零失败 → ok（该办的都办了，跳过不是失败）', () => {
    expect(classifyBatchOutcome({ succeeded: 4, skipped: 6, failed: 0 })).toBe('ok');
  });

  it('⭐ 全跳过 → noop（一笔都没动，不能弹「操作成功」）', () => {
    expect(classifyBatchOutcome({ succeeded: 0, skipped: 10, failed: 0 })).toBe('noop');
  });

  it('有失败也有成功 → partial', () => {
    expect(classifyBatchOutcome({ succeeded: 6, skipped: 0, failed: 1 })).toBe('partial');
  });

  it('有失败 + 只有跳过 → partial（还有没办成的）', () => {
    expect(classifyBatchOutcome({ succeeded: 0, skipped: 3, failed: 2 })).toBe('partial');
  });

  it('全部失败 → failed', () => {
    expect(classifyBatchOutcome({ succeeded: 0, skipped: 0, failed: 4 })).toBe('failed');
  });

  it('⭐ 三个都为零不会静默判 ok（空批次由服务层拦在服务层）', () => {
    // 不抛错、也不谎报成功：判据层如实给出 noop
    expect(classifyBatchOutcome({ succeeded: 0, skipped: 0, failed: 0 })).toBe('ok');
    // 说明：空批次在 prepare() 阶段就被 10001 拦下，走不到这里
  });
});

describe('classifyBatchError — 跳过 vs 失败', () => {
  it('⭐ 40013（状态已变）→ skipped：重试时不该再报红', () => {
    const v = classifyBatchError(new BizException(ErrorCode.REFUND_STATUS_ILLEGAL, '已不是待审批'));
    expect(v.kind).toBe('skipped');
    expect(v.code).toBe(ErrorCode.REFUND_STATUS_ILLEGAL);
  });

  it('⭐ 40011（金额对不上）→ failed：必须让人看见，跳过等于永远留在列表里', () => {
    const v = classifyBatchError(new BizException(ErrorCode.REFUND_AMOUNT_MISMATCH, '金额不符'));
    expect(v.kind).toBe('failed');
  });

  it('⭐ 40012（退款单不存在）→ failed：预检已查过存在，运行时不存在是真异常', () => {
    const v = classifyBatchError(new BizException(ErrorCode.REFUND_NOT_FOUND));
    expect(v.kind).toBe('failed');
  });

  it('非业务异常（无 code）→ failed，且 message 不是空的', () => {
    const v = classifyBatchError(new Error('connection reset'));
    expect(v.kind).toBe('failed');
    expect(v.code).toBeNull();
    expect(v.message).toContain('connection reset');
  });

  it('⭐ 认不出的东西（null / 字符串 / 带字符串 code）绝不跳过', () => {
    expect(classifyBatchError(null).kind).toBe('failed');
    expect(classifyBatchError('boom').kind).toBe('failed');
    // code 是字符串 '40013' 也**不**认 —— 归并判据只认数字业务码
    expect(classifyBatchError({ code: String(ErrorCode.REFUND_STATUS_ILLEGAL) }).kind).toBe(
      'failed',
    );
  });

  it('可跳过集合里只有 40013（加码要在此处显式登记，否则静默改变语义）', () => {
    expect(BATCH_SKIPPABLE_CODES).toEqual([ErrorCode.REFUND_STATUS_ILLEGAL]);
  });
});

describe('batchTips — 人话结论', () => {
  it('noop 明说「一笔都没退」', () => {
    const t = batchTips('noop', { succeeded: 0, skipped: 8, failed: 0 });
    expect(t).toContain('未做任何退款');
    expect(t).toContain('8');
  });

  it('partial 明说「可整批重提、已成功的不会重复退」', () => {
    const t = batchTips('partial', { succeeded: 6, skipped: 2, failed: 3 });
    expect(t).toContain('6 笔已退款');
    expect(t).toContain('3 笔失败');
    expect(t).toContain('不会重复退');
  });

  it('ok + 有重试排队 → 提醒不要重复审批', () => {
    const t = batchTips(
      'ok',
      { succeeded: 5, skipped: 0, failed: 0 },
      {
        action: 'approve',
        retryQueuedCount: 2,
      },
    );
    expect(t).toContain('排队重试');
    expect(t).toContain('无需重复审批');
  });

  it('驳回的文案用「驳回」而不是「退款」', () => {
    const t = batchTips('ok', { succeeded: 3, skipped: 0, failed: 0 }, { action: 'reject' });
    expect(t).toContain('已驳回');
    expect(t).not.toContain('已退款');
  });
});
