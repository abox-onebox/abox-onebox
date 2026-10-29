#!/usr/bin/env node
/**
 * `ab_config` 定稿值真源（**单一真相**）＋ 对账判据（纯函数 · 零 IO）
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────────────
 * 2026-10-27 一天里同一个教训犯了两次：
 *   ·「D-1（getNumber 缺键拿 0）」挂在记忆里没人修，直到以「提现无日限额」复发；
 *   · D3 定稿（2026-10-26 用户拍板）要求 `commission.min_withdraw` 设为 0，
 *     当时只改了代码默认值，**现网 `ab_config` 里那条显式配置至今是 10.00**
 *     ⇒ 决策「写在了文档里、等人执行」，执行了一半，且**没有任何机制会发现**。
 *
 * 根因是同一条：业务配置类决策只存在于文档（而且在工作区根、仓库之外），
 * 从来没有变成**机器可校验**的东西。本文件把「定稿值」从文档里抽出来落成一个
 * 模块，供 `seed-biz-config.mjs`（建库）与 `check-biz-config-parity.mjs`（对账）
 * **共用一份**，从而让「决策写了没落地」变成一条会红的门禁。
 *
 * ── 定稿值的取得方式（回源，不凭记忆）────────────────────────────────────────
 * 每条都带 `source`，指向**逐条核对过**的出处：
 *   · 提现三条 ← `C:/Users/herma/WorkBuddy/ABox小程序/ABox_D3提现规则定稿_2026-10-26.html`
 *     （2026-10-26 用户拍板）与 `ABox_D3与N3落码回执_2026-10-26.html`
 *     ⚠️ 这两份在**工作区根、仓库之外** —— 在仓内 `docs/` 搜「D3」只会搜到
 *        《接口规范》里那条 `PUT /admin/meal/assignments/{id}`（配餐），永远搜不到提现。
 *   · 阈值 / 超时 / 供价三条 ← 仓内 `docs/decisions/OPEN-DECISIONS.md:13`
 *     （2026-10-27 拍板 · RESOLVED）与 `docs/decisions/ADR-N1N2W1-楼宇停用与一键停售.md:509`
 *
 * ── `policy` 两种语义（别合并）───────────────────────────────────────────────
 *   `seed`          该键**应当**在库里存在（D3 明确要求落库）⇒ 缺失即偏差；
 *   `fallback-only` 拍板「不写库、让代码 fallback 生效」⇒ 缺失是**预期**，不算偏差；
 *                   但**一旦存在，值必须与定稿一致**（存在却不同 = 有人手改过/没改干净）。
 *   ⇒ 「缺失」与「值不同」是两种偏差，判据分开算，不许合并（与 `config-value.ts`
 *      里「缺键 ≠ 配了 0」是同一条纪律）。
 *
 * ⚠️ 本文件**零依赖、零 IO** —— 判据必须能被单测/自证直接调用。
 */

/** 落库策略：`seed`=应落库 · `fallback-only`=拍板不落库、靠代码缺省 */
export const POLICY = Object.freeze({
  SEED: 'seed',
  FALLBACK_ONLY: 'fallback-only',
});

/**
 * 定稿值清单
 *
 * ⚠️ 改这里等于改业务口径，必须同时改：代码 fallback / seed.ts / config.specs.ts /
 *    docs / 门禁断言 —— 与 `minWithdraw` 那次震荡同一条纪律。
 */
