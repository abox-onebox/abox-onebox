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
  /** 所属订单的配送日（条件批量用） */
  mealDate: string;
  /** 所属订单的楼宇（条件批量用） */
  buildingId: number;
}

function row(
  id: number,
  status: string = RefundStatus.APPLYING,
  opt: { mealDate?: string; buildingId?: number } = {},
): Row {
  return {
    id,
    refundNo: `RF${id}`,
    orderNo: `AB${id}`,
    status,
    amount: '25.80',
    mealDate: opt.mealDate ?? '2026-10-30',
    buildingId: opt.buildingId ?? 1,
  };
}

/**
 * 假仓储
 *
 * · `find` 走 `In(ids)`（查不到的就是「不存在」）
 * · `createQueryBuilder` 只认**条件批量**那一种链式写法：
 *   `select → where(status) → andWhere(order_id IN (... meal_date ... [building_id])) → orderBy → getMany`
 *   —— 假实现按 `params` 里的 `mealDate` / `bid` 过滤，测的是**编排**不是 SQL 方言。
 */
function fakeRepo(rows: Row[]) {
  const state: { st?: string; mealDate?: string; bid?: number } = {};

  const qb = {
    select: () => qb,
    where: (_sql: string, p?: { st?: string }) => {
      state.st = p?.st;
      return qb;
    },
    andWhere: (_sql: string, p?: { mealDate?: string; bid?: number }) => {
      if (p?.mealDate !== undefined) state.mealDate = p.mealDate;
      if (p?.bid !== undefined) state.bid = p.bid;
      return qb;
    },
    orderBy: () => qb,
    getMany: async () =>
      rows.filter(
        (r) =>
          r.status === state.st &&
          r.mealDate === state.mealDate &&
          (state.bid === undefined || r.buildingId === state.bid),
      ),
  };

  return {
    createQueryBuilder: () => qb,
    find: async (opts: { where?: { id?: { value?: number[] } } }) => {
      const wanted = opts?.where?.id?.value ?? [];
      return rows.filter((r) => wanted.includes(r.id));
    },
  };
}

