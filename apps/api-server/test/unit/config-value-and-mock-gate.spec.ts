import { BizConfigService } from '../../src/common/services/biz-config.service';
import { isMissingConfigValue, pickConfigNumber } from '../../src/common/utils/config-value';
import { ErrorCode } from '../../src/common/constants/error-code';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { isProductionRuntime } from '../../src/common/utils/prod-mock-gate';
import { judgeProdMock } from '../../src/common/utils/prod-mock-gate';
import { PaymentService } from '../../src/modules/payment/payment.service';

/**
 * 2026-10-27 两组 src 层缺陷的收口测试
 *
 * ⚠️ 这两条缺陷的共同点：**不抛错、不告警、类型全对**，`tsc` 与 e2e 都过得去。
 *    只有把「缺键」/「NODE_ENV=production」当输入喂进去才会暴露 ⇒ 必须写成单测钉死，
 *    指望集成测试或人工回归根本抓不到。
 */
describe('ab_config 数字取值判据（缺键不得产出 0）', () => {
  it('缺键（null）→ fallback，不是 0', () => {
    expect(pickConfigNumber(null, 20)).toBe(20);
    expect(pickConfigNumber(undefined, 2000)).toBe(2000);
  });

  it('空串 / 纯空白同样算没配（Number("") 也是 0，同一个坑）', () => {
    expect(pickConfigNumber('', 30)).toBe(30);
    expect(pickConfigNumber('   ', 1)).toBe(1);
    expect(isMissingConfigValue('  ')).toBe(true);
  });

  it('非数字 → fallback', () => {
    expect(pickConfigNumber('abc', 20)).toBe(20);
    expect(pickConfigNumber('Infinity', 20)).toBe(20); // 0 之外的另一个"过不了业务"的值
  });

  it('配了 0 就是 0（不许把「配了 0」也当缺键吞掉）', () => {
    expect(pickConfigNumber('0', 20)).toBe(0);
    expect(pickConfigNumber('  0  ', 20)).toBe(0);
    expect(isMissingConfigValue('0')).toBe(false);
  });

  it('正常值照原样', () => {
    expect(pickConfigNumber('5', 20)).toBe(5);
    expect(pickConfigNumber('-1', 20)).toBe(-1);
  });
});

