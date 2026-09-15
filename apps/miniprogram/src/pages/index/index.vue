<template>
  <view class="page">
    <!-- 品牌头 -->
    <view class="hero">
      <view class="hero__main">
        <text class="hero__brand">ABox 一盒</text>
        <text class="hero__slogan">现做热饭 · 写字楼直达</text>
      </view>
      <view v-if="daily?.leader" class="hero__leader">
        <text class="hero__leader-label">跟随团长</text>
        <text class="hero__leader-name">{{ daily.leader.name || '本楼团长' }}</text>
      </view>
    </view>

    <view v-if="daily" class="section">
      <ab-countdown :remain-sec="remainSec" label="距截单" />
    </view>

    <!-- 首屏骨架 -->
    <ab-loading v-if="loading && !daily" text="正在取今日套餐" />

    <template v-else-if="daily">
      <view class="section">
        <ab-meal-card
          :name="daily.setName"
          :meal-date="daily.mealDate"
          :dishes="daily.dishes"
          :rice="daily.rice"
          :price-fen="daily.priceFen"
        >
          <template #action>
            <button
              v-if="daily.canOrder && !daily.existingOrderNo"
              class="btn btn--primary"
              hover-class="btn--hover"
              @tap="goCreate"
            >
              立即下单
            </button>
            <button
              v-else-if="daily.existingOrderNo"
              class="btn btn--ghost"
              hover-class="btn--hover"
              @tap="goDetail"
            >
              查看订单
            </button>
            <button v-else class="btn btn--disabled" disabled>本场已截单</button>
          </template>
        </ab-meal-card>
      </view>

      <view class="section">
        <view class="notice" :class="{ 'notice--warn': !daily.canOrder }">
          <text class="notice__text">{{ noticeText }}</text>
        </view>
      </view>
    </template>

    <ab-empty-state
      v-else
      :text="emptyText"
      :hint="emptyHint"
      action-text="重新加载"
      @action="load"
    />

    <!-- U2 · 往日这盒（仅取最近 3 期，避免首页过长） -->
    <view v-if="history.length" class="section">
      <view class="section__hd">
        <text class="section__title">往日这盒</text>
      </view>
      <view class="history">
        <view v-for="item in history" :key="item.mealDate" class="history__item">
          <text class="history__date">{{ formatMealDateShort(item.mealDate) }}</text>
          <text class="history__dishes">{{ item.dishNames.join(' · ') || '—' }}</text>
          <text class="history__count">{{ item.ordersCount }} 份</text>
        </view>
      </view>
    </view>

    <ab-bottom-bar active="index" />
  </view>
</template>

<script setup lang="ts">
/**
 * P1 · 首页（融合套餐详情）
 *
 * 验收要点（M1 标准 1 / 5）：
 *   · 微信授权后**直接进首页**，不索要手机号与地址（C3 / L9）
 *   · 倒计时显示距 T-1 24:00 的真实剩余时间（以服务端 `countdownSec` 起表）
 *
 * 数据来源：U1 明日套餐（含 `canOrder` 权威判定、已有订单、跟随团长）+ U2 历史归档
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { HomeDailyResult, HomeHistoryItem } from '@abox/shared-types';

import { fetchDaily, fetchHistory } from '@/api/meal';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useCountdown } from '@/composables/use-countdown';
import { buildUrl, navigateTo } from '@/utils/router';
import { formatMealDateShort } from '@/utils/format';

const { run, loading } = useRequest();
const { remainSec, start } = useCountdown();

const daily = ref<HomeDailyResult | null>(null);
const history = ref<HomeHistoryItem[]>([]);
const loadError = ref<ApiError | null>(null);

const emptyText = computed(() => {
  const code = loadError.value?.code;
  if (code === undefined) return '今日暂无开团';
  // 30005 未开团 / 其余按提示语兜底
  return '本楼今日未开团';
});

const emptyHint = computed(
  () => loadError.value?.message ?? '请通过楼长的邀请链接进入，或稍后再试',
);

const noticeText = computed(() => {
  const d = daily.value;
  if (!d) return '';
  if (d.existingOrderNo) return `你已下单（${d.existingOrderNo}），可在订单详情查看出餐进度`;
  if (!d.canOrder) return d.reason ?? '当前不可下单';
  return '今晚 24:00 截单 · 明日 11:30 送达办公楼 · 一饭四菜 ¥25.80';
});

/** 拉取首页数据；历史归档失败不拖垮首页 */
async function load(): Promise<void> {
  try {
    const d = await run(() => fetchDaily());

    daily.value = d;
    loadError.value = null;
    // 以服务端剩余秒数起表，规避设备时钟偏差
    start(d.countdownSec);

    try {
      const h = await run(() => fetchHistory(1, 3));
      history.value = h.list;
    } catch {
      history.value = [];
    }
  } catch (e) {
    if (daily.value === null) loadError.value = e instanceof ApiError ? e : null;
    toastApiError(e);
  }
}

function goCreate(): void {
  const d = daily.value;
  if (!d) return;
  navigateTo(buildUrl('/pages/order-create/order-create', { mealDate: d.mealDate }));
}

function goDetail(): void {
  const orderNo = daily.value?.existingOrderNo;
  if (!orderNo) return;
  navigateTo(buildUrl('/pages/order-detail/order-detail', { orderNo }));
}

onShow(() => {
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

.hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: $space-3 0 $space-5;

  &__brand {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    letter-spacing: 2rpx;
    color: $c-text;
  }

  &__slogan {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__leader {
    text-align: right;
  }

  &__leader-label {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__leader-name {
    display: block;
    margin-top: $space-1;
    font-size: $fs-body;
    color: $c-gold;
  }
}

.section {
  margin-bottom: $space-4;

  &__hd {
    display: flex;
    align-items: center;
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }
}

.notice {
  padding: $space-3;
  background: rgba(201, 168, 118, 0.1);
  border-radius: $radius-md;

  &__text {
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
  }

  &--warn {
    background: rgba(196, 69, 54, 0.08);
  }

  &--warn &__text {
    color: $c-warning;
  }
}

.history {
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__item {
    display: flex;
    align-items: baseline;
    padding: $space-3 $space-4;

    & + & {
      border-top: 1px solid $c-border;
    }
  }

  &__date {
    flex: none;
    width: 90rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__dishes {
    flex: 1;
    overflow: hidden;
    font-size: $fs-caption;
    color: $c-text;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  &__count {
    flex: none;
    margin-left: $space-2;
    font-size: $fs-caption;
    color: $c-gold;
  }
}

.btn {
  min-width: 176rpx;
  height: 68rpx;
  padding: 0 $space-4;
  font-size: $fs-body;
  line-height: 68rpx;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--primary {
    color: $c-surface;
    background: $c-text;
  }

  &--ghost {
    color: $c-text;
    background: transparent;
    border: 1px solid $c-text;
  }

  &--disabled {
    color: $c-text-weak;
    background: rgba(154, 139, 114, 0.14);
  }

  &--hover {
    opacity: 0.85;
  }
}
</style>
