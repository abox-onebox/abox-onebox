import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SettlementCostKey, costRegistrationWarning } from '@abox/shared-utils';

import { ErrorCode } from '../../../common/constants/error-code';
import { BizException } from '../../../common/exceptions/biz.exception';
import { BizConfigService } from '../../../common/services/biz-config.service';
import { toBjIso } from '../../../common/utils/time';
import { SysConfig } from '../../../database/entities/system.entity';
import { ConfigItemDto, UpdateConfigsDto } from '../dto/config.dto';
import {
  CONFIG_GROUPS,
  CONFIG_SPECS,
  CONFIG_SPEC_MAP,
  ConfigSpec,
  ConfigValueType,
  ConfigWiring,
  isEditable,
} from './config.specs';

/** D57 列表行（值已归一为**展示口径**） */
export interface ConfigItemView {
  key: string;
  label: string;
  /** 展示值：`percent` 已换算为百分数（`0.0800` → `8`） */
  value: string;
  valueType: ConfigValueType;
  impact: string;
  wiring: ConfigWiring;
  editable: boolean;
  description: string;
  consumedBy: string;
  unit?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: Array<{ value: string; label: string }>;
  /** 仅成本项：是否已登记（`0` = 未登记，见 `zeroMeansUnregistered`） */
  registered?: boolean;
  /** `wiring='unwired'` 时：为什么改了不生效 */
  unwiredReason?: string;
  /** `db` 库内已登记 / `fallback` 库中无此行、当前走代码兜底值 */
  valueSource: 'db' | 'fallback';
  /** 自导入后是否从未改动过（毫秒级容差，见 `untouchedOf`） */
  untouched: boolean;
  updatedAt: string | null;
}

export interface ConfigGroupView {
  group: string;
  label: string;
  description: string;
  items: ConfigItemView[];
}

/** D57 汇总块：履约成本登记状态（**D47 看板复用同一判据**） */
export interface SettlementCostMeta {
  allRegistered: boolean;
  registered: Record<SettlementCostKey, boolean>;
  missingKeys: SettlementCostKey[];
  missingLabels: string[];
  total: number;
  /** 未登记时的统一提示（已登记则为 `null`） */
  warning: string | null;
}

export interface ConfigListView {
  groups: ConfigGroupView[];
  meta: {
    settlementCost: SettlementCostMeta;
    /** 配置读缓存 TTL（秒）—— D58 会强制刷新，故此值不影响一致性，仅作说明 */
    cacheTtlSeconds: number;
    wiringSummary: { total: number; live: number; unwired: number; policy: number };
    note: string;
  };
}

/** D58 单项变更（前 → 后） */
export interface ConfigChange {
  key: string;
  label: string;
  /** 变更前展示值 */
  before: string;
  /** 变更后展示值 */
  after: string;
}

export interface ConfigUpdateResult {
  changed: ConfigChange[];
  /** 值本就相同、未执行写入的项 */
  unchanged: Array<{ key: string; label: string; value: string }>;
  /** 生效时间（北京时间 ISO）；`toBjIso` 对无效日期返回 null */
  effectiveAt: string | null;
  note: string;
}

/**
 * 系统配置服务（D57 读 / D58 批量写）· 见《接口规范 v1.0》§6.7
 *
 * 唯一真相：`config.specs.ts` 的 `CONFIG_SPECS`（分组 / 标签 / 范围 / 可写性 / 接线状态）。
 * 本服务只做四件事：读表 → 按规格归一 → 按规格校验 → 写表 + 刷新缓存。
 *
 * ## 三条必须守住的纪律
 * 1. **白名单**：不在 `CONFIG_SPECS` 里的键**直接拒绝**，不静默忽略。
 *    `ab_config` 是通用键值表，若放开「任意 key 都能改」等于开了个改内部状态的后门；
 *    静默忽略更糟 —— 运营以为改了，实际什么都没发生。
 * 2. **整批原子**：任一项不合法 → 整批不写入。
 *    部分成功会让「二次确认」失去意义（确认了 5 项，只生效 3 项，且看不出是哪 3 项）。
 * 3. **写完必须刷新缓存**：`BizConfigService` 有 60s 进程内缓存，
 *    不调用 `invalidate()` 就会出现「配置页显示已改、业务仍按旧值跑」——
 *    这正是本项目的头号顽疾（两个真相）。D58 因此**同步**失效而不是等 TTL。
 */
