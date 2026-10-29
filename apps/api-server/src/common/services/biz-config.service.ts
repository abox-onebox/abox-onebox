import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { CustomerServiceMode, SUPPORT_CS_MODES } from '@abox/shared-types';
import { BIZ, SETTLEMENT_DEFAULTS, SettlementCostItems } from '@abox/shared-utils';
import type { SettlementCostRegistration } from '@abox/shared-utils';
import { summarizeCostRegistration } from '@abox/shared-utils';

import { SysConfig } from '../../database/entities/system.entity';
import { isMissingConfigValue, pickConfigNumber } from '../utils/config-value';
import {
  BusinessTimeline,
  TimelineDiff,
  TIMELINE_CONFIG_KEYS,
  TIMELINE_LABEL,
  currentTimeline,
  formatTimeOfDay,
  setCurrentTimeline,
  timelineFromRows,
} from '../utils/order-timeline';

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
/** x 盲盒默认内容池（轻量小辅助；运行期可经 ab_config.blind_box_items 覆盖） */
const DEFAULT_BLIND_BOX_ITEMS = ['小粗粮', '小水果', '小凉菜', '小糕点', '鸡蛋糕'];

@Injectable()
export class BizConfigService {
  private readonly logger = new Logger('BizConfig');
  private readonly ttlMs = 60_000;
  private rows = new Map<string, string>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  /**
   * 上一次载入**是否成功**。
   *
   * ⚠️ 用途只有一个，但很关键：**只有成功载入时才允许刷新业务时间轴**。
   *    若 DB 抖动导致 `rows` 为空却照样刷新，`timelineFromRows({})` 会算出
   *    「全部为默认值」→ **把运营配置的开团时刻静默改回出厂值** ——
   *    一次 DB 抖动就改变了下单窗口，且没有任何报错。宁可沿用旧值。
   */
  private loadedOk = false;
  /** 已告警过的缺键（`getNumber` 在热路径，见 `warnMissingOnce`）—— 防日志刷屏 */
  private readonly missingWarned = new Set<string>();

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
        this.loadedOk = true;
        // 载入成功 → 同步刷新业务时间轴（下单窗口 / 送达时刻 / 跑批 cron 的取值来源）
        this.applyTimeline();
      } catch (e) {
        // 读表失败不阻断业务：沿用旧值 / 回落锁定缺省，仅告警
        this.loadedOk = false;
        this.logger.warn(`ab_config 读取失败，沿用缺省口径：${(e as Error).message}`);
      } finally {
        this.loading = null;
      }
    })();

    return this.loading;
  }

  /**
   * 把当前配置行的时刻类键应用到**生效时间轴**（同步，供 `ensureLoaded` 调用）
   *
   * 只对 5 个时间键生效（见 `TIMELINE_CONFIG_KEYS`）—— 其余配置项与本机制无关。
   */
  private applyTimeline(): void {
    if (!this.loadedOk) return; // 见 loadedOk 注释：读表失败时绝不回落默认值
    const { timeline, warnings } = timelineFromRows(this.rows);
    // 值非法**不抛错**（配置写坏不该让服务起不来），但必须留痕
    for (const w of warnings) this.logger.warn(w);
    if (setCurrentTimeline(timeline)) {
      const changed = (Object.keys(TIMELINE_CONFIG_KEYS) as Array<keyof BusinessTimeline>)
        .filter((k) => TIMELINE_CONFIG_KEYS[k])
        .map((k) => `${TIMELINE_LABEL[k]}=${formatTimeOfDay(timeline[k])}`)
        .join(' · ');
      this.logger.log(`业务时间轴已按配置生效：${changed}`);
    }
  }

  /**
   * C1/C2 · 当前**生效**的业务时间轴（配置覆写后的值）
   *
   * 供后台配置页展示「实际生效时刻」与调度注册器生成 cron —— 两处必须同源，
   * 否则又会出现「页面显示一个时刻、实际按另一个时刻跑」。
   */
  async timeline(): Promise<BusinessTimeline> {
    await this.ensureLoaded();
    return currentTimeline();
  }

  /** 时间轴与出厂默认值的差异（配置页用来标注「已覆写」） */
  async timelineDiffs(): Promise<TimelineDiff[]> {
    await this.ensureLoaded();
    const { applied } = timelineFromRows(this.rows);
    return applied;
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

  /**
   * 数字配置读取（2026-10-27 修 · 缺陷：fallback 曾是死代码）
   *
   * 旧写法 `Number(raw)` + `Number.isFinite` 有个**方向不一致**的坑：
   * `raw` 缺键时是 `null`，而 `Number(null) === 0`、0 又过得了 `Number.isFinite`
   * ⇒ 缺键拿到的是 **0**，不是 `fallback`。后果按业务分叉：
   *   · 阈值类（停用上限 20）拿到 0 ⇒ 变**更严**（1 笔就 60012）；
   *   · 限额类（提现日额 2000 / 日笔 1）拿到 0 ⇒ 变**更松**（这两处的 0 = 不限）。
   * 同一个成因，一处收紧一处放开，且**毫无症状** —— 故判据抽到
   * `common/utils/config-value.ts`（纯函数），由单测钉死。
   */
  private async getNumber(key: string, fallback: number): Promise<number> {
    const raw = await this.getRaw(key);
    if (isMissingConfigValue(raw)) {
      this.warnMissingOnce(key, String(fallback));
      return fallback;
    }
    return pickConfigNumber(raw, fallback);
  }

  /**
   * 缺键只告警**一次**（每进程每键）
   *
   * ⚠️ 为什么必须去重：`getNumber` 在热路径上（售价、佣金费率…每请求都会读），
   *    不去重的话一次 DB 抖动能把日志刷爆，而刷爆之后真正的告警就没人看了 ——
   *    「每次都告警」等价于「没有告警」。
   */
  private warnMissingOnce(key: string, fallbackText: string): void {
    if (this.missingWarned.has(key)) return;
    this.missingWarned.add(key);
    this.logger.warn(
      `ab_config 缺键 ${key}（是「没配」，不是配了 0）→ 回落缺省 ${fallbackText}。` +
        '若这确实是要长期生效的值，请在后台系统配置页**显式写入**并确认已生效（改配置后需 invalidate）；' +
        '否则它会在任何人看不到的时候悄悄等于缺省值。',
    );
  }

  private async getString(key: string, fallback: string): Promise<string> {
    const raw = await this.getRaw(key);
    return isMissingConfigValue(raw) ? fallback : (raw as string).trim();
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

  /**
   * N2 · 单人可强制停用的未完结订单上限（笔）
   *
   * ⚠️ 刻意**没有**与之成对的「原因最少字数」reader：那个键是 `wiring: 'unwired'`，运行时
   *    没有任何消费点 —— 加一个没人调的 reader 就是死代码，而且会给出「代码读了这个键」
   *    的**反向暗示**，与它自己声明的未接线原因自相矛盾。字数下限由 DTO 的
   *    `@MinLength(10)` 在编译期固定（见 `config.specs.ts` 的 `building.suspend_reason_min_length`）。
   *
   * ⚠️ 不要在注释里写出那个不存在的 reader 名：N2-12 判据按「有没有这个方法」扫本文件，
   *    注释里出现同名串会让它恒红（与 `BUILDING_NOT_ORDERABLE` 那次同一族）。
   */
  suspendForceMaxCount(): Promise<number> {
    return this.getNumber('building.suspend_force_max_count', 20);
  }

  /** C2 · 团长等级费率（trainee/formal/gold/chief） */
  async commissionRate(level: string): Promise<number> {
    const fallback =
      BIZ.commissionRate[level as keyof typeof BIZ.commissionRate] ?? BIZ.commissionRate.trainee;
    return this.getNumber(`commission.rate.${level}`, fallback);
  }

  /**
   * 最低提现金额（元）—— 缺省 **0（不限起提）**
   *
   * ⭐ **真源是 D3 定稿（2026-10-26 用户拍板）**，不是《接口规范》：
   *   · `C:/Users/herma/WorkBuddy/ABox小程序/ABox_D3提现规则定稿_2026-10-26.html`
   *     —— 终版规则表「**起提金额｜不限**」+ 第三节 1）「后台把 `commission.min_withdraw`
   *     设为 0」「`biz-config.service.ts` 默认值 10 → 0」；
   *   · 同目录 `ABox_D3与N3落码回执_2026-10-26.html` ——「已改默认值 10→0、config.specs
   *     描述已换、seed.ts 同步 0.00」；
   *   · 同目录 `ABox_123条进展台账_2026-10-27.html` S1 ——「起提不限（地板 ¥0.01）」。
   *
   * ⚠️ **这三份在仓库之外的「工作区根」**：在仓内 `docs/` 搜「D3」只会搜到
   *    《接口规范》里那条 `PUT /admin/meal/assignments/{id}`（**配餐**），永远搜不到提现。
   *    2026-10-27 就是因为这一点误判成「D3 决策文档不存在」，转而按
   *    `docs/ABox一盒接口规范v1.0.md`（**v1.0 · 2026-09-14**，早一个多月）的旧文案
   *    「≥ ¥10.00」把缺省改成了 10 —— 那是**回退**，不是修复，已在本 commit 撤销。
   *
   * ⚠️ 时间顺序决定效力：**D3（10-26 用户拍板）> 接口规范 v1.0（09-14）**。
   *    《接口规范》那三处已标注「被 D3 取代」，不要再按它把这里改回 10。
   *
   * ⚠️「不限」不等于「¥0 也能提」：地板 ¥0.01 由 `WithdrawApplyReqDto` 的
   *    `@Min(0.01)` 兜住（`modules/finance/dto/finance.dto.ts:169`）—— 已回源确认存在。
   *
   * ⚠️ 与 `getNumber` 那条修复的关系（别混淆）：那里的坑是「缺键被当成 0」；
   *    这里 0 是**业务上想要的真值**。两者不矛盾 —— 显式配 0 或缺键，结果都是 0。
   */
  minWithdraw(): Promise<number> {
    return this.getNumber('commission.min_withdraw', 0);
  }

  /**
   * H9 · 订单 `completed` 后团长代退的时限（小时）
   *
   * **缺省 0 = 不限**（与改动前行为一致）。配正数后：超期的 `completed` 单，
   * 团长代退入口拒绝（40027），改走 D11 强制退款。
   *
   * ⚠️ 这里 0 是**业务上想要的真值**（不限），不是「缺键被当成 0」那个坑 ——
   *    两者结果相同但语义不同：显式配 0 与缺键都表示不限。
   */
  refundWindowHours(): Promise<number> {
    return this.getNumber('refund.completed_window_hours', 0);
  }

  /**
   * 单日提现上限（元）—— 每人每自然日（北京时区 00:00–24:00）累计申请额。
   * 含本次申请额；rejected/failed **不计入**（钱已原路解冻）。0 = 不限。
   *
   * ⚠️ 缺省 2000 的来源：2026-10-27 由项目负责人确认（当日报批口径），
   *    **不是**「D3 定稿」—— 全仓没有叫 D3 的决策文档，旧注释那条出处是编的。
   *    ⚠️ 该值**无书面口径**（docs/ 全库搜 `daily_limit` / `daily_count` 零命中），
   *    属于「先修代码 + 业务口径待确认」：方向（变严）是按「限额键缺键不该等于不限」
   *    定的，具体数字 2000 待业务书面确认后可只改这一处。
   */
  withdrawDailyLimit(): Promise<number> {
    return this.getNumber('commission.withdraw_daily_limit', 2000);
  }

  /**
   * 单日提现笔数上限 —— 同一自然日已有非终态申请数。
   * 计入 pending/approved/paying/success；rejected/failed 后可再提。0 = 不限。
   *
   * ⚠️ 缺省 1 的来源与局限同 `withdrawDailyLimit`（2026-10-27 项目负责人确认，
   *    **无书面口径**，待补）。方向说明：旧代码缺键拿到 0 ⇒ 两道日限检查
   *    （`withdraw.service.ts` 的 `dailyCount > 0` / `dailyLimitYuan > 0`）**整段跳过**，
   *    等于「提现无日限额、无日笔数」—— 这是 fail-open，方向必须纠正。
   */
  withdrawDailyCount(): Promise<number> {
    return this.getNumber('commission.withdraw_daily_count', 1);
  }

  /** C11 · 出款通道（一期 FLEX_MANUAL） */
  payoutChannel(): Promise<string> {
    return this.getString('commission.payout_channel', 'FLEX_MANUAL');
  }

  /**
   * U17 · 客服入口配置（在线客服 + 人工兜底通道）
   *
   * ## 三档模式（`service.cs_mode`）
   * `none`（缺省）复制微信号人工加好友 · `contact` 小程序原生客服消息 ·
   * `wechat_kf` **微信客服**（企业微信承接，2026-10-04 定为终态）。
   *
   * ⭐ **为什么默认 `none`**：`wechat_kf` 需要运营先在企微开通微信客服、完成企业验证、
   * 并在小程序后台绑定**同主体**企业 ID，三件事没做完就切过去，用户会点到一个**唤不起会话**的
   * 按钮。缺省 `none` 保证「任何时刻都有一个能用的通道」。
   *
   * ⭐ **单一真相纪律**：`csCorpId` / `csUrl` **只在 `cs_mode=wechat_kf` 时下发**，
   * 其余模式一律 `null`。否则运营「配了一半」（填了企业 ID 但模式没切）会得到一个
   * 看起来配置齐全、点了却没反应的按钮 —— 端上以 `csMode` 为准，这里先断掉歧义。
   *
   * ⚠️ 联系方式与客服账号**全部由后台配置页维护**（`ab_config`），代码不得写死 ——
   *    与「成本项不得写死」同一条纪律；`wechatId` 缺省值为演示占位。
   */
  async supportContact(): Promise<{
    wechatId: string;
    wechatQrcodeUrl: string | null;
    phone: string | null;
    hours: string;
    tips: string;
    csMode: CustomerServiceMode;
    csCorpId: string | null;
    csUrl: string | null;
  }> {
    const [wechatId, wechatQrcodeUrl, phone, hours, tips, csMode, csCorpId, csUrl] =
      await Promise.all([
        this.getString('service.wechat_id', 'abox_service'),
        this.getString('service.wechat_qrcode', ''),
        this.getString('service.phone', ''),
        this.getString('service.hours', '工作日 9:00 – 18:00'),
        this.getString(
          'service.tips',
          // ⚠️ 三档模式共用同一份文案，故**不得出现「添加微信」这类只适用于 none 档的措辞**；
          //    需要分档话术时由运营改本键（或后续拆成 per-mode 的键）。
          '请直接说明遇到的问题（附上订单号或截图），我们会尽快为你处理，不需要重复发送。',
        ),
        this.getString('service.cs_mode', 'none'),
        this.getString('service.cs_corpid', ''),
        this.getString('service.cs_url', ''),
      ]);

    // 读侧兜底：库里可能是任意字符串（手改库 / 后台导入 / 历史数据），
    // 落不到三档之一就按 `none` 处理 —— 宁可退回人工通道，也不让端上拿到陌生模式。
    const mode: CustomerServiceMode = (SUPPORT_CS_MODES as readonly string[]).includes(csMode)
      ? (csMode as CustomerServiceMode)
      : CustomerServiceMode.NONE;
    const isKf = mode === 'wechat_kf';

    return {
      wechatId,
      wechatQrcodeUrl: wechatQrcodeUrl || null,
      phone: phone || null,
      hours,
      tips,
      csMode: mode,
      csCorpId: isKf && csCorpId ? csCorpId : null,
      csUrl: isKf && csUrl ? csUrl : null,
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

  /**
   * C9 履约成本「当前值 + 登记状态」（D57 系统配置页 / D47 数据看板**共用**）
   *
   * ⚠️ 与 {@link settlementCostItems} 的区别：本方法额外给出「哪几项还没登记」，
   *    并**刻意走进程内缓存** —— 于是 D58 写完调 `invalidate()` 之后，
   *    D57 / D47 立刻能读到新值。「配置改了但业务还是旧数」这类缺陷
   *    会在 e2e 里当场暴露，而不是等 60 秒 TTL 自愈后查不出原因。
   *
   * ⚠️ 「是否已登记」的判据只有 `summarizeCostRegistration()` 一份实现：
   *    配置页的「未登记」标记与看板的「毛利为上限值」提示必须同源，
   *    否则会出现「配置页说已登记、看板说未登记」这种自相矛盾。
   */
  async settlementCostState(): Promise<{
    items: SettlementCostItems;
    registration: SettlementCostRegistration;
  }> {
    const items = await this.settlementCostItems();
    return { items, registration: summarizeCostRegistration(items) };
  }

  /**
   * x 盲盒内容池（轻量小辅助，不作主功能）
   *
   * 运行期可经 `ab_config.blind_box_items`（JSON 字符串数组）覆写；
   * 缺省回落 {@link DEFAULT_BLIND_BOX_ITEMS}。解析失败 / 非数组 / 空数组一律回落缺省，
   * 保证下单抽取永远有可选项（详见 `order.service.ts` 下单抽取逻辑）。
   */
  async blindBoxItems(): Promise<string[]> {
    const raw = await this.getRaw('blind_box_items');
    if (!raw) return DEFAULT_BLIND_BOX_ITEMS;
    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((x) => typeof x === 'string')
      ) {
        return parsed;
      }
    } catch {
      /* 解析失败 → 回落缺省 */
    }
    this.logger.warn(`ab_config.blind_box_items 非法（需 JSON 字符串数组），回落默认池`);
    return DEFAULT_BLIND_BOX_ITEMS;
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
