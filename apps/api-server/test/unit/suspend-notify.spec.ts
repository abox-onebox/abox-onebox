import { OrderStatus } from '@abox/shared-types';

import { MESSAGE_TEMPLATE_SPEC_MAP } from '../../src/modules/admin/template/message-template.specs';
import { BuildingAdminService } from '../../src/modules/building/building-admin.service';
import type { NotifyInput, NotifyResult } from '../../src/modules/message/message.service';

/**
 * N2 · 停用通知必须**按单分模板**（spec §6.5 D-N2-3b · AC **B2-14 / N2-AC-07**）
 *
 * ## 为什么必须单独钉这一条
 *
 * `suspend-gate.spec.ts` 断言的是 `decideSuspend()` 的**返回值**（该不该放行），
 * 没人断言最终塞进模板的是哪一句。⇒ **返回值全对、模板全发反，这条链路依然全绿。**
 * 我做过破化自证：把 `refund_applying` 的场景名改成 `building_suspend_fulfill`，
 * 看板 48 条 + jest 115 条**一条都不红**。
 *
 * 后果不是「文案不好看」，是**事实性错误**：一个正在退款的用户会收到
 * 「您的订单照常配送」—— 他会据此**不做午饭安排**，而他的饭根本不会来。
 * 不发是失职，发错是误导。
 *
 * ## ⚠️ 三条断言纪律
 *
 * 1. **绑定到 `orderNo`**，不只断言「两句话都存在」—— 后者在两笔**发反了**的时候照样绿。
 *    （`orderNo` 之所以能拿到，是因为它进了 `variables` 落 `ab_message.payload`，
 *    那是 spec §6.5「事后看得到……是谁」的凭据。）
 * 2. **断言生产模板文本**，不在测试里另抄一份文案 —— 抄一份就等于有了第二份真源，
 *    改模板时这里照样绿。
 * 3. **只有一类订单时只发对应那一种**，不得两类都发 —— 只断言「至少发了一条」
 *    会放过「两封都发了」这种更糟的形状。
 */
const SCENE_FULFILL = 'building_suspend_fulfill';
const SCENE_REFUND = 'building_suspend_refund';

/** 生产模板文案（**不写死**：改了模板这里就红，而不是靠测试里另抄一份）
 *  ⚠️ 只替换 `{{mealDate}}` —— 其余占位符若存在会原样留下，正是我们要断言的对象。 */
const textOf = (scene: string, mealDate: string): string =>
  (MESSAGE_TEMPLATE_SPEC_MAP[scene]?.seed.groupContent ?? '').replaceAll('{{mealDate}}', mealDate);

interface Row {
  id: number;
  orderNo: string;
  userId: number;
  mealDate: string;
  status: OrderStatus;
}

const row = (orderNo: string, status: OrderStatus, mealDate: string, userId: number): Row => ({
  id: Number(orderNo.replace('O', '')),
  orderNo,
  userId,
  mealDate,
  status,
});

/** `notify()` 的入参按 `orderNo` 归位（`variables.orderNo` 是绑定点） */
const byOrderNo = (calls: NotifyInput[]): Map<string, NotifyInput> =>
  new Map(calls.map((c) => [String(c.variables?.orderNo), c]));

function makeSvc(rows: Row[]) {
  const calls: NotifyInput[] = [];
  const orderRepo = { find: jest.fn(async () => rows) };
  const message = {
    notify: jest.fn(async (i: NotifyInput): Promise<NotifyResult> => {
      calls.push(i);
      return { delivered: true, ok: true };
    }),
  };
  const stub = {};
  const svc = new BuildingAdminService(
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    orderRepo as never,
    stub as never,
    message as never,
  );
  /** `notifySuspendAffected()` 是 private —— 测试按契约名调用，不改生产可见性 */
  const run = () =>
    (
      svc as unknown as {
        notifySuspendAffected(scope: 'building', id: number): Promise<number>;
      }
    ).notifySuspendAffected('building', 7);
  return { run, calls, orderRepo, message };
}

