<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP17（v4.10.0）：
         账户口径卡（含校验式）→ 流水列表 -->

    <!-- ① 账户口径 -->
    <view class="card">
      <text class="card__title"
        ><text class="abi abi-16">{{ I.chart }}</text> 账户口径</text
      >

      <view class="simple">
        <text class="simple__label">累计分成收入</text>
        <text class="simple__value">{{ fenToYuanText(balance?.totalInFen ?? 0) }}</text>
      </view>
      <view class="simple">
        <text class="simple__label">已提现</text>
        <text class="simple__value">{{ fenToYuanText(balance?.withdrawnFen ?? 0) }}</text>
      </view>
      <view class="simple">
        <text class="simple__label">冻结中（提现处理 / 平台冻结）</text>
        <text class="simple__value">{{ fenToYuanText(balance?.frozenFen ?? 0) }}</text>
      </view>
      <view class="simple simple--hl">
        <text class="simple__label simple__label--strong">可提现余额</text>
        <text class="simple__value simple__value--gold">
          {{ fenToYuanText(balance?.balanceFen ?? 0) }}
        </text>
      </view>

      <text class="check">
        校验：{{ fenToYuanText(balance?.totalInFen ?? 0) }}（累计收入） −
        {{ fenToYuanText(balance?.totalOutFen ?? 0) }}（累计支出） =
        {{ fenToYuanText(balance?.balanceFen ?? 0) }}
      </text>
      <text class="check check--note">
        （口径：可用余额与累计收支同源于 ab_balance_log 汇总，故上式恒成立；
        「已提现」是团长维度快照、「冻结中」还含平台手工冻结，两者不并入上式 ——
        不拼凑一个看上去对得上的减法。）
      </text>
    </view>

    <!-- ② 流水 -->
    <view class="card">
      <view class="card__hd">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.list }}</text> 流水记录</text
        >
        <text v-if="summary" class="card__count">共 {{ summary.count }} 笔</text>
      </view>

      <!-- 类型筛选（原型无，保留：团长要按「分成 / 提现」分看） -->
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

      <view v-if="summary" class="sum">
        <text class="sum__item">收 {{ fenToYuanText(summary.inFen) }}</text>
        <text class="sum__item sum__item--out">支 {{ fenToYuanText(summary.outFen) }}</text>
        <text class="sum__item">净 {{ fenToYuanText(summary.netFen) }}</text>
      </view>

      <ab-loading v-if="loading && !list.length" text="正在加载流水" />

      <ab-empty-state
        v-else-if="!list.length"
        text="暂无流水记录"
        hint="佣金入账 / 提现后会在此逐笔留痕"
        illustration="coins"
      />

      <template v-else>
        <view v-for="item in list" :key="item.id" class="row">
          <view class="row__left">
            <text class="row__title">{{ item.typeText }}</text>
            <text class="row__date">{{ formatDateTime(item.createdAt) }}</text>
            <text class="row__meta">
              余额 {{ fenToYuanText(item.balanceAfterFen) }}
              <text v-if="item.relatedId"> · {{ item.relatedId }}</text>
              <text v-if="item.remark"> · {{ item.remark }}</text>
            </text>
          </view>
          <text class="row__amount" :class="item.direction > 0 ? 'is-in' : 'is-out'">
            {{ item.direction > 0 ? '+' : '−' }}{{ fenToYuanText(item.amountFen) }}
          </text>
        </view>

        <view class="more">
          <text v-if="hasMore" class="more__btn" @tap="loadMore">
            {{ loading ? '加载中…' : '加载更多' }}
          </text>
          <text v-else class="more__end">没有更多了</text>
        </view>
      </template>

      <button
        v-if="balance"
        class="btn"
        :disabled="!balance.canWithdraw"
        hover-class="btn--hover"
        @tap="goWithdraw"
      >
        <text v-if="balance.canWithdraw"
          ><text class="abi abi-20">{{ I.withdraw }}</text> 去提现</text
        >
        <text v-else>满 {{ fenToYuanText(balance.minWithdrawFen) }} 起可提现</text>
      </button>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * P17 · 佣金流水（余额口径核对）
 *
 * ⭐ 版式基准 = prototype/index.html renderP17（v4.10.0）
 *
 * 数据来源：L11 `GET /leader/balance`（余额快照 + 累计收支）+ L19 `GET /leader/balance-logs`（发生额流水）。
 *
 * ⚠️ 方向口径与 P16 佣金明细**不同**：本页 `amountFen` **恒为正数**，收支看 `direction`
 *    （1 收入 / -1 支出）；佣金中心的冲销行金额本身是负数。
 * ⚠️ 「可用余额」的唯一真源是 L11 的 `balanceFen`（`ab_balance` 派生）；
 *    L14 资料里的 `balance` 是 `ab_team_leader` 上的**统计快照**，可能滞后，勿用于判断。
 * ⚠️ 原型写的校验式是「累计分成收入 − 已提现 − 冻结中 = 可提现」——该式在实装口径下
 *    **不恒成立**（`withdrawnFen` 是团长维度快照、`frozenFen` 还含平台手工冻结），
 *    故本页只写同源恒等式「累计收入 − 累计支出 = 可用余额」，不拼凑看似自洽的减法。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { BALANCE_LOG_TABS, fetchBalanceLogs } from '@/api/balance';
