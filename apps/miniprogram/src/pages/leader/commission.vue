<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP16（v4.10.0）：
         等级大卡（深棕→金）→ 四级分佣体系表 → 余额账户 → 最近 3 笔 -->

    <!-- ① 等级大卡 -->
    <view class="hero">
      <text class="hero__label">团长等级</text>
      <text class="hero__level">{{ levelLabel }}团长</text>
      <text class="hero__amount">{{ fenToYuanText(balance?.balanceFen ?? 0) }}</text>
      <text class="hero__sub">当前分佣比例 {{ ratePercent }}% · 余额可消费或提现</text>
    </view>

    <!-- ② 四级分佣体系 -->
    <view class="card">
      <text class="card__title">📊 团长分佣体系（4 级）</text>

      <view v-if="rules" class="matrix">
        <view class="matrix__row matrix__row--hd">
          <text class="matrix__cell">等级</text>
          <text class="matrix__cell matrix__cell--strong">分佣</text>
          <text class="matrix__cell matrix__cell--wide">升级条件</text>
        </view>
        <view
          v-for="lv in rules.levels"
          :key="lv.key"
          class="matrix__row"
          :class="{ 'is-mine': lv.key === effectiveLevel }"
        >
          <text class="matrix__cell">{{ lv.name }}</text>
          <text class="matrix__cell matrix__cell--strong">{{ (lv.rate * 100).toFixed(0) }}%</text>
          <text class="matrix__cell matrix__cell--wide">
            {{ lv.condition }}
            <text v-if="lv.key === effectiveLevel" class="matrix__now">← 当前</text>
          </text>
        </view>
      </view>

      <view class="note">
        <text class="note__text">💡 升级条件：月单量与推荐人数须同时满足，缺一不可。</text>
        <text v-if="rules?.expireRule" class="note__text">⚠️ {{ rules.expireRule }}</text>
      </view>

      <view class="mine">
        <text class="mine__text">
          我的进度：本月 {{ rules?.mine.monthOrders ?? 0 }} 单 · 已推荐
          {{ rules?.mine.invitedFormalCount ?? 0 }} 名团长
          <text v-if="isTopLevel" class="mine__next">· 已达最高等级</text>
          <text v-else-if="nextLevelName" class="mine__next">· 下一级 {{ nextLevelName }}</text>
        </text>
        <view class="mine__bar">
          <view class="mine__bar-fill" :style="{ width: `${progressPercent}%` }" />
        </view>
        <text v-if="levelNote" class="mine__note">⚠️ {{ levelNote }}</text>
      </view>

      <button class="btn btn--gold btn--block" hover-class="btn--hover" @tap="goShare">
        📤 推荐新团长
      </button>
    </view>

    <!-- ③ 余额账户 -->
    <view class="card">
      <text class="card__title">💰 余额账户</text>

      <view class="stats">
        <view class="stats__item">
          <text class="stats__value stats__value--gold">
            {{ fenToYuanText(balance?.balanceFen ?? 0) }}
          </text>
          <text class="stats__label">可消费 / 可提现</text>
        </view>
        <view class="stats__item">
          <text class="stats__value">{{ fenToYuanText(balance?.withdrawnFen ?? 0) }}</text>
          <text class="stats__label">已提现</text>
        </view>
        <view class="stats__item">
          <text class="stats__value">{{ fenToYuanText(balance?.frozenFen ?? 0) }}</text>
          <text class="stats__label">冻结中</text>
        </view>
      </view>

      <view v-if="(balance?.pendingCommissionFen ?? 0) > 0" class="pending">
        <text class="pending__text">
          待结算佣金 {{ fenToYuanText(balance?.pendingCommissionFen ?? 0) }} · 次日入账后进余额
        </text>
      </view>

      <view class="pair">
        <button class="btn btn--ghost" hover-class="btn--hover" @tap="goWithdraw">💸 提现</button>
        <button class="btn btn--gold" hover-class="btn--hover" @tap="goBalanceLog">
          📜 查看流水
        </button>
      </view>
    </view>

    <!-- ④ 最近 3 笔 -->
    <view class="card">
      <view class="card__hd">
        <text class="card__title">🔁 最近 3 笔</text>
        <text class="card__link" @tap="goBalanceLog">全部流水 ›</text>
      </view>

      <ab-empty-state v-if="!list.length" text="暂无佣金记录" hint="取餐分发后按实发份数计佣" />

      <view v-for="item in list.slice(0, 3)" :key="item.id" class="row">
        <view class="row__left">
          <text class="row__title">{{ itemTitle(item) }}</text>
          <text class="row__date">{{ formatMealDate(item.mealDate) }}</text>
        </view>
        <text class="row__amount" :class="item.amountFen < 0 ? 'is-out' : 'is-in'">
          {{ item.amountFen < 0 ? '' : '+' }}{{ fenToYuanText(item.amountFen) }}
        </text>
      </view>
    </view>

    <!--
      ⑤ 佣金明细（原型未画此块，实装保留）
      L10 是唯一能看到「逐单计佣 + 等级快照 + 冲销来源」的地方（余额流水只有汇总的入账一笔），
      删掉会让团长无法核对自己每一单的佣金。
    -->
    <view class="card">
      <text class="card__title">📋 佣金明细</text>

      <view class="seg">
        <view
          v-for="r in ranges"
          :key="r.value"
          class="seg__item"
          :class="{ 'is-active': range === r.value }"
          @tap="switchRange(r.value)"
        >
          <text class="seg__label">{{ r.label }}</text>
        </view>
      </view>

      <view v-if="summary" class="sum">
        <text class="sum__text">
          {{ rangeLabel }}净额 {{ fenToYuanText(summary.netFen) }} · 实发 {{ summary.quantity }} 份
        </text>
        <text v-if="summary.reversedFen !== 0" class="sum__warn">
          含冲销 {{ fenToYuanText(summary.reversedFen) }}
        </text>
      </view>

      <ab-loading v-if="loading && !list.length" text="正在加载佣金明细" />

      <ab-empty-state
        v-else-if="!list.length"
        text="本期间暂无佣金"
        hint="佣金在「取餐确认 / 一键分发」后按实发份数计佣，次日自动入账"
        action-text="去取餐确认"
        @action="goPickup"
      />

      <template v-else>
        <view v-for="item in list" :key="`d-${item.id}`" class="row">
          <view class="row__left">
            <text class="row__title">{{ item.orderNo }}</text>
            <text class="row__date">
              {{ formatMealDate(item.mealDate) }} · {{ item.quantity }} 份 · 基数
              {{ fenToYuanText(item.baseAmountFen) }} · {{ (item.rate * 100).toFixed(0) }}%
            </text>
            <text class="row__tag">
              {{ levelLabelOf(item.leaderLevel) }} · {{ statusText(item) }}
            </text>
          </view>
          <text class="row__amount" :class="item.amountFen < 0 ? 'is-out' : 'is-in'">
            {{ item.amountFen < 0 ? '' : '+' }}{{ fenToYuanText(item.amountFen) }}
          </text>
        </view>

        <view class="more">
          <text v-if="hasMore" class="more__btn" @tap="loadMore">
            {{ loading ? '加载中…' : '加载更多' }}
          </text>
          <text v-else class="more__end">没有更多了</text>
        </view>
      </template>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * P16 · 佣金中心（4 级分佣 + 余额账户）
 *
 * ⭐ 版式基准 = prototype/index.html renderP16（v4.10.0）
 *
 * 数据来源：
 *   · L16 `GET /leader/level-rules`   —— 4 级规则 + 我的进度 + 资格失效规则
 *   · L11 `GET /leader/balance`       —— 余额三指标（可用 / 已提现 / 冻结）
 *   · L10 `GET /leader/commissions`   —— 最近 3 笔 + 逐单明细（分页，`summary` 全量）
 *
 * ⚠️ 费率与等级取**结算时快照**（明细行的 `rate` / `leaderLevel`），不是当前等级 ——
 *    升/降级不会回改历史佣金。
 * ⚠️ 冲销口径：`type='reversal'` 的行 `amountFen` 为**负数**（库中已存负值），
 *    与余额流水的「金额恒正 + direction 表方向」不同，切勿混用。
 * ⚠️ 「已提现」取 L11 `withdrawnFen`（**团长维度快照**），不在端上累加逐笔流水 ——
 *    补跑/冲正会让两者出现时点差，以服务端快照为准。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { LEADER_LEVEL_META } from '@abox/shared-types';
