<template>
  <view class="page">
    <!-- 日 / 月切换 -->
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

    <!-- 汇总 -->
    <view v-if="summary" class="hero">
      <text class="hero__label">{{ rangeLabel }}佣金净额</text>
      <text class="hero__value">{{ fenToYuanText(summary.netFen) }}</text>
      <view class="hero__meta">
        <text class="hero__meta-item">{{ summary.levelLabel }} · {{ ratePercent }}%</text>
        <text class="hero__meta-item">实发 {{ summary.quantity }} 份</text>
      </view>
      <view class="hero__split">
        <text class="hero__split-item">入账 {{ fenToYuanText(summary.earnedFen) }}</text>
        <text v-if="summary.reversedFen !== 0" class="hero__split-item hero__split-item--warn">
          冲销 {{ fenToYuanText(summary.reversedFen) }}
        </text>
        <text class="hero__split-item">{{ summary.startDate }} ~ {{ summary.endDate }}</text>
      </view>
    </view>

    <ab-loading v-if="loading && !list.length" text="正在加载佣金明细" />

    <ab-empty-state
      v-else-if="!list.length"
      text="本期间暂无佣金"
      hint="佣金在「取餐确认 / 一键分发」后按实发份数计佣，次日 02:00 自动入账"
      action-text="去取餐确认"
      @action="goPickup"
    />

    <template v-else>
      <view class="list">
        <view v-for="item in list" :key="item.id" class="row">
          <view class="row__hd">
            <text class="row__no">{{ item.orderNo }}</text>
            <text class="row__amount" :class="{ 'is-reversal': item.amountFen < 0 }">
              {{ item.amountFen < 0 ? '' : '+' }}{{ fenToYuanText(item.amountFen) }}
            </text>
          </view>

          <view class="row__bd">
            <text class="row__meta">
              {{ formatMealDate(item.mealDate) }} · {{ item.quantity }} 份 · 基数
              {{ fenToYuanText(item.baseAmountFen) }} · {{ (item.rate * 100).toFixed(0) }}%
            </text>
          </view>

          <view class="row__ft">
            <text class="row__level">{{ levelLabel(item.leaderLevel) }}</text>
            <text class="row__status">{{ statusText(item) }}</text>
          </view>
        </view>
      </view>

      <view class="more">
        <text v-if="hasMore" class="more__btn" @tap="loadMore">
          {{ loading ? '加载中…' : '加载更多' }}
        </text>
        <text v-else class="more__end">没有更多了</text>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P16 · 佣金中心（4 级分佣）
 *
 * 数据来源：L10 `GET /leader/commissions?range=day|month`。
 *   · `summary` 是**全量**统计（不受分页影响）；`list` 才分页。
 *   · 费率与等级取**结算时快照**（`rate` / `leaderLevel`），不是当前等级 ——
 *     升/降级不会回改历史佣金。
 *
 * ⚠️ 冲销口径：`type='reversal'` 的行 `amountFen` 为**负数**（库中已存负值），
 *    与 P17 余额流水的「金额恒正 + direction 表方向」不同，切勿混用。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { LEADER_LEVEL_META } from '@abox/shared-types';
import type { LeaderLevel } from '@abox/shared-types';

import { fetchCommissions } from '@/api/leader-finance';
import type { LeaderCommissionItem, LeaderCommissionSummary } from '@/api/leader-finance';
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

const rangeLabel = computed(() => (range.value === 'day' ? '今日' : '本月'));
const ratePercent = computed(() => (summary.value ? (summary.value.rate * 100).toFixed(0) : '--'));

/** 明细行的等级快照文案（shared-types 唯一来源） */
function levelLabel(level: LeaderLevel): string {
  return LEADER_LEVEL_META[level]?.label ?? String(level);
}

function statusText(item: LeaderCommissionItem): string {
  if (item.type === 'reversal') return '冲销';
  if (item.status === 'settled') return '已入账';
  if (item.status === 'cancelled') return '已取消';
  return '待结算';
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
  }
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

.seg {
  display: flex;
  padding: 4rpx;
  background: rgba(228, 216, 195, 0.4);
  border-radius: $radius-pill;

  &__item {
    flex: 1;
    padding: $space-2 0;
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
    color: $c-text;
    font-weight: 600;
  }
}

.hero {
  padding: $space-5 $space-1;
  text-align: center;

  &__label {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    display: block;
    margin-top: $space-2;
    font-size: $fs-display;
    font-weight: 600;
    color: $c-gold;
    font-variant-numeric: tabular-nums;
  }

  &__meta {
    margin-top: $space-3;
  }

  &__meta-item {
    margin: 0 $space-2;
    font-size: $fs-caption;
    color: $c-text;
  }

  &__split {
    margin-top: $space-2;
  }

  &__split-item {
    margin: 0 $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;

    &--warn {
      color: $c-warning;
    }
  }
}

.row {
  margin-bottom: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__no {
    flex: 1;
    font-size: $fs-caption;
    color: $c-text;
  }

  &__amount {
    flex: none;
    margin-left: $space-3;
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-success;

    &.is-reversal {
      color: $c-warning;
    }
  }

  &__bd {
    padding: $space-2 0;
  }

  &__meta {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__ft {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: $space-2;
    border-top: 1px solid rgba(228, 216, 195, 0.5);
  }

  &__level {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__status {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.more {
  padding: $space-4 0;
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