export const BIZ_CONFIG_BASELINE = Object.freeze([
  {
    key: 'commission.min_withdraw',
    value: '0.00',
    policy: POLICY.SEED,
    source:
      'C:/Users/herma/WorkBuddy/ABox小程序/ABox_D3提现规则定稿_2026-10-26.html' +
      '（2026-10-26 用户拍板）· 终版规则表「起提金额｜不限」+ 第三节 1）' +
      '「后台把 commission.min_withdraw 设为 0」',
    note:
      '「不限」不是「¥0 也能提」：地板 ¥0.01 由 WithdrawApplyReqDto 的 @Min(0.01) 兜住' +
      '（apps/api-server/src/modules/finance/dto/finance.dto.ts:169）。' +
      '现网显式配 10.00 ⇒ D3 至今未落地，本条对账会报红（真阳性）。',
  },
  {
    key: 'commission.withdraw_daily_limit',
    value: '2000.00',
    policy: POLICY.FALLBACK_ONLY,
    source:
      'ABox_D3提现规则定稿_2026-10-26.html · 终版规则表「单日上限｜¥2000」' +
      '＋ 第三节 2）「新增配置键（money，默认 2000）」；' +
      '落库策略 ← docs/decisions/OPEN-DECISIONS.md:13（2026-10-27 拍板：不写库，让 fallback 生效）',
    note: '0 = 不限。',
  },
  {
    key: 'commission.withdraw_daily_count',
    value: '1',
    policy: POLICY.FALLBACK_ONLY,
    source:
      'ABox_D3提现规则定稿_2026-10-26.html · 终版规则表「当日笔数｜1 笔」' +
      '＋ 第三节 3）「默认 1，0=不限」；' +
      '落库策略 ← docs/decisions/OPEN-DECISIONS.md:13',
    note: '0 = 不限。',
  },
  {
    key: 'building.suspend_force_max_count',
    value: '20',
    policy: POLICY.FALLBACK_ONLY,
    source:
      'docs/decisions/ADR-N1N2W1-楼宇停用与一键停售.md:509（缺省 20）' +
      '＋ docs/decisions/OPEN-DECISIONS.md:13（2026-10-27 拍板：取 20、不写库）',
    note: '单人可强制停用的未完结订单上限（笔）。',
  },
  {
    key: 'order.pay_timeout_minutes',
    value: '30',
    policy: POLICY.FALLBACK_ONLY,
    source:
      'packages/shared-utils/src/biz.ts:34（payTimeoutMinutes: 30）' +
      '＋ docs/decisions/OPEN-DECISIONS.md:13（2026-10-27 拍板：取 30、不写库）',
    note: '未支付订单有效期（分钟）。缺键时旧代码会拿到 0 = 创建即过期（2026-10-27 已修）。',
  },
  {
    key: 'settlement.supplier_total_default',
    value: '14.0',
    policy: POLICY.FALLBACK_ONLY,
    source:
      'packages/shared-utils/src/biz.ts:98（supplierTotal: 14.0）' +
      '＋ docs/decisions/OPEN-DECISIONS.md:13（2026-10-27 拍板：取 14.0、不写库）',
    note: '供价缺省（元）。履约成本计算**不含**这一项（见《接口规范》§6.6）。',
  },

  // ── H9 · 2026-10-29 补登记（此前**唯一**一条建了 feature 却没進 baseline 的配置键）──
  {
    key: 'refund.completed_window_hours',
    value: '24',
    policy: POLICY.SEED,
    source:
      '2026-10-29 用户拍板「完成后 24 小时内可退」（本轮决策，出处＝当日留痕 §二十）' +
      '＋ 《ABox_提审前最后一公里复核_2026-10-29.html》§二指出该键生产未落库、baseline 未登记',
    // 长论证留在**注释**里：它会进 `ab_config.description`（varchar(256)），
    // 2026-10-29 首次登记写成 300+ 字 ⇒ `--apply` 直接 `Data too long`，
    // 而 dry-run 当时还不报错（已补预检，见 seed-biz-config.mjs 的 checkNoteFits）。
    //
    // 为什么必须是 `SEED` 而不是 `FALLBACK_ONLY`：
    //   缺键时代码兜底 = **0 = 不限**（biz-config.service.ts:267），H9 要防的
    //   「几个月后突然冒出一笔欠款把团长余额扣成负数」**依然敞开**；
    //   且「不限」与上一版行为一致 ⇒ 没配就上线，等于 H9 白做。
    //   故以拍板值 24 为定稿，让「没落地」直接报红。
    // 消费点：refund.service.ts:200 读 → :208 抛 REFUND_WINDOW_EXPIRED
    //   （真源判据 common/utils/refund-window.ts；口径登记 config.specs.ts:290）。
    note: '订单完成后可退时限（小时）。超时后自助/代退入口拒（40027），改走 D11 强制退款。',
  },
]);

/**
 * D3 终版五值里**不是 `ab_config` 键**的两条（如实登记，避免有人硬塞成键）
 *
 * 回源：ABox_D3提现规则定稿_2026-10-26.html · 终版规则表「到账时限｜T+1」「手续费｜不收」。
 */
export const NON_CONFIG_DECISIONS = Object.freeze([
  {
    item: 'T+1 到账',
    landedAt:
      'withdraw-admin.service.ts 的 expectedArrivalOf()（auditAt + 1 工作日 18:00，周末顺延）' +
      '＋ tips 文案 —— 一期无自动打款能力（FLEX_MANUAL），只能做「承诺 + 可观测」',
  },
  {
    item: '平台不收手续费',
    landedAt:
      '逻辑本就不收（withdraw.service.ts taxWithheldAmount 按实登记）；' +
      '表述要求写全「个税由灵活用工平台依法代扣代缴，到账为税后金额」—— 是文案，不是配置键',
  },
]);

/**
 * 值归一化（**纯函数**）
 *
 * ⚠️ 为什么不能直接字符串比：库里 money 型写 `2000.00`、int 型写 `1`，
 *    而定稿值可能写 `2000` / `1`。`'2000.00' === '2000'` 为假 ⇒ 会**误报**偏差，
 *    而误报多了没人看，等于没有门禁（与「每次都告警 = 没有告警」同一条）。
 */
export function normalizeValue(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return '';
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

/**
 * 对账（**纯函数 · 零 IO**）
 *
 * @param baseline 定稿值清单（默认 `BIZ_CONFIG_BASELINE`）
 * @param rows     现网行 `[{ configKey, configValue }]`
 * @returns `{ aligned, missing, drifting }`；`missing` 含 `violation` 标记
 */
export function diffBizConfig(baseline = BIZ_CONFIG_BASELINE, rows = []) {
  const actual = new Map();
  for (const r of rows ?? []) {
    const k = r?.configKey ?? r?.config_key;
    if (k == null) continue;
    actual.set(String(k), normalizeValue(r?.configValue ?? r?.config_value));
  }

  const aligned = [];
  const missing = [];
  const drifting = [];

  for (const spec of baseline) {
    if (!actual.has(spec.key)) {
      // ⭐ 缺失是否算偏差，取决于拍板的落库策略 —— 两种语义不许合并
      const violation = spec.policy === POLICY.SEED;
      missing.push({
        key: spec.key,
        expected: spec.value,
        policy: spec.policy,
        violation,
        source: spec.source,
      });
      continue;
    }
    const actualValue = actual.get(spec.key);
    if (normalizeValue(spec.value) === actualValue) {
      aligned.push({ key: spec.key, value: actualValue, policy: spec.policy });
    } else {
      drifting.push({
        key: spec.key,
        expected: spec.value,
        actual: actualValue,
        policy: spec.policy,
        violation: true,
        source: spec.source,
      });
    }
  }

  return { aligned, missing, drifting };
}

/** 是否存在需要报警的偏差（**纯函数**） */
export function hasViolation(diff) {
  return diff.drifting.some((d) => d.violation) || diff.missing.some((m) => m.violation);
}
