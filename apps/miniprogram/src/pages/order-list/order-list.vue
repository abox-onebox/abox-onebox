<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP6（v4.10.0）：
         分段筛选条（带计数）→ 订单卡（日期 + 状态胶囊 / 菜品摘要 / 金额）→ 空态 -->

    <!-- 分段筛选条 -->
    <view class="seg">
      <view
        v-for="tab in tabs"
        :key="tab.value"
        class="seg__item"
        :class="{ 'is-active': tab.value === activeStatus }"
        hover-class="seg__item--hover"
        @tap="switchStatus(tab.value)"
      >
        <text class="seg__label">{{ tab.label }}</text>
        <text v-if="countOf(tab.value) !== null" class="seg__count">{{ countOf(tab.value) }}</text>
      </view>
    </view>

    <ab-loading v-if="loading && !list.length" text="正在加载订单" />

    <ab-empty-state
      v-else-if="!list.length"
      :text="activeStatus ? '暂无相关订单' : '还没有订单'"
      :hint="activeStatus ? '换个筛选看看' : '回到首页挑一份今日套餐吧'"
      :action-text="activeStatus ? '看全部订单' : '去首页'"
      @action="onEmptyAction"
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
            <text class="order__pill" :class="pillClass(item.status)">{{ item.statusText }}</text>
          </view>

          <view class="order__bd">
            <text class="order__dish">{{ item.mainDishName || '一饭四菜' }}</text>
            <text class="order__qty">共 {{ item.quantity }} 份</text>
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
 * ⭐ 版式基准 = prototype/index.html renderP6（v4.10.0）
 *
 * 分页走 §1.3 统一结构（`hasMore` 由服务端给，端上不自行推算）。
 * 状态文案一律取服务端 `statusText`（三视角映射唯一来源）。
 *
 * ## 筛选档位的取舍
 *
 * 原型是 4 档（全部 / 待出餐 / 已完成 / 已取消）。本页**沿用 4 档**，
 * 但**待支付订单仍然能在「全部」里看到** —— 它是 30 分钟自动取消的过渡态
 * （T3），单列一个筛选档的收益低于它占掉的横向空间。
 *
 * ## 计数怎么来的
 *
 * 原型里的计数是写死的假数字。真实计数 = 各档 `GET /orders` 的 `total`
 * （`pageSize:1` 只取总数，不取数据）。四个并发小请求，且**失败不报错**：
 * 计数是装饰性的，为了它弹四个 toast 才是真的打扰（列表本身照常可用）。
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
  { label: '待出餐', value: OrderStatus.PAID },
  { label: '已完成', value: OrderStatus.COMPLETED },
  { label: '已取消', value: OrderStatus.CANCELLED },
];

const { run, loading } = useRequest();

const list = ref<OrderListItem[]>([]);
const activeStatus = ref('');
const page = ref(1);
const hasMore = ref(false);
/** 各档计数；`null` = 取数失败 → 页面上就不显示数字（而不是显示 0） */
const counts = ref<Record<string, number | null>>({});

function countOf(value: string): number | null {
  return counts.value[value] ?? null;
}

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

/** 四个档位的 total（失败即 `null`，**不弹错**） */
async function loadCounts(): Promise<void> {
  const entries = await Promise.all(
    tabs.map(async (tab): Promise<[string, number | null]> => {
      try {
        const res = await fetchOrders({
          status: tab.value || undefined,
          page: 1,
          pageSize: 1,
        });
        return [tab.value, res.total];
      } catch {
        return [tab.value, null];
      }
    }),
  );
  counts.value = Object.fromEntries(entries);
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

function onEmptyAction(): void {
  if (activeStatus.value) switchStatus('');
  else switchTab('/pages/index/index');
}

/**
 * 状态胶囊配色（原型 `.status-pill` 三档）
 * ⚠️ 只做**视觉分组**，不参与任何业务判断 —— 判断一律看 `status` 原值。
 */
function pillClass(status: string): string {
  if (status === OrderStatus.CANCELLED) return 'is-cancelled';
  if (status === OrderStatus.COMPLETED) return 'is-completed';
  return 'is-pending';
}

function goDetail(orderNo: string): void {
  navigateTo(buildUrl('/pages/order-detail/order-detail', { orderNo }));
}

onShow(() => {
  void reload();
  void loadCounts();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: 0 $space-4 200rpx;
  box-sizing: border-box;
}

// ---- 分段筛选条 ----
.seg {
  display: flex;
  gap: 4rpx;
  margin: $space-3 0;
  padding: 4rpx;
  background: #fbf7ee;
  border: 1px solid $c-border;
  border-radius: 14rpx;

  &__item {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: $space-2 0;
    border-radius: 10rpx;

    &.is-active {
      background: $c-gold;
    }

    &--hover {
      opacity: 0.88;
    }
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__count {
    margin-left: 4rpx;
    font-size: 20rpx;
    color: $c-text-weak;
  }

  &__item.is-active &__label {
    font-weight: bold;
    color: #ffffff;
  }

  &__item.is-active &__count {
    color: rgba(255, 255, 255, 0.85);
  }
}

// ---- 订单卡 ----
.list {
  padding-top: $space-1;
}

.order {
  margin-bottom: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: 0 2rpx 8rpx rgba(110, 84, 53, 0.06);

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
    font-weight: bold;
    color: $c-text;
  }

  &__pill {
    padding: 2rpx $space-2;
    font-size: 20rpx;
    border-radius: $radius-sm;

    &.is-pending {
      color: #b8892f;
      background: rgba(201, 168, 118, 0.2);
    }

    &.is-completed {
      color: $c-success;
      background: rgba(91, 124, 58, 0.14);
    }

    &.is-cancelled {
      color: $c-text-weak;
      background: rgba(154, 139, 114, 0.16);
    }
  }

  &__bd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: $space-3 0;
  }

  &__dish {
    flex: 1;
    overflow: hidden;
    font-size: $fs-caption;
    color: $c-text-weak;
    white-space: nowrap;
    text-overflow: ellipsis;
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
    border-top: 1px dashed #d4c4a8;
  }

  &__no {
    font-size: 20rpx;
    color: $c-text-weak;
  }

  &__amount {
    font-size: $fs-h2;
    font-weight: bold;
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