@Injectable()
export class ConfigService {
  private readonly logger = new Logger('SysConfig');

  constructor(
    private readonly dataSource: DataSource,
    private readonly bizConfig: BizConfigService,
  ) {}

  // ------------------------------------------------------------------ D57 读

  /** D57 配置清单（按分组返回，值已归一为展示口径） */
  async list(): Promise<ConfigListView> {
    const rows = await this.dataSource.getRepository(SysConfig).find();
    const byKey = new Map(rows.map((r) => [r.configKey, r]));

    const groups: ConfigGroupView[] = CONFIG_GROUPS.map((g) => ({
      group: g.group,
      label: g.label,
      description: g.description,
      items: CONFIG_SPECS.filter((s) => s.group === g.group).map((s) =>
        this.toView(s, byKey.get(s.key)),
      ),
    }));

    // 履约成本登记状态 —— 走 `BizConfigService`（**带进程内缓存**）而不直读表：
    // 这样 D58 写完 `invalidate()` 后，本接口立刻反映新值得以被 e2e 验证；
    // 且 D47 看板复用同一方法，「配置页 / 看板」两处口径不可能漂移。
    const { registration } = await this.bizConfig.settlementCostState();

    const wiringSummary = { total: CONFIG_SPECS.length, live: 0, unwired: 0, policy: 0 };
    for (const s of CONFIG_SPECS) wiringSummary[s.wiring] += 1;

    return {
      groups,
      meta: {
        settlementCost: {
          ...registration,
          warning: registration.allRegistered
            ? null
            : costRegistrationWarning(registration.missingLabels),
        },
        cacheTtlSeconds: 60,
        wiringSummary,
        note:
          `共 ${CONFIG_SPECS.length} 项配置，其中 ${wiringSummary.live} 项已接线（改了生效）、` +
          `${wiringSummary.unwired} 项未接线（只作口径记录）、${wiringSummary.policy} 项为策略标识。` +
          '保存后立即生效；⚠️ 售价 / 佣金费率类改动**不影响历史订单与已有团长** —— ' +
          '它们各自持有下单/建档时的快照值。',
      },
    };
  }

  // ------------------------------------------------------------------ D58 写

