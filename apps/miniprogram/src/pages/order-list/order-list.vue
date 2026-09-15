<template>
  <view class="page">
    <!-- 状态筛选 -->
    <scroll-view class="tabs" scroll-x :show-scrollbar="false">
      <view class="tabs__inner">
        <view
          v-for="tab in tabs"
          :key="tab.value"
          class="tabs__item"
          :class="{ 'is-active': tab.value === activeStatus }"
          @tap="switchStatus(tab.value)"
        >
          <text class="tabs__label">{{ tab.label }}</text>
        </view>
      </view>
    </scroll-view>

    <ab-loading v-if="loading && !list.length" text="正在加载订单" />

    <ab-empty-state
      v-else-if="!list.length"
      text="还没有订单"
      hint="回到首页挑一份今日套餐吧"
      action-text="去首页"
      @action="goHome"
    />

    <template v-else>
      <view class="list">
        <view
          v-for="item in list"
          :key="item.orderNo"
          class="order"
          hover-class="order--hover"
          @tap="goDetail(item.orderNo)"
        >
          <view class="order__hd">
            <text class="order__date">{{ formatMealDate(item.mealDate) }}</text>
            <ab-status-badge :text="item.statusText" :status="item.status" />
          </view>

          <view class="order__bd">
            <text class="order__dish">{{ item.mainDishName || '一饭四菜' }}</text>
            <text class="order__qty">× {{ item.quantity }}</text>
          </view>

          <view class="order__ft">
            <text class="order__no">{{ item.orderNo }}</text>
            <text class="order__amount">{{ fenToYuanText(item.totalAmountFen) }}</text>
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

    <ab-bottom-bar active="orders" />
  </view>
</template>

<script setup lang="ts">
/**
 * P6 · 订单列表
 *
 * 分页走 §1.3 统一结构（`hasMore` 由服务端给，端上不自行推算）。
 * 状态文案一律取服务端 `statusText`（三视角映射唯一来源）。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { OrderStatus } from '@abox/shared-types';
import type { OrderListItem } from '@abox/shared-types';

import { fetchOrders } from '@/api/order';
import { toastApiError, useRequest } from '@/composables/use-request';
import { fenToYuanText, formatMealDate } from '@/utils/format';
import { PAGE_SIZE } from '@/constants';
import { buildUrl, navigateTo, switchTab } from '@/utils/router';

interface Tab {
  label: string;
  value: string;
}

const tabs: Tab[] = [
  { label: '全部', value: '' },
  { label: '待支付', value: OrderStatus.PENDING_PAY },
  { label: '待出餐', value: OrderStatus.PAID },
  { label: '已完成', value: OrderStatus.COMPLETED },
  { label: '退款/取消', value: OrderStatus.CANCELLED },
];

const { run, loading } = useRequest();

const list = ref<OrderListItem[]>([]);
const activeStatus = ref('');
const page = ref(1);
const hasMore = ref(false);

async function fetchPage(target: number): Promise<void> {
  const res = await run(() =>
    fetchOrders({
      status: activeStatus.value || undefined,
      page: target,
      pageSize: PAGE_SIZE,
    }),
  );
  list.value = target === 1 ? res.list : [...list.value, ...res.list];
  page.value = res.page;
  hasMore.value = res.hasMore;
}

async function reload(): Promise<void> {
  try {
    await fetchPage(1);
  } catch (e) {
    toastApiError(e);
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

function switchStatus(value: string): void {
  if (value === activeStatus.value) return;
  activeStatus.value = value;
  list.value = [];
  void reload();
}

function goDetail(orderNo: string): void {
  navigateTo(buildUrl('/pages/order-detail/order-detail', { orderNo }));
}

function goHome(): void {
  switchTab('/pages/index/index');
}

onShow(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: 0 $space-4 200rpx;
  box-sizing: border-box;
}

.tabs {
  padding: $space-3 0;
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

.list {
  padding-top: $space-2;
}

.order {
  margin-bottom: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &--hover {
    opacity: 0.9;
  }

  &__hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__date {
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__bd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: $space-3 0;
  }

  &__dish {
    flex: 1;
    font-size: $fs-caption;
    color: $c-text;
  }

  &__qty {
    flex: none;
    margin-left: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__ft {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding-top: $space-3;
    border-top: 1px solid rgba(228, 216, 195, 0.5);
  }

  &__no {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__amount {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
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