describe('BizConfigService 读数字（服务层实跑）', () => {
  function build(rows: Record<string, string>) {
    const dataSource = {
      getRepository: () => ({
        find: async () =>
          Object.entries(rows).map(([configKey, configValue]) => ({ configKey, configValue })),
      }),
    };
    const svc = new (
      BizConfigService as never as new (ds: unknown, env: unknown) => BizConfigService
    )(dataSource, { get: () => undefined });
    return svc;
  }

  it('缺键时 suspendForceMaxCount 回落 20（缺陷现状：0）', async () => {
    await expect(build({}).suspendForceMaxCount()).resolves.toBe(20);
  });

  it('缺键时提现日额/日笔回落 2000 / 1（缺陷现状：0 = 不限，fail-open）', async () => {
    const svc = build({});
    await expect(svc.withdrawDailyLimit()).resolves.toBe(2000);
    await expect(svc.withdrawDailyCount()).resolves.toBe(1);
  });

  it('缺键时支付超时回落 30（缺陷现状：0 = 创建即过期）', async () => {
    await expect(build({}).payTimeoutMinutes()).resolves.toBe(30);
  });

  /**
   * ⭐ 口径：**不限起提**（项目负责人 2026-10-27 裁定）。
   *
   * 2026-10-27 白天曾按 `docs/ABox一盒接口规范v1.0.md` 的旧文案（≥ ¥10.00）把缺省改成 10，
   * 负责人复核后明确要「不限起提」，代码 / 文档 / seed / 门禁 / e2e 五处一并回 0。
   * ⇒ 本条断言**跟着口径走**：要改成 10 必须先重新签字，否则单测会先红。
   *
   * 注意与上一组的区别（别混淆）：`suspendForceMaxCount` 缺键**必须**回落 20，
   * 而 `minWithdraw` 缺键**必须**是 0 —— 因为 0 在后者是业务上想要的真值，
   * 不是「没配」。`isMissingConfigValue` 只管「有没有配」，语义由调用点的 fallback 决定。
   */
  it('缺键时最低提现额为 0（不限起提 · 2026-10-27 裁定）', async () => {
    await expect(build({}).minWithdraw()).resolves.toBe(0);
  });

  it('【自证】最低提现额三态：缺键→0（不限起提）· "0.00"→0 · "10.00"→10（显式设门槛）', async () => {
    await expect(build({}).minWithdraw()).resolves.toBe(0);
    await expect(build({ 'commission.min_withdraw': '0.00' }).minWithdraw()).resolves.toBe(0);
    // 显式配正数必须真的生效（运营想设门槛时靠配值，不靠「键不存在」）
    await expect(build({ 'commission.min_withdraw': '10.00' }).minWithdraw()).resolves.toBe(10);
    await expect(build({ 'commission.min_withdraw': '20.00' }).minWithdraw()).resolves.toBe(20);
  });

  it('显式配 0 仍然生效（不许把「运营就是要 0」也抹掉）', async () => {
    const svc = build({ 'building.suspend_force_max_count': '0' });
    await expect(svc.suspendForceMaxCount()).resolves.toBe(0);
  });

  /**
   * ⭐ 自证核心：同一个键的三种状态必须走向三个不同结果。
   *    「缺键」与「配了 0」若合并，这里的 0 就会变成 20 —— 而 `withdraw.service`
   *    把 0 解释成「不限」，后果是提现限额被悄悄打开/关闭。
   */
  it('【自证】同一键三态：缺键→fallback(20) · "0"→0 · "5"→5', async () => {
    await expect(build({}).suspendForceMaxCount()).resolves.toBe(20);
    await expect(
      build({ 'building.suspend_force_max_count': '0' }).suspendForceMaxCount(),
    ).resolves.toBe(0);
    await expect(
      build({ 'building.suspend_force_max_count': '5' }).suspendForceMaxCount(),
    ).resolves.toBe(5);
  });

  it('【自证】提现两条：缺键→2000/1（不再「不限」）· 显式配 0→0（保留「不限」语义）', async () => {
    const missing = build({});
    await expect(missing.withdrawDailyLimit()).resolves.toBe(2000);
    await expect(missing.withdrawDailyCount()).resolves.toBe(1);

    const zeroed = build({
      'commission.withdraw_daily_limit': '0',
      'commission.withdraw_daily_count': '0',
    });
    await expect(zeroed.withdrawDailyLimit()).resolves.toBe(0);
    await expect(zeroed.withdrawDailyCount()).resolves.toBe(0);
  });

  it('供价缺省：缺键→14.0；而库里真实存在的 "0.00" 三项必须保持 0（不被当成缺键）', async () => {
    const missing = build({});
    await expect(missing.settlementCostItems()).resolves.toMatchObject({ supplierTotal: 14 });

    const asInProd = build({
      'settlement.site_fee': '0.00',
      'settlement.packing_labor_fee': '0.00',
      'settlement.delivery_fee': '0.00',
    });
    await expect(asInProd.settlementCostItems()).resolves.toMatchObject({
      siteFee: 0,
      packingLaborFee: 0,
      deliveryFee: 0,
    });
  });
});

describe('生产进程判据（单一真源）', () => {
  it('只认 production，且 trim', () => {
    expect(isProductionRuntime('production')).toBe(true);
    expect(isProductionRuntime(' production ')).toBe(true);
    expect(isProductionRuntime('PRODUCTION')).toBe(false);
    expect(isProductionRuntime('prod')).toBe(false);
    expect(isProductionRuntime(undefined)).toBe(false);
    expect(isProductionRuntime('')).toBe(false);
  });

  it('prod-mock-gate 与本判据同口径（避免两份 === "production"）', () => {
    expect(judgeProdMock({ nodeEnv: 'production', providerMode: 'mock' }).allow).toBe(false);
    expect(judgeProdMock({ nodeEnv: 'test', providerMode: 'mock' }).allow).toBe(true);
  });
});

describe('/pay/mock/paid 生产闸门', () => {
  function build() {
    const svc = new (
      PaymentService as never as new (o: unknown, w: unknown, c: unknown) => PaymentService
    )({ payAmountFenOf: async () => 100 }, { isMock: true, simulatePaid: async () => true }, {});
    return svc;
  }

  const withEnv = async (v: string | undefined, fn: () => Promise<unknown>) => {
    const old = process.env.NODE_ENV;
    if (v === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = v;
    try {
      return await fn();
    } finally {
      if (old === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = old;
    }
  };

  it('NODE_ENV=production → 无条件拒绝（mock 通道也不放行）', async () => {
    await withEnv('production', async () => {
      await expect(build().simulatePaid('AB1')).rejects.toBeInstanceOf(BizException);
      await expect(build().simulatePaid('AB1')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  it('非生产 + mock → 放行（e2e / 本地调试不受影响）', async () => {
    await withEnv('test', async () => {
      await expect(build().simulatePaid('AB1')).resolves.toEqual({ triggered: true });
    });
  });
});
