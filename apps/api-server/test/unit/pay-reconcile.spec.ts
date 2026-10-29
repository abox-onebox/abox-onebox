import { decideReconcileAction, ReconcileAction } from '../../src/common/utils/pay-reconcile';
import type { QueryOrderResult } from '../../src/providers/wx-pay/wx-pay.provider';

/**
 * P3 · 支付单边账补齐的判据（2026-10-29）
 *
 * ## 这份单测要拦的三类**静默**错误
 * ① **「查不到」被当成「没付」** ⇒ 钱已收、单被关（资金差错，本 P0 的头号风险）；
 * ② **`REFUND` 被当成已支付** ⇒ 付过又退的订单凭空补出一笔已付流水；
 * ③ **金额不符也照样入账** ⇒ 伪造/篡改金额的单被补齐成正常单。
 *
 * 三者都不抛异常、不崩溃，只会让账「悄悄错」，故必须逐条喂样本断言。
 *
 * ## ⚠️ 自证：判据既不恒绿也不恒红
 * 末尾两个用例分别断言「四种动作**都被样本覆盖**」与「存在**非** paid 的样本」——
 * 若有人把 `decideReconcileAction` 改成一行 `return { action: 'paid' }`，
 * 前面的用例会红；若改成恒返回 `still_unpaid`，覆盖度用例会红。
 */

const q = (p: Partial<QueryOrderResult>): QueryOrderResult => ({
  found: true,
  tradeState: 'SUCCESS',
  paid: true,
  amountFen: 2580,
  ...p,
});

describe('decideReconcileAction · P3 查单补齐判据', () => {
  it('微信 SUCCESS 且金额一致 → paid（补齐的主路径）', () => {
    const d = decideReconcileAction({ payAmountFen: 2580, query: q({ tradeState: 'SUCCESS' }) });
    expect(d.action).toBe<ReconcileAction>('paid');
  });

  it('微信 SUCCESS 但金额不符 → amount_mismatch，**绝不入账**', () => {
    const d = decideReconcileAction({
      payAmountFen: 2580,
      query: q({ tradeState: 'SUCCESS', amountFen: 1 }),
    });
    expect(d.action).toBe<ReconcileAction>('amount_mismatch');
  });

  it('微信 SUCCESS 但没给金额 → amount_mismatch（防按未知金额入账）', () => {
    const d = decideReconcileAction({
      payAmountFen: 2580,
      query: q({ tradeState: 'SUCCESS', amountFen: undefined }),
    });
    expect(d.action).toBe<ReconcileAction>('amount_mismatch');
  });

  it('微信明确 NOTPAY → still_unpaid（不动单，交截单流程）', () => {
    const d = decideReconcileAction({
      payAmountFen: 2580,
      query: q({ tradeState: 'NOTPAY', paid: false }),
    });
    expect(d.action).toBe<ReconcileAction>('still_unpaid');
  });

  it('微信 CLOSED / PAYERROR / REVOKED / ACCEPT → 一律 still_unpaid', () => {
    for (const st of ['CLOSED', 'PAYERROR', 'REVOKED', 'ACCEPT'] as const) {
      const d = decideReconcileAction({
        payAmountFen: 2580,
        query: q({ tradeState: st, paid: false }),
      });
      expect(d.action).toBe<ReconcileAction>('still_unpaid');
    }
  });

  it('⛔ REFUND（付过又退）→ 不可入账（不是 paid）', () => {
    const d = decideReconcileAction({
      payAmountFen: 2580,
      query: q({ tradeState: 'REFUND', paid: false }),
    });
    expect(d.action).not.toBe<ReconcileAction>('paid');
    expect(d.action).toBe<ReconcileAction>('still_unpaid');
  });

  it('⛔ found=false（微信无此单）→ not_found，**不是** still_unpaid（两者处理不同）', () => {
    const d = decideReconcileAction({
      payAmountFen: 2580,
      query: q({ found: false, tradeState: 'UNKNOWN', paid: false, amountFen: undefined }),
    });
    expect(d.action).toBe<ReconcileAction>('not_found');
  });

  it('found=true 但状态 UNKNOWN（拿到了回答却看不懂）→ 不可入账', () => {
    const d = decideReconcileAction({
      payAmountFen: 2580,
      query: q({ tradeState: 'UNKNOWN', paid: false }),
    });
    expect(d.action).not.toBe<ReconcileAction>('paid');
  });

  it('每条动作都带人话说明（后台补跑回执要能不读码就懂）', () => {
    const d = decideReconcileAction({ payAmountFen: 2580, query: q({ tradeState: 'SUCCESS' }) });
    expect(d.note.length).toBeGreaterThan(0);
  });

  // ==================== 自证（防判据恒绿 / 恒红） ====================

  it('自证：四种动作全部被样本覆盖（判据不是恒返回同一格）', () => {
    const samples: Array<[number, QueryOrderResult]> = [
      [2580, q({ tradeState: 'SUCCESS' })],
      [2580, q({ tradeState: 'SUCCESS', amountFen: 1 })],
      [2580, q({ tradeState: 'NOTPAY', paid: false })],
      [2580, q({ found: false, tradeState: 'UNKNOWN', paid: false })],
    ];
    const actions = new Set(
      samples.map(([fen, query]) => decideReconcileAction({ payAmountFen: fen, query }).action),
    );
    expect(actions).toEqual(
      new Set<ReconcileAction>(['paid', 'amount_mismatch', 'still_unpaid', 'not_found']),
    );
  });

  it('自证：存在「不该入账」的样本（判据不是恒 paid）', () => {
    const d = decideReconcileAction({
      payAmountFen: 2580,
      query: q({ tradeState: 'NOTPAY', paid: false }),
    });
    expect(d.action).not.toBe<ReconcileAction>('paid');
  });
});
