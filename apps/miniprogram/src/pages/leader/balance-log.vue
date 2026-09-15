<template>
  <view class="page">
    <!-- 余额总览 -->
    <view v-if="balance" class="hero">
      <text class="hero__label">可用余额</text>
      <text class="hero__value">{{ fenToYuanText(balance.balanceFen) }}</text>

      <view class="hero__rows">
        <view class="hero__row">
          <text class="hero__k">冻结中</text>
          <text class="hero__v">{{ fenToYuanText(balance.frozenFen) }}</text>
        </view>
        <view class="hero__row">
          <text class="hero__k">累计收入</text>
          <text class="hero__v">{{ fenToYuanText(balance.totalInFen) }}</text>
        </view>
        <view class="hero__row">
          <text class="hero__k">累计支出</text>
          <text class="hero__v">{{ fenToYuanText(balance.totalOutFen) }}</text>
        </view>
      </view>

      <button
        class="hero__btn"
        :disabled="!balance.canWithdraw"
        hover-class="hero__btn--hover"
        @tap="goWithdraw"
      >
        {{ balance.canWithdraw ? '去提现' : `满 ${fenToYuanText(balance.minWithdrawFen)} 可提现` }}
      </button>
    </view>

    <!-- 类型筛选 -->
    <scroll-view class="tabs" scroll-x :show-scrollbar="false">
      <view class="tabs__inner">
        <view
          v-for="tab in BALANCE_LOG_TABS"
          :key="tab.value"
          class="tabs__item"
          :class="{ 'is-active': tab.value === activeType }"
          @tap="switchType(tab.value)"
        >
          <text class="tabs__label">{{ tab.label }}</text>
        </view>
      </view>
    </scroll-view>

    <!-- 期间汇总（全量，不受分页影响） -->
    <view v-if="summary" class="sum">
      <text class="sum__item">共 {{ summary.count }} 笔</text>
      <text class="sum__item sum__item--in">收 {{ fenToYuanText(summary.inFen) }}</text>
      <text class="sum__item sum__item--out">支 {{ fenToYuanText(summary.outFen) }}</text>
    </view>

    <ab-loading v-if="loading && !list.length" text="正在加载流水" />

    <ab-empty-state
      v-else-if="!list.length"
      text="暂无流水记录"
      hint="佣金入账 / 提现后会在此逐笔留痕"
    />

    <template v-else>
      <view class="list">
        <view v-for="item in list" :key="item.id" class="row">
          <view class="row__hd">
            <text class="row__type">{{ item.typeText }}</text>
            <text class="row__amount" :class="item.direction > 0 ? 'is-in' : 'is-out'">
              {{ item.direction > 0 ? '+' : '-' }}{{ fenToYuanText(item.amountFen) }}
            </text>
          </view>

          <view class="row__bd">
            <text class="row__meta">
              余额 {{ fenToYuanText(item.balanceAfterFen) }}
              <text v-if="item.remark"> · {{ item.remark }}</text>
            </text>
          </view>

          <view class="row__ft">
            <text class="row__related">{{ displayOr(item.relatedId, '—') }}</text>
            <text class="row__time">{{ formatDateTime(item.createdAt) }}</text>
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
 * P17 · 余额流水
 *
 * 数据来源：L11 `GET /leader/balance`（余额快照）+ L19 `GET /leader/balance-logs`（发生额流水）。
 *
 * ⚠️ 方向口径与 P16 佣金明细**不同**：本页 `amountFen` **恒为正数**，收支看 `direction`
 *    （1 收入 / -1 支出）；佣金中心的冲销行金额本身是负数。
 * ⚠️ 「可用余额」的唯一真源是 L11 的 `balanceFen`（`ab_balance`）；
 *    L14 资料里的 `balance` 是 `ab_team_leader` 上的**统计快照**，可能滞后，勿用于判断。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { BALANCE_LOG_TABS, fetchBalanceLogs } from '@/api/balance';
import type { BalanceLogItem, BalanceLogSummary } from '@/api/balance';
import { fetchLeaderBalance } from '@/api/leader-finance';
import type { LeaderBalanceData } from '@/api/leader-finance';
import { toastApiError, useRequest } from '@/composables/use-request';
import { PAGE_SIZE } from '@/constants';
import { displayOr, fenToYuanText, formatDateTime } from '@/utils/format';
import { navigateTo } from '@/utils/router';

const { run, loading } = useRequest();

const balance = ref<LeaderBalanceData | null>(null);
const summary = ref<BalanceLogSummary | null>(null);
const list = ref<BalanceLogItem[]>([]);
const activeType = ref('');
const page = ref(1);
const hasMore = ref(false);

async function fetchPage(target: number): Promise<void> {
  const res = await run(() =>
    fetchBalanceLogs({ type: activeType.value || undefined, page: target, pageSize: PAGE_SIZE }),
  );
  summary.value = res.summary;
  list.value = target === 1 ? res.list : [...list.value, ...res.list];
  page.value = res.page;
  hasMore.value = res.hasMore;
}

async function reload(): Promise<void> {
  try {
    const [b] = await Promise.all([run(() => fetchLeaderBalance()), fetchPage(1)]);
    balance.value = b;
  } catch (e) {
    toastApiError(e, '余额流水加载失败');
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

function switchType(value: string): void {
  if (value === activeType.value) return;
  activeType.value = value;
  list.value = [];
  void fetchPage(1).catch((e) => toastApiError(e));
}

function goWithdraw(): void {
  navigateTo('/pages/leader/withdraw');
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

.hero {
  padding-bottom: $space-4;
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

  &__rows {
    margin: $space-4 0;
    padding: $space-3 $space-4;
    background: $c-surface;
    border: 1px solid $c-border;
    border-radius: $radius-md;
  }

  &__row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: $space-2 0;
  }

  &__k {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__v {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__btn {
    height: 80rpx;
    font-size: $fs-body;
    line-height: 80rpx;
    color: $c-surface;
    background: $c-text;
    border-radius: $radius-pill;

    &::after {
      border: none;
    }

    &--hover {
      opacity: 0.85;
    }

    &[disabled] {
      opacity: 0.4;
    }
  }
}

.tabs {
  padding: $space-2 0;
  white-space: nowrap;

  &__inner {
    display: inline-flex;
    align-items: center;
  }

  &__item {
    padding: $space-2 $space-3;
    margin-right: $space-3;
    border: 1px solid $c-border;
    border-radius: $radius-pill;

    &.is-active {
      background: $c-text;
      border-color: $c-text;
    }
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__item.is-active &__label {
    color: $c-surface;
  }
}

.sum {
  display: flex;
  align-items: center;
  padding: $space-2 0 $space-3;

  &__item {
    margin-right: $space-4;
    font-size: $fs-caption;
    color: $c-text-weak;

    &--in {
      color: $c-success;
    }

    &--out {
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

  &__type {
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__amount {
    font-size: $fs-h2;
    font-weight: 600;
    font-variant-numeric: tabular-nums;

    &.is-in {
      color: $c-success;
    }

    &.is-out {
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
    align-items: baseline;
    justify-content: space-between;
    padding-top: $space-2;
    border-top: 1px solid rgba(228, 216, 195, 0.5);
  }

  &__related,
  &__time {
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