describe('停用通知：B 组两小类必须走两套模板', () => {
  it('★ paid ⇒ 照常配送；refund_applying ⇒ 退款处理中（断言绑定到 orderNo）', async () => {
    const rows = [
      row('O1', OrderStatus.PAID, '2026-10-27', 101),
      row('O2', OrderStatus.REFUND_APPLYING, '2026-10-28', 102),
    ];
    const { run, calls } = makeSvc(rows);

    await expect(run()).resolves.toBe(0);

    const m = byOrderNo(calls);
    expect(m.size).toBe(2);
    // ⭐ 绑定：拿到「照常配送」的**必须**是 paid 那笔
    expect(m.get('O1')?.scene).toBe(SCENE_FULFILL);
    expect(m.get('O2')?.scene).toBe(SCENE_REFUND);
    // ⭐ 两笔**发反了**也能被抓住：不是「两句话都存在」就算过
    expect(textOf(SCENE_FULFILL, '2026-10-27')).toContain('照常配送');
    expect(textOf(SCENE_REFUND, '2026-10-28')).not.toContain('照常配送');
    expect(textOf(SCENE_REFUND, '2026-10-28')).not.toContain('照常送达');
  });

  it('★ 每人用自己的出餐日（不是全楼统一一个 mealDate）', async () => {
    const rows = [
      row('O1', OrderStatus.PAID, '2026-10-27', 101),
      row('O2', OrderStatus.PENDING_PAY, '2026-11-02', 102),
    ];
    const { run, calls } = makeSvc(rows);
    await run();

    const m = byOrderNo(calls);
    expect(m.get('O1')?.variables?.mealDate).toBe('2026-10-27');
    expect(m.get('O2')?.variables?.mealDate).toBe('2026-11-02');
    expect(m.get('O1')?.wxData?.mealDate?.value).toBe('2026-10-27');
  });

  it('★ 只有一类订单时只发对应那一种，不得两类都发', async () => {
    const onlyPaid = makeSvc([row('O1', OrderStatus.PAID, '2026-10-27', 101)]);
    await onlyPaid.run();
    expect(onlyPaid.calls).toHaveLength(1);
    expect(onlyPaid.calls[0].scene).toBe(SCENE_FULFILL);

    const onlyRefund = makeSvc([row('O2', OrderStatus.REFUNDING, '2026-10-27', 102)]);
    await onlyRefund.run();
    expect(onlyRefund.calls).toHaveLength(1);
    expect(onlyRefund.calls[0].scene).toBe(SCENE_REFUND);
  });

  it('A 组（已截单及之后）不通知；终态不通知', async () => {
    const rows = [
      row('O1', OrderStatus.CUT_OFF, '2026-10-27', 101),
      row('O2', OrderStatus.COMPLETED, '2026-10-27', 102),
      row('O3', OrderStatus.REFUNDED, '2026-10-27', 103),
    ];
    const { run, message } = makeSvc(rows);
    await expect(run()).resolves.toBe(0);
    expect(message.notify).not.toHaveBeenCalled();
  });
});

describe('停用通知：失败必须如实计数，不静默', () => {
  /** ⚠️ 一期没有微信模板 ID ⇒ 启用闸门拦住 ⇒ `delivered=false`，这是**当前真实状态**。
   *  若这里回 `0`，运营读到的是「都通知到了」—— 不可见的失败比失败本身更糟。 */
  it('★ 场景未启用（delivered=false）也算「没通知到」，不得回 0', async () => {
    const { run, message } = makeSvc([row('O1', OrderStatus.PAID, '2026-10-27', 101)]);
    message.notify.mockResolvedValue({ delivered: false, reason: '场景未启用' });
    await expect(run()).resolves.toBe(1);
  });

  it('通道回报失败（ok=false）同样计入未通知', async () => {
    const { run, message } = makeSvc([row('O1', OrderStatus.PAID, '2026-10-27', 101)]);
    message.notify.mockResolvedValue({ delivered: true, ok: false, errMsg: '43101 用户拒绝接收' });
    await expect(run()).resolves.toBe(1);
  });

  it('查询本身抛错 ⇒ 规模未知，回 1 而不是 0（0 会被读成「都通知到了」）', async () => {
    const { run, orderRepo } = makeSvc([]);
    orderRepo.find.mockRejectedValue(new Error('connection lost'));
    await expect(run()).resolves.toBe(1);
  });
});
