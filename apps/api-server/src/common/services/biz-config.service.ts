import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { BIZ, SETTLEMENT_DEFAULTS, SettlementCostItems } from '@abox/shared-utils';

import { SysConfig } from '../../database/entities/system.entity';

/**
 * 业务参数读取器（唯一入口 · 读 `ab_config`）
 *
 * 纪律（《协作规范 v1.0》第 4 处最容易踩）：
 *   **成本项与费率一律不得在业务代码里写死** —— 运行期以 `ab_config` 为准，
 *   本服务是代码访问该表的**唯一入口**（避免各处自行查表导致口径漂移）。
 *
 * 锁定项（不随配置漂移，仅作缺省兜底）：售价 ¥25.80 · 4 级佣金 8/9/10/12%
 * 可变项（按实际执行）：供应商供价 / 场地费 / 打包人工 / 配送费
 *
 * 缓存：进程内 60s TTL（后台改配置后最多 1 分钟生效）；
 *      需要即时生效的场景调用 `invalidate()`。
 */
@Injectable()
export class BizConfigService {
  private readonly logger = new Logger('BizConfig');
  private readonly ttlMs = 60_000;
  private rows = new Map<string, string>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly env: ConfigService,
  ) {}

  /** 载入（带 TTL 与并发合并） */
  private async ensureLoaded(): Promise<void> {
    if (Date.now() - this.loadedAt < this.ttlMs && this.rows.size > 0) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        const list = await this.dataSource.getRepository(SysConfig).find();
        const next = new Map<string, string>();
        for (const r of list) next.set(r.configKey, r.configValue);
        this.rows = next;
        this.loadedAt = Date.now();
      } catch (e) {
        // 读表失败不阻断业务：沿用旧值 / 回落锁定缺省，仅告警
        this.logger.warn(`ab_config 读取失败，沿用缺省口径：${(e as Error).message}`);
      } finally {
        this.loading = null;
      }
    })();

    return this.loading;
  }

  /** 强制失效（后台改配置后调用） */
  async invalidate(): Promise<void> {
    this.loadedAt = 0;
    await this.ensureLoaded();
  }

  async getRaw(key: string): Promise<string | null> {
    await this.ensureLoaded();
    return this.rows.get(key) ?? null;
  }

  private async getNumber(key: string, fallback: number): Promise<number> {
    const raw = await this.getRaw(key);
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private async getString(key: string, fallback: string): Promise<string> {
    const raw = await this.getRaw(key);
    return raw && raw.trim().length ? raw.trim() : fallback;
  }

  /** C1 · 售价（元）—— 锁定 ¥25.80，配置可覆写（后台系统配置页） */
  unitPriceYuan(): Promise<number> {
    return this.getNumber('set_meal.default_price', BIZ.unitPrice);
  }

  /** C1 · 售价（分）—— 接口出参单位（§1.6） */
  async unitPriceFen(): Promise<number> {
    return Math.round((await this.unitPriceYuan()) * 100);
  }

  /** 单次下单份数上限（§3.3 U6 校验第 2 步） */
  maxQuantity(): Promise<number> {
    return this.getNumber('order.max_quantity', BIZ.maxQuantityPerOrder);
  }

  /** 截单前禁下单窗口（分钟）：截单前 N 分钟即 canOrder=false */
  cutoffWindowMinutes(): Promise<number> {
    return this.getNumber('order.cutoff_window_minutes', 10);
  }

  /** 未支付订单有效期（分钟）—— T3：30 分钟未支付自动取消 */
  payTimeoutMinutes(): Promise<number> {
    return this.getNumber('order.pay_timeout_minutes', BIZ.payTimeoutMinutes);
  }

  /** C2 · 团长等级费率（trainee/formal/gold/chief） */
  async commissionRate(level: string): Promise<number> {
    const fallback =
      BIZ.commissionRate[level as keyof typeof BIZ.commissionRate] ?? BIZ.commissionRate.trainee;
    return this.getNumber(`commission.rate.${level}`, fallback);
  }

  /** 最低提现金额（元） */
  minWithdraw(): Promise<number> {
    return this.getNumber('commission.min_withdraw', 10);
  }

  /** C11 · 出款通道（一期 FLEX_MANUAL） */
  payoutChannel(): Promise<string> {
    return this.getString('commission.payout_channel', 'FLEX_MANUAL');
  }

  /**
   * U17 · 客服入口配置（人工兜底通道）
   *
   * 2026-09-15 口径：一期**不做在线客服**，统一引导用户添加**客服微信**人工解决
   * （退出团长、余额争议、提现异常等）。因此这里只需给出微信号与提示文案，
   * 端上「联系客服」一律跳本配置渲染的页面，不内置任何硬编码联系方式。
   *
   * ⚠️ 微信号由运营在后台系统配置页维护（`ab_config`），代码**不得写死** ——
   *    与「成本项不得写死」同一条纪律；`wechatId` 缺省值为演示占位。
   */
  async supportContact(): Promise<{
    wechatId: string;
    wechatQrcodeUrl: string | null;
    phone: string | null;
    hours: string;
    tips: string;
  }> {
    const [wechatId, wechatQrcodeUrl, phone, hours, tips] = await Promise.all([
      this.getString('service.wechat_id', 'abox_service'),
      this.getString('service.wechat_qrcode', ''),
      this.getString('service.phone', ''),
      this.getString('service.hours', '工作日 9:00 – 18:00'),
      this.getString(
        'service.tips',
        '添加客服微信后，请备注「ABox + 你的姓名」，我们会尽快为你处理。',
      ),
    ]);

    return {
      wechatId,
      wechatQrcodeUrl: wechatQrcodeUrl || null,
      phone: phone || null,
      hours,
      tips,
    };
  }

  /**
   * C9 · 单份成本项（全部可变，按实际执行）
   * 供结算 / 对账计算 `calcSettlement()` 使用；缺省回落 `SETTLEMENT_DEFAULTS`（示例值）。
   * ⚠️ `settlement.supplier_purchase_price` 的值是策略标识 `negotiated`（非金额），
   *    实际供价以供应商采购价表为准，故此处只取场地费/打包人工/配送费三项。
   */
  async settlementCostItems(): Promise<SettlementCostItems> {
    const [siteFee, packingLaborFee, deliveryFee, supplierConfigured] = await Promise.all([
      this.getNumber('settlement.site_fee', SETTLEMENT_DEFAULTS.siteFee),
      this.getNumber('settlement.packing_labor_fee', SETTLEMENT_DEFAULTS.packingLaborFee),
      this.getNumber('settlement.delivery_fee', SETTLEMENT_DEFAULTS.deliveryFee),
      this.getNumber('settlement.supplier_total_default', SETTLEMENT_DEFAULTS.supplierTotal),
    ]);

    return {
      supplierTotal: supplierConfigured,
      siteFee,
      packingLaborFee,
      deliveryFee,
    };
  }

  /** 驱动开关快照（用于健康检查 / 运维面板） */
  drivers() {
    return {
      db: this.env.get<string>('app.drivers.db'),
      queue: this.env.get<string>('app.drivers.queue'),
      storage: this.env.get<string>('app.drivers.storage'),
      providerMode: this.env.get<string>('app.drivers.providerMode'),
    };
  }
}
