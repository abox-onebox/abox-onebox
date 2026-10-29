import { ConfigService } from '@nestjs/config';

import { PayReconcileService } from '../../src/modules/payment/pay-reconcile.service';
import { MockWxPayProvider } from '../../src/providers/wx-pay/mock-wx-pay.provider';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { ErrorCode } from '../../src/common/constants/error-code';

/**
 * P3 · 补齐链路的**服务级**证据（2026-10-29）
 *
 * 与 `pay-reconcile.spec.ts` 的分工：那份测的是**判据纯函数**（给定查单结果该做什么），
 * 这份测的是**编排**：会不会真的去调 `markPaid`、查单失败时会不会真的不动单。
 *
 * ⭐ 关键：**用真实的 `MockWxPayProvider`**，不是另写一个假的 ——
 *    mock 通道在本轮被改成「记账式」（`createPrepay` 记 NOTPAY、`markPaidSilently` 记 SUCCESS
 *    但不发事件），所以「钱已付、回调丢了」这个单边账能被**真造出来**，
 *    补齐因此是**被跑过**的，不是被推演的。
 *
 * ⚠️ `payAutoSuccess` 必须关掉：否则 `createPrepay` 会延迟自动回调，
 *    订单当场就转 paid，根本轮不到「查单补齐」—— 测试会假绿。
 */

const cfg = { get: (_k: string) => false } as unknown as ConfigService;

/** 假的订单服务：只记录被调用了什么（**不碰数据库**） */
class FakeOrderService {
  rows: Array<{ id: number; orderNo: string; payAmountFen: number; createdAt: Date | null }> = [];
  markPaidCalls: Array<{ orderNo: string; amountFen: number }> = [];
  /** 让 `markPaid` 返回「并发落空」，用于验证「不算 paid」 */
  forceUnchanged = false;

  async listStalePendingPay() {
    return this.rows;
  }

  async markPaid(orderNo: string, _txn: string, amountFen: number) {
    this.markPaidCalls.push({ orderNo, amountFen });
    return this.forceUnchanged ? { changed: false, reason: 'status=paid' } : { changed: true };
  }
}

const makeProvider = () => new MockWxPayProvider(cfg);

/** 用真 provider 包一层：只暴露 `queryOrder`（与 `WxpayService` 的契约一致） */
class FakeWxpayService {
  constructor(private readonly provider: MockWxPayProvider) {}
  queryOrder(orderNo: string) {
    return this.provider.queryOrder({ orderNo });
  }
}

/** 会抛 `PAY_QUERY_FAILED` 的通道 —— 模拟「微信挂了 / 网络不通」 */
class BrokenWxpayService {
  calls = 0;
  async queryOrder(): Promise<never> {
    this.calls += 1;
    throw new BizException(ErrorCode.PAY_QUERY_FAILED);
  }
}

const row = (orderNo: string, fen: number) => ({
  id: 1,
  orderNo,
  payAmountFen: fen,
  createdAt: new Date('2026-10-29T10:00:00+08:00'),
});