/** 假楼宇仓储：`id=1` 存在，其余不存在（测「条件写错不能在钱上试出来」） */
function fakeBuildingRepo() {
  return {
    findOne: async (opts: { where?: { id?: number } }) =>
      opts?.where?.id === 1 ? { id: 1, name: '望京 SOHO' } : null,
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
  const batch = new RefundBatchService(
    fakeRepo(rows) as never,
    fakeBuildingRepo() as never,
    svc as never,
  );
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

describe('E5 · 按配送日 / 楼宇批量（台账原始口径）', () => {
  const scope = { mealDate: '2026-10-30', buildingId: 1 };

  it('预览：只算不执行 —— 命中数、金额、楼宇名，**零资金动作**', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1), row(2)], svc);

    const p = await batch.previewScope(scope);

    expect(p.count).toBe(2);
    expect(p.amountFen).toBe(2580 * 2);
    expect(p.scopeLabel).toContain('望京 SOHO'); // 确认弹窗里不出现「楼宇#1」
    expect(p.sample).toHaveLength(2);
    expect(p.warnings.join('')).toContain('不可撤销');
    expect(svc.calls).toHaveLength(0); // ⭐ 预览绝不碰下游
  });

  it('只命中「待审批」—— 已处理过的单不进命中集（断点续退的前提）', async () => {
    const svc = fakeRefundService();
    const { batch } = build(
      [row(1), row(2, RefundStatus.REFUNDED), row(3, RefundStatus.REJECTED)],
      svc,
    );

    const p = await batch.previewScope(scope);

    expect(p.count).toBe(1);
    expect(p.sample[0].id).toBe(1);
  });

  it('⭐ 预览数字与执行时不一致 → 40029（看到的 ≠ 要退的）', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1), row(2)], svc);

    await expectRejected(
      batch.approveByScope(scope, { count: 5, amountFen: 2580 * 2 }, 9, undefined, 50),
      ErrorCode.REFUND_BATCH_SCOPE_CHANGED,
    );
    expect(svc.calls).toHaveLength(0);
  });

  it('⭐ 笔数相同但金额变了也要拒（一笔被驳回 + 一笔新提交）', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1), row(2)], svc);

    await expectRejected(
      batch.approveByScope(scope, { count: 2, amountFen: 1 }, 9, undefined, 50),
      ErrorCode.REFUND_BATCH_SCOPE_CHANGED,
    );
    expect(svc.calls).toHaveLength(0);
  });

  it('⭐ 断点续退：命中 60 笔 → 本次只处理 50，remaining=10', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i + 1));
    const svc = fakeRefundService();
    const { batch } = build(rows, svc);

    const p = await batch.previewScope(scope);
    expect(p.warnings.join('')).toContain('一次最多处理 50 笔');

    const r = await batch.approveByScope(
      scope,
      { count: p.count, amountFen: p.amountFen },
      9,
      undefined,
      50,
    );

    expect(svc.calls).toHaveLength(50);
    expect(r.remaining).toBe(10);
    expect(r.nextTip).toContain('还剩 10 笔');
  });

  it('⭐ 再点一次只处理剩下的（已处理的不重复退）', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i + 1));
    const svc = fakeRefundService();
    const { batch } = build(rows, svc);

    const p1 = await batch.previewScope(scope);
    await batch.approveByScope(
      scope,
      { count: p1.count, amountFen: p1.amountFen },
      9,
      undefined,
      50,
    );
    // 模拟数据库真实变化：处理过的单已不是待审批
    rows.slice(0, 50).forEach((r) => {
      r.status = RefundStatus.REFUNDED;
    });

    const p2 = await batch.previewScope(scope);
    const r2 = await batch.approveByScope(
      scope,
      { count: p2.count, amountFen: p2.amountFen },
      9,
      undefined,
      50,
    );

    expect(p2.count).toBe(10);
    expect(r2.counts.succeeded).toBe(10);
    expect(r2.remaining).toBe(0);
    expect(r2.nextTip).toBeNull();
    expect(svc.calls).toHaveLength(60); // 50 + 10，**没有一笔被退两次**
  });

  it('楼宇不存在 → 拒绝（条件写错不能在钱上试出来）', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1)], svc);

    await expectRejected(
      batch.previewScope({ mealDate: '2026-10-30', buildingId: 9 }),
      ErrorCode.BUILDING_NOT_FOUND,
    );
    await expectRejected(
      batch.approveByScope(
        { mealDate: '2026-10-30', buildingId: 9 },
        { count: 1, amountFen: 2580 },
        9,
        undefined,
        50,
      ),
      ErrorCode.BUILDING_NOT_FOUND,
    );
    expect(svc.calls).toHaveLength(0);
  });

  it('命中为空 → 拒绝执行（而不是「成功退了 0 笔」）', async () => {
    const svc = fakeRefundService();
    const { batch } = build([], svc);

    const p = await batch.previewScope(scope);
    expect(p.count).toBe(0);
    expect(p.warnings.join('')).toContain('没有');

    await expectRejected(
      batch.approveByScope(scope, { count: 0, amountFen: 0 }, 9, undefined, 50),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('按条件驳回同理：逐笔透传 reason，其余口径与通过一致', async () => {
    const svc = fakeRefundService();
    const { batch } = build([row(1), row(2)], svc);

    const p = await batch.previewScope(scope);
    const r = await batch.rejectByScope(
      scope,
      { count: p.count, amountFen: p.amountFen },
      9,
      '整栋楼停配送',
      50,
    );

    expect(r.action).toBe('reject');
    expect(svc.calls.map((c) => c.reason)).toEqual(['整栋楼停配送', '整栋楼停配送']);
    expect(r.remaining).toBe(0);
  });
});