import type { LeaderLevel } from '@abox/shared-types';

import { fetchLevelRules } from '@/api/leader';
import type { LevelRulesResult } from '@/api/leader';
import { fetchCommissions, fetchLeaderBalance } from '@/api/leader-finance';
import type {
  LeaderBalanceData,
  LeaderCommissionItem,
  LeaderCommissionSummary,
} from '@/api/leader-finance';
import { toastApiError, useRequest } from '@/composables/use-request';
import { PAGE_SIZE } from '@/constants';
import { fenToYuanText, formatMealDate } from '@/utils/format';
import { navigateTo } from '@/utils/router';

const ranges = [
  { label: '今日', value: 'day' as const },
  { label: '本月', value: 'month' as const },
];

const { run, loading } = useRequest();

const range = ref<'day' | 'month'>('day');
const summary = ref<LeaderCommissionSummary | null>(null);
const list = ref<LeaderCommissionItem[]>([]);
const page = ref(1);
const hasMore = ref(false);
const balance = ref<LeaderBalanceData | null>(null);
const rules = ref<LevelRulesResult | null>(null);

const rangeLabel = computed(() => (range.value === 'day' ? '今日' : '本月'));

/**
 * ⭐ 当前**生效**等级 = L11 `level` / `levelLabel`（后台按晋级审计写入、真正生效的那个）
 *
 * ⚠️ 契约已把「等级」拆成两个名字（缺陷 #94 · 2026-09-18 服务端改名）：
 *     · `effectiveLevel`（L11/L14 `level`、L16 `mine.effectiveLevel`）= **实际生效等级** ← 展示用这个
 *     · `derivedLevel`  （L16 `mine.derivedLevel`）= **按本月业绩反推的「应处等级」**，
 *       是晋级审计的**输入**，不是「我的等级」。一个「首席但本月只做 7 单」的团长
 *       会同时命中 `chief` 与 `trainee` —— 两个值都对，只是语义不同。
 *
 *     ⚠️ 旧出参两个端点**都叫 `level`**（同名不同义），端上照抄就会**同屏两个等级**
 *        （本批实测踩到）。改名后 `mine` 里**不再有** `level` 字段，名字自解释。
 *     故：**等级展示一律用 L11/L14**；「下一级 / 进度」直接取 L16 服务端算好的值。
 */
