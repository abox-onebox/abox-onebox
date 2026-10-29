import { RefundStatus } from '@abox/shared-types';

import { ErrorCode } from '../../src/common/constants/error-code';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { RefundBatchService } from '../../src/modules/finance/refund-batch.service';

/**
 * E5 · 批量退款**编排**判据
 *
 * 用一个假 `RefundService` 顶掉下游 —— 本文件**不验证退款账务**（那是
 * `refund.service.ts` 的职责），只验证编排层三条要害：
 *   ① 部分成功时**已成功的不会被回滚**、失败的如实列出；
 *   ② 「已不是待审批」归 skipped，不进执行口、也不报红；
 *   ③ 预检不过（id 不存在 / 超限 / 全非法）时**整批零执行**（资金零变动）。
 */

interface Row {
  id: number;
  refundNo: string;
  orderNo: string;
  status: string;
  amount: string;
}

function row(id: number, status: string = RefundStatus.APPLYING): Row {
  return { id, refundNo: `RF${id}`, orderNo: `AB${id}`, status, amount: '25.80' };
}

/** 假仓储：`In(ids)` 的命中集合由 `rows` 决定（查不到的就是「不存在」） */
function fakeRepo(rows: Row[]) {
  return {
    find: async (opts: { where?: { id?: { value?: number[] } } }) => {
      const wanted = opts?.where?.id?.value ?? [];
      return rows.filter((r) => wanted.includes(r.id));
    },
  };
}

/** 假下游：按 id 决定「成功 / 抛哪个码」，并记录调用顺序 */
function fakeRefundService(
  throws: Record<number, ErrorCode> = {},
  opt: { wxDelivered?: boolean; retryQueued?: boolean } = {},
) {
  const calls: { method: 'approve' | 'reject'; id: number; remark?: string; reason?: string }[] =
    [];
  const wxDelivered = opt.wxDelivered ?? true;
  const retryQueued = opt.retryQueued ?? false;

  return {
    calls,
    approveByAdmin: async (id: number, _adminId: number, remark?: string) => {
      calls.push({ method: 'approve', id, remark });
      if (throws[id] !== undefined) throw new BizException(throws[id], `下游拒绝 #${id}`);
      return {
        refundNo: `RF${id}`,
        orderNo: `AB${id}`,
        status: RefundStatus.REFUNDED,
        refundedFen: 2580,
        wxRefundedFen: 1980,
        balanceRefundedFen: 600,
        reversal: {
          commissionReversedFen: 100,
          supplierShareAdjustedFen: 0,
          grossRetainedFen: 0,
        } as never,
        orderStatusBefore: 'paid',
        auditorId: 1,
        auditAt: '2026-10-29T00:00:00.000Z',
        wxDelivered,
        retryQueued,
        tips: '',
      };
    },
    rejectByAdmin: async (id: number, _adminId: number, reason: string) => {
      calls.push({ method: 'reject', id, reason });
      if (throws[id] !== undefined) throw new BizException(throws[id], `下游拒绝 #${id}`);
      return {
        refundNo: `RF${id}`,
        orderNo: `AB${id}`,
        refundStatus: RefundStatus.REJECTED,
        orderStatus: 'paid',
        orderStatusText: '已支付',
        fundsMoved: false as const,
        tips: '',
      };
    },
  };
}

function build(rows: Row[], svc: ReturnType<typeof fakeRefundService>) {
  const batch = new RefundBatchService(fakeRepo(rows) as never, svc as never);
  return { batch, svc };
}

/** 断言「以某个业务码被拒绝」—— 不依赖 jest 对 Error 实例的属性匹配 */
async function expectRejected(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect((e as { code?: number }).code).toBe(code);
    return;
  }
  throw new Error(`本应被拒绝（${ErrorCode[code]}），但调用成功了`);
}

