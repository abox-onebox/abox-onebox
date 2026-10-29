import {
  canRevoke,
  deriveBatchNo,
  maskPhone,
  resolveTargets,
  type TargetUserRow,
} from '../../src/common/utils/coupon-batch';

/**
 * 代金券批量发放的纯判据单测（2026-10-29）
 *
 * ## 为什么必须有它
 * 批量发券是「一次操作、几十张券」，而券**发出即承诺**。人群解析 / 幂等 / 回收资格
 * 这三件事**错了不报异常、只会静默发错人** —— 放进 service 就没有任何东西拦得住
 * （本项目没有 coupon service 的单测）。故判据抽成纯函数，由本文件看住。
 *
 * ## 自带自证（恒绿的检查比没有检查更糟）
 * 每组判据都同时给「必命中」与「必不命中」两个样本：
 *   · 黑名单**必须**被排除 / 正常用户**必须**不被排除；
 *   · 未匹配的手机号**必须**回传 / 全部命中时**必须**为空；
 *   · `used` 券**必须**不可撤 / `unused` 券**必须**可撤；
 *   · 同一幂等键**必须**同一批次号 / 不同键**必须**不同。
 * 任一对里少一个方向，本文件就退化成「只验了它本来就会做的事」。
 */
describe('coupon-batch 纯判据', () => {
  const users: TargetUserRow[] = [
    { id: 1, phone: '13800000001', status: 1 },
    { id: 2, phone: '13800000002', status: 1 },
    { id: 3, phone: '13800000003', status: 2 }, // 黑名单
    { id: 4, phone: null, status: 1 }, // 未填手机号
  ];

  // ------------------------------------------------------------------ 人群解析
  describe('resolveTargets', () => {
    it('all：正常用户全中，黑名单被排除且如实计数（两个方向都要验）', () => {
      const r = resolveTargets(users, { scope: 'all' });
      expect(r.paramError).toBeNull();
      expect(r.userIds).toEqual([1, 2, 4]); // 必中：1/2/4
      expect(r.userIds).not.toContain(3); // 必不中：黑名单 3
      expect(r.excludedCount).toBe(1);
    });

    it('all + excludeBlacklist=false：黑名单不被排除（默认口径的反向自证）', () => {
      const r = resolveTargets(users, { scope: 'all', excludeBlacklist: false });
      expect(r.userIds).toEqual([1, 2, 3, 4]);
      expect(r.excludedCount).toBe(0);
    });

    it('building 缺 id → 参数错误，且一个用户都不发（不发错人比报错更可怕）', () => {
      const r = resolveTargets(users, { scope: 'building' });
      expect(r.paramError).toContain('buildingId');
      expect(r.userIds).toEqual([]);
    });

    it('phones：未匹配的号码如实回传，不静默丢弃', () => {
      const r = resolveTargets(users, { scope: 'phones', phones: ['13800000001', '13911111111'] });
      expect(r.unmatchedPhones).toEqual(['13911111111']);
      expect(r.userIds).toEqual([1]);
    });

    it('phones：全部命中时 unmatched 必须为空（防止「永远返回一堆」的假红）', () => {
      const r = resolveTargets(users, { scope: 'phones', phones: ['13800000001', '13800000002'] });
      expect(r.unmatchedPhones).toEqual([]);
      expect(r.userIds).toEqual([1, 2]);
    });

    it('phones：黑名单命中者被排除并计数', () => {
      const r = resolveTargets(users, { scope: 'phones', phones: ['13800000003'] });
      expect(r.userIds).toEqual([]);
      expect(r.excludedCount).toBe(1);
      expect(r.unmatchedPhones).toEqual([]); // 是「被排除」，不是「查无此人」——两者不能混淆
    });

    it('phones：空清单 → 参数错误', () => {
      const r = resolveTargets(users, { scope: 'phones', phones: [] });
      expect(r.paramError).toContain('手机号清单');
    });

    it('userIds：不存在的 id 如实回传；重复 id 去重', () => {
      const r = resolveTargets(users, { scope: 'userIds', userIds: [1, 1, 2, 999] });
      expect(r.userIds).toEqual([1, 2]);
      expect(r.unmatchedUserIds).toEqual([999]);
    });
  });

  // ------------------------------------------------------------------ 脱敏
  describe('maskPhone', () => {
    it('正常号码保留前 3 后 4', () => {
      expect(maskPhone('13800000001')).toBe('138****0001');
    });
    it('空 / 过短给占位文案，不返回空串（空串会被当成「漏了」）', () => {
      expect(maskPhone(null)).toBe('（未填手机号）');
      expect(maskPhone('138')).toBe('（未填手机号）');
    });
  });

  // ------------------------------------------------------------------ 回收资格
  describe('canRevoke', () => {
    it('unused 可撤（必中）', () => {
      expect(canRevoke('unused')).toBe(true);
    });
    it('used / revoked / 空值一律不可撤（必不中）', () => {
      expect(canRevoke('used')).toBe(false);
      expect(canRevoke('revoked')).toBe(false);
      expect(canRevoke(null)).toBe(false);
    });
  });

  // ------------------------------------------------------------------ 批次号
  describe('deriveBatchNo', () => {
    it('同一幂等键 → 同一批次号（幂等成立的前提）', () => {
      expect(deriveBatchNo('k-1', 'aaaaaa')).toBe(deriveBatchNo('k-1', 'bbbbbb'));
    });
    it('不同幂等键 → 不同批次号（否则两批会互相跳过）', () => {
      expect(deriveBatchNo('k-1', 'aaaaaa')).not.toBe(deriveBatchNo('k-2', 'aaaaaa'));
    });
    it('无键时按随机源派生：同随机源同结果、不传则随机（刻意允许发两批）', () => {
      expect(deriveBatchNo(null, 'abcdef')).toBe(deriveBatchNo(undefined, 'abcdef'));
      expect(deriveBatchNo(null)).not.toBe(deriveBatchNo(null));
    });
    it('长度不超过列宽 32', () => {
      expect(deriveBatchNo('k-1', 'aaaaaa').length).toBeLessThanOrEqual(32);
    });
  });
});