const effectiveLevel = computed<LeaderLevel | null>(() => {
  const lv = balance.value?.level as LeaderLevel | undefined;
  return lv ?? null;
});
const levelLabel = computed(() => balance.value?.levelLabel ?? '—');

const ratePercent = computed(() => {
  // 「当前分佣比例」= 生效费率，故 L11 优先；L10 的 `summary.rate` 是**结算快照**，
  // 仅作降级兜底（升/降级后历史快照会与当前费率不同）。
  const r = balance.value?.rate ?? summary.value?.rate ?? 0;
  return r ? (r * 100).toFixed(0) : '--';
});

/**
 * 下一级 —— **直接取服务端 `mine.nextLevel`**（相对**生效等级**推导）
 *
 * ⚠️ 端上**不再自己算**：阶梯顺序（谁比谁高）与门槛（`LEADER_LEVEL_META`）的单一真相
 *    都在服务端，端上复刻一份必然漂移（缺陷 #94 的修法就是这个）。
 *    `null` = 已达最高等级。
 */
const nextLevelKey = computed<LeaderLevel | null>(() => rules.value?.mine.nextLevel ?? null);
const isTopLevel = computed(() => !!effectiveLevel.value && !nextLevelKey.value);
const nextLevelName = computed(() => {
  const k = nextLevelKey.value;
  if (!k) return '';
  return rules.value?.levels.find((l) => l.key === k)?.name ?? levelLabelOf(k);
});

/**
 * 晋级进度（0–100）= 服务端 `mine.progress`（相对**生效等级**的双条件完成度，
 * 取较慢的一方即木桶原理，与 C2 的 AND 语义一致；已达最高等级 → 1）。
 */