  /**
   * D58 批量更新（整批原子）
   *
   * @param dto `{ items: [{ key, value }] }`
   * @param operatorId 操作人（落 `ab_operation_log`，由 `@OperationLog()` 拦截器写入）
   */
  async update(dto: UpdateConfigsDto, operatorId: number): Promise<ConfigUpdateResult> {
    const items: ConfigItemDto[] = dto.items ?? [];
    const problems: string[] = [];
    const seen = new Set<string>();
    const plans: Array<{ spec: ConfigSpec; store: string; display: string }> = [];

    for (const item of items) {
      const key = String(item?.key ?? '').trim();

      if (seen.has(key)) {
        problems.push(`配置项「${key}」在同一请求里出现多次（无法确定以哪一个为准）`);
        continue;
      }
      seen.add(key);

      const spec = CONFIG_SPEC_MAP.get(key);
      if (!spec) {
        problems.push(`未知配置项「${key}」—— 不在可管理清单内，已拒绝（不会静默忽略）`);
        continue;
      }

      if (!isEditable(spec)) {
        problems.push(
          spec.wiring === 'policy'
            ? `「${spec.label}」是策略标识（非金额），不可修改`
            : `「${spec.label}」当前未接线（${spec.unwiredReason ?? '改此值不生效'}），不可修改`,
        );
        continue;
      }

      const checked = this.validateValue(spec, String(item?.value ?? ''));
      if (!checked.ok) {
        problems.push(`「${spec.label}」${checked.message}`);
        continue;
      }

      plans.push({ spec, store: checked.store, display: checked.display });
    }

    if (problems.length) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `配置校验未通过（共 ${problems.length} 项，整批均未写入）：${problems.join('；')}`,
        undefined,
        { fields: problems },
      );
    }

    const changed: ConfigChange[] = [];
    const unchanged: Array<{ key: string; label: string; value: string }> = [];

    await this.dataSource.transaction(async (mgr) => {
      const repo = mgr.getRepository(SysConfig);

      for (const plan of plans) {
        const row = await repo.findOne({ where: { configKey: plan.spec.key } });

        if (row && row.configValue === plan.store) {
          unchanged.push({ key: plan.spec.key, label: plan.spec.label, value: plan.display });
          continue;
        }

        // 库中无此行 → 当前生效的是代码兜底值，它就是「变更前」
        const before = row
          ? this.normalizeForDisplay(plan.spec, row.configValue)
          : this.normalizeForDisplay(plan.spec, plan.spec.fallbackValue ?? '');

        if (row) {
          row.configValue = plan.store;
          await repo.save(row);
        } else {
          // ⚠️ 库中不存在的键要**新建**（不是 UPDATE 不到就当失败）——
          //    `order.pay_timeout_minutes` / `settlement.supplier_total_default`
          //    从未落库，靠代码兜底运行；运营一旦显式调整，就该有这条记录。
          await repo.save(
            repo.create({
              configKey: plan.spec.key,
              configValue: plan.store,
              description: plan.spec.label,
            }),
          );
        }

        changed.push({
          key: plan.spec.key,
          label: plan.spec.label,
          before,
          after: plan.display,
        });
      }
    });

    // ⚠️ 必须同步刷新，不能等 60s TTL —— 否则「配置页已改、业务仍按旧值」= 两个真相
    await this.bizConfig.invalidate();

    if (changed.length) {
      this.logger.log(
        `运营 #${operatorId} 更新系统配置 ${changed.length} 项：` +
          changed.map((c) => `${c.key} ${c.before}→${c.after}`).join(' | '),
      );
    }

    return {
      changed,
      unchanged,
      effectiveAt: toBjIso(new Date()),
      note: changed.length
        ? `已更新 ${changed.length} 项并即时生效（配置缓存已强制刷新）`
        : '提交的配置项与当前值一致，无需变更（未写入任何数据）',
    };
  }

  // ------------------------------------------------------------------ 内部

  private toView(spec: ConfigSpec, row?: SysConfig): ConfigItemView {
    const raw = row?.configValue ?? spec.fallbackValue ?? '';
    const view: ConfigItemView = {
      key: spec.key,
      label: spec.label,
      value: this.normalizeForDisplay(spec, raw),
      valueType: spec.type,
      impact: spec.impact,
      wiring: spec.wiring,
      editable: isEditable(spec),
      description: spec.description,
      consumedBy: spec.consumedBy,
      valueSource: row ? 'db' : 'fallback',
      untouched: row ? this.untouchedOf(row) : true,
      updatedAt: row ? toBjIso(row.updatedAt) : null,
    };

    if (spec.unit !== undefined) view.unit = spec.unit;
    if (spec.min !== undefined) view.min = spec.min;
    if (spec.max !== undefined) view.max = spec.max;
    if (spec.maxLength !== undefined) view.maxLength = spec.maxLength;
    if (spec.options) view.options = spec.options;
    if (spec.unwiredReason) view.unwiredReason = spec.unwiredReason;
    if (spec.zeroMeansUnregistered) view.registered = Number(raw) > 0;

    return view;
  }

  /**
   * 是否「自导入后从未改动过」
   *
   * ⚠️ 不能用 `updatedAt === createdAt` 严判：TypeORM 插入时 `@CreateDateColumn`
   *    与 `@UpdateDateColumn` 是**两次 `new Date()`**，毫秒可能差 1 —— 种子数据
   *    会被误判为「改过」。故给 1 秒容差（人工改配置不可能在导入后 1 秒内发生）。
   */
  private untouchedOf(row: SysConfig): boolean {
    const created = row.createdAt instanceof Date ? row.createdAt.getTime() : 0;
    const updated = row.updatedAt instanceof Date ? row.updatedAt.getTime() : 0;
    if (!created || !updated) return true;
    return updated - created < 1000;
  }

  /** 库内值 → 展示值 */
  private normalizeForDisplay(spec: ConfigSpec, raw: string): string {
    if (spec.type === 'percent') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return raw;
      // 0.0800 → 8（去掉无意义的小数尾零）
      return String(Number((n * 100).toFixed(4)));
    }
    return raw;
  }

  /**
   * 展示值 → 库内值（**percent 的唯一换算点**）
   *
   * 端上传百分数（`8`），库内存比率（`0.0800`）。换算只此一处 ——
   * 若分散实现，迟早出现某条路径把 `8` 直接写进费率列（佣金算错 100 倍）。
   */
  private normalizeForStore(spec: ConfigSpec, display: string): string {
    switch (spec.type) {
      case 'percent':
        return (Number(display) / 100).toFixed(4);
      case 'money':
        return Number(display).toFixed(2);
      case 'int':
        return String(Math.trunc(Number(display)));
      default:
        return display.trim();
    }
  }

  /** 按规格校验取值，返回库内值与展示值 */
  private validateValue(
    spec: ConfigSpec,
    raw: string,
  ): { ok: true; store: string; display: string } | { ok: false; message: string } {
    const value = raw.trim();

    // ---- 文本类：允许清空（如 service.phone），只限长度
    if (spec.type === 'text') {
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return {
          ok: false,
          message: `长度不能超过 ${spec.maxLength} 个字符（当前 ${value.length}）`,
        };
      }
      return { ok: true, store: value, display: value };
    }

    // ---- 策略标识：不可写（前面已按 wiring 拦下，此处双保险）
    if (spec.type === 'policy') {
      return { ok: false, message: '是策略标识（非金额/数值），不可修改' };
    }

    // ---- 枚举
    if (spec.type === 'enum') {
      const allowed = (spec.options ?? []).map((o) => o.value);
      if (!allowed.includes(value)) {
        return { ok: false, message: `取值须为 ${allowed.join(' / ')} 之一（当前「${value}」）` };
      }
      return { ok: true, store: value, display: value };
    }

    // ---- 时间 HH:mm
    if (spec.type === 'time') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        return { ok: false, message: `须为 HH:mm 格式（当前「${value}」）` };
      }
      return { ok: true, store: value, display: value };
    }

    // ---- 数值类（money / percent / int）
    // ⚠️ 必须先做格式校验：`Number('')` 与 `Number(' ')` 都是 0，
    //    若不拦，运营清空金额输入框会被**静默存成 0.00** ——
    //    对成本项而言就是「悄悄变成未登记」，且没有任何报错。
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      return {
        ok: false,
        message: spec.type === 'percent' ? '须为数字（百分数，如 8 表示 8%）' : '须为数字',
      };
    }

    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, message: '须为有效数字' };

    if (spec.type === 'int' && !Number.isInteger(n)) {
      return { ok: false, message: '须为整数' };
    }
    if (spec.min !== undefined && n < spec.min) {
      return { ok: false, message: `不能小于 ${spec.min}${spec.unit ?? ''}（当前 ${value}）` };
    }
    if (spec.max !== undefined && n > spec.max) {
      return { ok: false, message: `不能大于 ${spec.max}${spec.unit ?? ''}（当前 ${value}）` };
    }

    const store = this.normalizeForStore(spec, value);
    return { ok: true, store, display: this.normalizeForDisplay(spec, store) };
  }
}