describe('E5 · batchApprove', () => {
  it('全部待审批 → 全部成功，按 ids 顺序串行调用下游', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1), row(2), row(3)], svc);

    const r = await batch.batchApprove([3, 1, 2], 9, '封控整批退');

    expect(r.counts).toEqual({ succeeded: 3, skipped: 0, failed: 0 });
    expect(r.outcome).toBe('ok');
    expect(svc.calls.map((c) => c.id)).toEqual([3, 1, 2]); // 保序
    expect(svc.calls[0].remark).toBe('封控整批退');
    expect(r.amounts.handledFen).toBe(2580 * 3);
  });

  it('⭐ 一单失败 → 其它照常成功（部分成功不回滚），失败进 failed 并带 code', async () => {
    const svc = fakeRefundService({ 2: ErrorCode.REFUND_AMOUNT_MISMATCH });
    const { batch } = build([row(1), row(2), row(3)], svc);

    const r = await batch.batchApprove([1, 2, 3], 9);

    expect(r.counts).toEqual({ succeeded: 2, skipped: 0, failed: 1 });
    expect(r.outcome).toBe('partial');
    expect(r.succeeded.map((s) => s.id)).toEqual([1, 3]); // 失败不拖累前后
    expect(r.failed[0]).toMatchObject({ id: 2, code: ErrorCode.REFUND_AMOUNT_MISMATCH });
    expect(r.tips).toContain('不会重复退');
  });

  it('⭐ 已不是待审批 → skipped，且**不进**执行口', async () => {
    const svc = fakeRefundService();
    const { batch } = build(
      [row(1), row(2, RefundStatus.REFUNDED), row(3, RefundStatus.REJECTED)],
      svc,
    );

    const r = await batch.batchApprove([1, 2, 3], 9);

    expect(r.counts).toEqual({ succeeded: 1, skipped: 2, failed: 0 });
    expect(r.outcome).toBe('ok');
    expect(svc.calls.map((c) => c.id)).toEqual([1]); // 2/3 根本没调下游
    expect(r.skipped.map((s) => s.id)).toEqual([2, 3]);
    expect(r.skipped[0].reason).toContain('不是待审批');
  });

  it('⭐ 并发被抢先（下游抛 40013）→ skipped 而不是 failed（重试不再报红）', async () => {
    const svc = fakeRefundService({ 1: ErrorCode.REFUND_STATUS_ILLEGAL });
    const { batch } = build([row(1), row(2)], svc);

    const r = await batch.batchApprove([1, 2], 9);

    expect(r.counts).toEqual({ succeeded: 1, skipped: 1, failed: 0 });
    expect(r.failed).toHaveLength(0);
    expect(r.skipped[0].id).toBe(1);
  });

  it('所选全都不是待审批 → noop，一笔都没动', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1, RefundStatus.REFUNDED)], svc);

    const r = await batch.batchApprove([1], 9);

    expect(r.outcome).toBe('noop');
    expect(svc.calls).toHaveLength(0);
    expect(r.tips).toContain('未做任何退款');
  });

  it('⭐ 微信通道未受理 → 计入 retryQueuedCount 并在 tips 里提醒别重复审批', async () => {
    const svc = fakeRefundService({}, { wxDelivered: false, retryQueued: true });
    const { batch } = build([row(1), row(2)], svc);

    const r = await batch.batchApprove([1, 2], 9);

    expect(r.counts.succeeded).toBe(2); // 账务已落库，算成功
    expect(r.retryQueuedCount).toBe(2);
    expect(r.tips).toContain('排队重试');
  });

  it('⭐ ids 有不存在 → 整批拒绝，下游一次都没调（资金零变动）', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1)], svc);

    await expectRejected(batch.batchApprove([1, 999], 9), ErrorCode.REFUND_NOT_FOUND);
    expect(svc.calls).toHaveLength(0);
  });

  it('⭐ 超过上限 → 整批拒绝（即便这些 id 全都合法存在）', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => row(i + 1));
    const svc = fakeRefundService();
    const { batch } = build(rows, svc);

    await expectRejected(
      batch.batchApprove(
        rows.map((r) => r.id),
        9,
      ),
      ErrorCode.REFUND_BATCH_TOO_LARGE,
    );
    expect(svc.calls).toHaveLength(0);
  });

  it('全是非法值 → 10001，且未做任何变更', async () => {
    const svc = fakeRefundService();
    const { batch } = build([], svc);

    await expectRejected(batch.batchApprove([0, -1, 'x'], 9), ErrorCode.PARAM_INVALID);
    expect(svc.calls).toHaveLength(0);
  });

  it('重复 id 只执行一次，input 里如实带 dupCount', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1)], svc);

    const r = await batch.batchApprove([1, 1, 1], 9);

    expect(svc.calls).toHaveLength(1);
    expect(r.input).toEqual({ requested: 1, invalidCount: 0, dupCount: 2 });
  });
});

describe('E5 · batchReject', () => {
  it('逐笔透传 reason，成功项带回订单回退后的状态', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1), row(2)], svc);

    const r = await batch.batchReject([1, 2], 9, '联系不上用户');

    expect(r.action).toBe('reject');
    expect(r.counts).toEqual({ succeeded: 2, skipped: 0, failed: 0 });
    expect(svc.calls.map((c) => c.reason)).toEqual(['联系不上用户', '联系不上用户']);
    expect(r.succeeded[0].orderStatus).toBe('paid');
    expect(r.tips).toContain('已驳回');
  });

  it('驳回不改变资金：amounts 的退款口径恒为 0', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1)], svc);

    const r = await batch.batchReject([1], 9, '重复申请');

    expect(r.amounts.wxRefundedFen).toBe(0);
    expect(r.amounts.balanceRefundedFen).toBe(0);
    expect(r.amounts.handledFen).toBe(2580); // 涉及的金额，不是退的金额
  });

  it('缺原状态（40014）→ failed：这种单必须让人看见，不能跳过', async () => {
    const svc = fakeRefundService({ 1: ErrorCode.REFUND_ORIGIN_UNKNOWN });
    const { batch } = build([row(1), row(2)], svc);

    const r = await batch.batchReject([1, 2], 9, '重复申请');

    expect(r.failed[0]).toMatchObject({ id: 1, code: ErrorCode.REFUND_ORIGIN_UNKNOWN });
    expect(r.counts.succeeded).toBe(1);
    expect(r.outcome).toBe('partial');
  });
});