import type { BalanceLogItem, BalanceLogSummary } from '@/api/balance';
import { fetchLeaderBalance } from '@/api/leader-finance';
import type { LeaderBalanceData } from '@/api/leader-finance';
import { toastApiError, useRequest } from '@/composables/use-request';
import { PAGE_SIZE } from '@/constants';
import { fenToYuanText, formatDateTime } from '@/utils/format';
import { navigateTo } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

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

.card {
  margin-bottom: $space-3;
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

  &__count {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.simple {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

  &--hl {
    margin-top: $space-1;
    padding: $space-3;
    background: rgba(201, 168, 118, 0.12);
    border-bottom: none;
    border-radius: $radius-sm;
  }

  &__label {
    font-size: $fs-body;
    color: $c-text;

    &--strong {
      font-weight: bold;
    }
  }

  &__value {
    font-size: $fs-body;
    color: $c-text;

    &--gold {
      font-size: $fs-h2;
      font-weight: bold;
      color: $c-gold-fg;
    }
  }
}

.check {
  display: block;
  margin-top: $space-2;
  font-size: 22rpx;
  line-height: 1.7;
  color: $c-text-weak;

  &--note {
    margin-top: $space-1;
    opacity: 0.9;
  }
}

.tabs {
  margin-bottom: $space-2;
  white-space: nowrap;

  &__inner {
    display: inline-flex;
    align-items: center;
  }

  &__item {
    padding: $space-2 $space-3;
    margin-right: $space-2;
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
  padding-bottom: $space-3;

  &__item {
    margin-right: $space-4;
    font-size: $fs-caption;
    color: $c-text-weak;

    &--out {
      color: $c-warn-fg;
    }
  }
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

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

  &__meta {
    display: block;
    margin-top: 4rpx;
    font-size: 20rpx;
    color: $c-text-weak;
  }

  &__amount {
    flex: none;
    margin-left: $space-3;
    font-size: $fs-body;
    font-weight: bold;
    font-variant-numeric: tabular-nums;

    &.is-in {
      color: $c-ok-fg;
    }

    &--out,
    &.is-out {
      color: $c-warn-fg;
    }
  }
}

.more {
  padding: $space-4 0 0;
  text-align: center;

  &__btn {
    font-size: $fs-caption;
    color: $c-gold-fg;
  }

  &__end {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.btn {
  height: 80rpx;
  margin-top: $space-4;
  line-height: 80rpx;
  color: #ffffff;
  font-size: $fs-body;
  background: linear-gradient(135deg, $c-gold, $c-gold-deep);
  border: none;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.88;
  }

  &[disabled] {
    color: $c-text-weak;
    background: $c-bg;
  }
}
</style>