const progressPercent = computed(() => {
  if (!effectiveLevel.value) return 0;
  return Math.round((rules.value?.mine.progress ?? 0) * 100);
});

/** 业绩测算等级与生效等级不一致时的**如实说明**（不隐藏差异，也不把它当「我的等级」） */
const levelNote = computed(() => {
  const derived = rules.value?.mine.derivedLevel;
  const cur = effectiveLevel.value;
  if (!derived || !cur || derived === cur) return '';
  return `等级由平台按业绩审核调整；本月业绩测算对应 ${
    rules.value?.levels.find((l) => l.key === derived)?.name ?? levelLabelOf(derived)
  }。`;
});

/** 等级文案唯一来源 = shared-types 的 LEADER_LEVEL_META */
function levelLabelOf(level: LeaderLevel): string {
  return LEADER_LEVEL_META[level]?.label ?? String(level);
}

function statusText(item: LeaderCommissionItem): string {
  if (item.type === 'reversal') return '冲销';
  if (item.status === 'settled') return '已入账';
  if (item.status === 'cancelled') return '已取消';
  return '待结算';
}

/** 「最近 3 笔」标题：原型写「订单分成（45 份 × 12% × ¥25.80）」 */
function itemTitle(item: LeaderCommissionItem): string {
  if (item.type === 'reversal') return `冲销（${item.quantity} 份）`;
  return `订单分成（${item.quantity} 份 × ${(item.rate * 100).toFixed(0)}%）`;
}

async function fetchPage(target: number): Promise<void> {
  const res = await run(() =>
    fetchCommissions({ range: range.value, page: target, pageSize: PAGE_SIZE }),
  );
  summary.value = res.summary;
  list.value = target === 1 ? res.list : [...list.value, ...res.list];
  page.value = res.page;
  hasMore.value = res.hasMore;
}

async function reload(): Promise<void> {
  try {
    await fetchPage(1);
  } catch (e) {
    toastApiError(e, '佣金加载失败');
    return;
  }

  // 余额与等级规则：best-effort（失败只影响对应卡片）
  const [b, r] = await Promise.allSettled([fetchLeaderBalance(), fetchLevelRules()]);
  if (b.status === 'fulfilled') balance.value = b.value;
  if (r.status === 'fulfilled') rules.value = r.value;
}

async function loadMore(): Promise<void> {
  if (loading.value || !hasMore.value) return;
  try {
    await fetchPage(page.value + 1);
  } catch (e) {
    toastApiError(e);
  }
}

function switchRange(value: 'day' | 'month'): void {
  if (value === range.value) return;
  range.value = value;
  list.value = [];
  void reload();
}

function goPickup(): void {
  navigateTo('/pages/leader/pickup');
}

function goShare(): void {
  navigateTo('/pages/leader/share');
}

function goWithdraw(): void {
  navigateTo('/pages/leader/withdraw');
}

function goBalanceLog(): void {
  navigateTo('/pages/leader/balance-log');
}

onShow(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4;
  box-sizing: border-box;
}

// ---- ① 等级大卡 ----
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 36rpx $space-4;
  background: linear-gradient(135deg, #b8892f, $c-text);
  border-radius: 36rpx;
  color: #ffffff;
  text-align: center;
  box-shadow: 0 10rpx 28rpx rgba(110, 84, 53, 0.22);

  &__label {
    font-size: $fs-caption;
    opacity: 0.9;
  }

  &__level {
    margin: $space-2 0;
    font-size: 44rpx;
    font-weight: bold;
  }

  &__amount {
    margin: $space-1 0;
    font-size: 56rpx;
    font-weight: bold;
    letter-spacing: 2rpx;
  }

  &__sub {
    font-size: 22rpx;
    opacity: 0.9;
  }
}

// ---- 通用卡片 ----
.card {
  margin-top: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-2;
  }

  &__title {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__hd &__title {
    margin-bottom: 0;
  }

  &__link {
    font-size: $fs-caption;
    color: $c-gold;
  }
}