describe('PayReconcileService · 回调丢失的补齐链路', () => {
  it('⭐ 钱已付但回调丢失 → 查单补齐，且真的调了 markPaid', async () => {
    const provider = makeProvider();
    const orders = new FakeOrderService();
    const svc = new PayReconcileService(orders as never, new FakeWxpayService(provider) as never);

    // ① 下单（微信侧记 NOTPAY）→ ② 静默支付（**不发回调**）＝ 单边账
    await provider.createPrepay({
      orderNo: 'AB001',
      amountFen: 2580,
      description: 'x',
      openid: 'o',
    });
    provider.markPaidSilently('AB001', 2580);
    orders.rows = [row('AB001', 2580)];

    const out = await svc.reconcile({ graceMinutes: 5 });

    expect(out.scanned).toBe(1);
    expect(out.paid).toBe(1);
    expect(out.failed).toBe(0);
    expect(orders.markPaidCalls).toEqual([{ orderNo: 'AB001', amountFen: 2580 }]);
  });

  it('⛔ 查单失败 → 计 failed 且**绝不**动单（不调 markPaid）', async () => {
    const orders = new FakeOrderService();
    const broken = new BrokenWxpayService();
    const svc = new PayReconcileService(orders as never, broken as never);

    orders.rows = [row('AB002', 2580)];
    const out = await svc.reconcile({ graceMinutes: 5 });

    expect(out.failed).toBe(1);
    expect(out.paid).toBe(0);
    expect(orders.markPaidCalls).toHaveLength(0); // 命门：查不动 ≠ 没付
    expect(broken.calls).toBe(1);
  });

  it('微信明确未支付（NOTPAY）→ 不动单，也不计 paid', async () => {
    const provider = makeProvider();
    const orders = new FakeOrderService();
    const svc = new PayReconcileService(orders as never, new FakeWxpayService(provider) as never);

    // 只下单、不支付 ⇒ 微信账本里是 NOTPAY
    await provider.createPrepay({
      orderNo: 'AB003',
      amountFen: 2580,
      description: 'x',
      openid: 'o',
    });
    orders.rows = [row('AB003', 2580)];

    const out = await svc.reconcile({ graceMinutes: 5 });

    expect(out.paid).toBe(0);
    expect(out.stillUnpaid).toBe(1);
    expect(orders.markPaidCalls).toHaveLength(0);
  });

  it('微信查无此单（订单号未送达）→ 计 notFound，不动单', async () => {
    const provider = makeProvider();
    const orders = new FakeOrderService();
    const svc = new PayReconcileService(orders as never, new FakeWxpayService(provider) as never);

    orders.rows = [row('AB_NEVER_SENT', 2580)]; // 从未 createPrepay
    const out = await svc.reconcile({ graceMinutes: 5 });

    expect(out.notFound).toBe(1);
    expect(out.paid).toBe(0);
    expect(orders.markPaidCalls).toHaveLength(0);
  });

  it('金额不符 → 计 mismatch 且**不**入账', async () => {
    const provider = makeProvider();
    const orders = new FakeOrderService();
    const svc = new PayReconcileService(orders as never, new FakeWxpayService(provider) as never);

    await provider.createPrepay({
      orderNo: 'AB004',
      amountFen: 2580,
      description: 'x',
      openid: 'o',
    });
    provider.markPaidSilently('AB004', 1); // 微信侧只付了 1 分（与本地 2580 不符）
    orders.rows = [row('AB004', 2580)];

    const out = await svc.reconcile({ graceMinutes: 5 });

    expect(out.mismatch).toBe(1);
    expect(out.paid).toBe(0);
    expect(orders.markPaidCalls).toHaveLength(0);
  });

  it('markPaid 并发落空（订单已变化）→ 不计 paid（不谎称补齐成功）', async () => {
    const provider = makeProvider();
    const orders = new FakeOrderService();
    orders.forceUnchanged = true;
    const svc = new PayReconcileService(orders as never, new FakeWxpayService(provider) as never);

    await provider.createPrepay({
      orderNo: 'AB005',
      amountFen: 2580,
      description: 'x',
      openid: 'o',
    });
    provider.markPaidSilently('AB005', 2580);
    orders.rows = [row('AB005', 2580)];

    const out = await svc.reconcile({ graceMinutes: 5 });

    expect(out.paid).toBe(0);
    expect(out.stillUnpaid).toBe(1);
  });

  // ==================== 自证 ====================

  it('自证：本套用例既覆盖「补齐成功」也覆盖「不动单」（不是恒绿）', async () => {
    const provider = makeProvider();
    const orders = new FakeOrderService();
    const svc = new PayReconcileService(orders as never, new FakeWxpayService(provider) as never);
    await provider.createPrepay({
      orderNo: 'AB006',
      amountFen: 2580,
      description: 'x',
      openid: 'o',
    });
    provider.markPaidSilently('AB006', 2580);
    orders.rows = [row('AB006', 2580)];
    const ok = await svc.reconcile({ graceMinutes: 5 });

    const orders2 = new FakeOrderService();
    const svc2 = new PayReconcileService(orders2 as never, new BrokenWxpayService() as never);
    orders2.rows = [row('AB007', 2580)];
    const bad = await svc2.reconcile({ graceMinutes: 5 });

    expect(ok.paid).toBe(1);
    expect(bad.paid).toBe(0);
  });
});
