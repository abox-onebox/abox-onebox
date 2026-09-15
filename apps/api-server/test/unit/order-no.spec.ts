import { genOrderNo, genRefundNo, genShareNo, isOrderNo } from '../../src/common/utils/order-no';

/**
 * 业务单号（《接口规范》§1.6 / U10 示例 `AB2026091500071234`）
 * 格式：前缀 + yyyyMMdd(北京时间) + 8 位随机数字 → 共 18 字符 ≤ varchar(32)
 */
describe('业务单号生成', () => {
  const at = new Date('2026-09-15T03:00:00.000Z'); // 北京时间 2026-09-15 11:00

  it('订单号 = AB + yyyyMMdd + 8 位数字（共 18 字符）', () => {
    const no = genOrderNo(at);
    expect(no).toMatch(/^AB20260915\d{8}$/);
    expect(no).toHaveLength(18);
    expect(isOrderNo(no)).toBe(true);
  });

  it('退款单号 / 应付单号前缀分别为 RF / SH', () => {
    expect(genRefundNo(at)).toMatch(/^RF20260915\d{8}$/);
    expect(genShareNo(at)).toMatch(/^SH20260915\d{8}$/);
  });

  it('连续生成 200 个订单号无重复（随机段 8 位）', () => {
    const set = new Set(Array.from({ length: 200 }, () => genOrderNo(at)));
    expect(set.size).toBe(200);
  });

  it('isOrderNo 拒绝非法格式（长度/前缀/字符）', () => {
    expect(isOrderNo('AB2026091500071234')).toBe(true);
    expect(isOrderNo('AB202609150007123')).toBe(false); // 少了 1 位
    expect(isOrderNo('XX2026091500071234')).toBe(false); // 前缀错
    expect(isOrderNo('AB202609150007123a')).toBe(false); // 非数字
  });
});