// ---- ② 体系表 ----
.matrix {
  margin-bottom: $space-3;
  overflow: hidden;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__row {
    display: flex;
    align-items: center;
    padding: $space-2 $space-3;
    border-bottom: 1px solid rgba(228, 216, 195, 0.6);

    &:last-child {
      border-bottom: none;
    }

    &--hd {
      background: #fbf7ee;

      .matrix__cell {
        font-size: $fs-caption;
        color: $c-text-weak;
      }
    }

    &.is-mine {
      background: rgba(201, 168, 118, 0.14);
    }
  }

  &__cell {
    flex: 1;
    font-size: 22rpx;
    line-height: 1.5;
    color: $c-text;

    &--strong {
      flex: 0 0 80rpx;
      font-weight: bold;
    }

    &--wide {
      flex: 2.2;
    }
  }

  &__now {
    font-size: 20rpx;
    font-weight: bold;
    color: #b8892f;
  }
}

.note {
  padding: $space-2 $space-3;
  background: #fbf7ee;
  border-radius: $radius-sm;

  &__text {
    display: block;
    font-size: 22rpx;
    line-height: 1.8;
    color: $c-text-weak;
  }
}

.mine {
  margin-top: $space-3;

  &__text {
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text;
  }

  &__next {
    color: $c-gold;
  }

  &__bar {
    height: 12rpx;
    margin-top: $space-2;
    overflow: hidden;
    background: $c-bg;
    border-radius: $radius-pill;
  }

  &__bar-fill {
    height: 100%;
    background: linear-gradient(90deg, $c-gold, #b8892f);
    border-radius: $radius-pill;
    transition: width 0.4s ease;
  }

  /** 「业绩测算等级 ≠ 生效等级」时的如实说明（仅差异时出现） */
  &__note {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
  }
}

// ---- ③ 余额账户 ----
.stats {
  display: flex;
  align-items: flex-end;

  &__item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  &__value {
    font-size: 36rpx;
    font-weight: bold;
    color: $c-text;
    font-variant-numeric: tabular-nums;

    &--gold {
      color: #b8892f;
    }
  }

  &__label {
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }
}

.pending {
  margin-top: $space-3;
  padding: $space-2 $space-3;
  background: #fbf7ee;
  border-radius: $radius-sm;

  &__text {
    font-size: 22rpx;
    line-height: 1.6;
    color: $c-text-weak;
  }
}

.pair {
  display: flex;
  margin-top: $space-3;
}

// ---- 按钮 ----
.btn {
  flex: 1;
  height: 72rpx;
  line-height: 72rpx;
  font-size: $fs-caption;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.85;
  }

  &--block {
    display: block;
    margin-top: $space-3;
  }

  &--gold {
    color: #ffffff;
    font-weight: bold;
    background: linear-gradient(135deg, $c-gold, #b8892f);
    border: none;
  }

  &--ghost {
    margin-right: $space-2;
    color: $c-text;
    background: $c-surface;
    border: 1px solid $c-border;
  }
}

// ---- 流水 / 明细行 ----
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed #d4c4a8;

  &:last-of-type {
    border-bottom: none;
  }

  &__left {
    flex: 1;
    min-width: 0;
  }

  &__title {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__date {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__tag {
    display: block;
    margin-top: 4rpx;
    font-size: 20rpx;
    color: $c-gold;
  }

  &__amount {
    flex: none;
    margin-left: $space-3;
    font-size: $fs-body;
    font-weight: bold;
    font-variant-numeric: tabular-nums;

    &.is-in {
      color: $c-success;
    }

    &.is-out {
      color: $c-warning;
    }
  }
}

// ---- 明细块 ----
.seg {
  display: flex;
  margin-bottom: $space-3;
  padding: 4rpx;
  background: $c-bg;
  border-radius: $radius-pill;

  &__item {
    flex: 1;
    padding: 10rpx 0;
    text-align: center;
    border-radius: $radius-pill;

    &.is-active {
      background: $c-surface;
    }
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__item.is-active &__label {
    font-weight: bold;
    color: $c-text;
  }
}

.sum {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: $space-2 $space-3;
  background: #fbf7ee;
  border-radius: $radius-sm;

  &__text {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__warn {
    font-size: $fs-caption;
    color: $c-warning;
  }
}

.more {
  padding: $space-4 0 0;
  text-align: center;

  &__btn {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__end {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}
</style>
