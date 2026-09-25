import { MAX_RANGE_DAYS, rateOf, sceneOf } from '../../src/modules/message/message-reach.service';

/**
 * F5 通知到达率 · 纯函数单测（见《接口规范 v1.0》§6.7）
 *
 * ⚠️ 本文件存在的理由：`message-reach.service.ts` 把这三个纯函数导出时写的是
 *    「导出供 e2e 直接单测，**避免「只有 HTTP 一条验证路径」**」—— 而此前**无人引用**，
 *    那句话是**空头承诺**（e2e §39 断的是 HTTP 出参，仍只算一条路径）。
 *    本文件让那条声明**成立**：不经 HTTP、不经库，直接钉住规则本身。
 *
 * 依据：到达率「无记录 → `null`，不是 `0`」是本批**最容易被写错**的一条 ——
 *      `0` 会被读成「发出去的全失败」，两者语义相反，而页面上恰好都要显示。
 */
describe('通知到达率 · 纯函数（F5）', () => {
  it('分母为 0 ⇒ null（**不是** 0）', () => {
    expect(rateOf({ attempted: 0, success: 0 })).toBeNull();
  });

  it('正常比值取四位小数', () => {
    expect(rateOf({ attempted: 3, success: 2 })).toBe(0.6667);
    expect(rateOf({ attempted: 4, success: 4 })).toBe(1);
  });

  it('「全失败 = 0」与「没发过 = null」必须是两个不同的值', () => {
    const allFailed = rateOf({ attempted: 5, success: 0 });
    const neverSent = rateOf({ attempted: 0, success: 0 });
    expect(allFailed).toBe(0);
    expect(neverSent).toBeNull();
    // 反向锁定：若有人把 `attempted ? … : null` 写成 `… || 0`，两者会**相等** ⇒ 本行必红
    expect(allFailed).not.toBe(neverSent);
  });

  it('场景键：对象与文本两种 payload 形态都认（换驱动后统计不会全落进「未标注」）', () => {
    expect(sceneOf({ scene: 'delivering' })).toBe('delivering');
    expect(sceneOf('{"scene":"delivering"}')).toBe('delivering');
  });

  it('场景键：认不出时归入「未标注场景」而不是丢弃（丢行会让合计对不上）', () => {
    expect(sceneOf(null)).toBe('(未标注场景)');
    expect(sceneOf({})).toBe('(未标注场景)');
    expect(sceneOf({ scene: '   ' })).toBe('(未标注场景)');
    expect(sceneOf({ scene: 123 })).toBe('(未标注场景)');
    // 与上一条**刻意分码**：文本解析失败是另一类信息（驱动给了非 JSON 的东西）
    expect(sceneOf('not json')).toBe('(无法解析 payload)');
  });

  it('区间上限 = 90 天（与 ab_message 的 90 天保留期对齐）', () => {
    expect(MAX_RANGE_DAYS).toBe(90);
  });
});
