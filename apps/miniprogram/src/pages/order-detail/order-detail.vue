<template>
  <view class="page">
    <ab-loading v-if="loading && !detail" text="正在加载订单" />

    <ab-empty-state
      v-else-if="!detail"
      text="找不到该订单"
      :hint="errorHint"
      action-text="返回订单列表"
      @action="goList"
    />

    <template v-else>
      <!-- 状态 -->
      <view class="status">
        <ab-status-badge :text="detail.statusText" :status="detail.status" />
        <text class="status__hint">{{ statusHint }}</text>
      </view>

      <!-- 状态机时间线 -->
      <view class="section">
        <view class="section__hd">
          <text class="section__title">出餐进度</text>
        </view>
        <view class="timeline">
          <view
            v-for="(node, i) in detail.timeline"
            :key="node.node"
            class="timeline__item"
            :class="{ 'is-done': node.done, 'is-last': i === detail.timeline.length - 1 }"
          >
            <view class="timeline__rail">
              <view class="timeline__dot" />
              <view v-if="i !== detail.timeline.length - 1" class="timeline__line" />
            </view>
            <view class="timeline__body">
              <text class="timeline__text">{{ node.text }}</text>
              <text class="timeline__at">{{ formatDateTime(node.at) }}</text>
            </view>
          </view>
          <view v-if="!detail.timeline.length" class="timeline__empty">
            <text class="timeline__empty-text">暂无可展示的进度节点</text>
          </view>
        </view>
      </view>

      <!-- 套餐明细 -->
      <view class="section">
        <view class="section__hd">
          <text class="section__title">本单套餐</text>
          <text class="section__sub">{{ formatMealDate(detail.mealDate) }}</text>
        </view>
        <view class="card">
          <view v-for="dish in detail.dishes" :key="`${dish.slot}-${dish.name}`" class="card__row">
            <text class="card__slot">{{ SLOT_LABEL[dish.slot] || '菜品' }}</text>
            <text class="card__name">{{ dish.name }}</text>
            <text v-if="dish.supplierName" class="card__from">{{ dish.supplierName }}</text>
          </view>
          <view v-if="!detail.dishes.length" class="card__row">
            <text class="card__name">套餐配菜待公布</text>
          </view>
        </view>
      </view>

      <!-- 取餐信息 -->
      <view class="section">
        <view class="section__hd">
          <text class="section__title">取餐信息</text>
        </view>
        <view class="card">
          <view class="card__row card__row--between">
            <text class="card__slot">取餐点</text>
            <text class="card__value">{{ detail.pickup.point }}</text>
          </view>
          <view v-if="detail.pickup.leaderName" class="card__row card__row--between">
            <text class="card__slot">团长</text>
            <text class="card__value">
              {{ detail.pickup.leaderName }}
              <text v-if="detail.pickup.leaderPhone" class="card__weak">
                {{ detail.pickup.leaderPhone }}
              </text>
            </text>
          </view>
        </view>
      </view>

      <!-- 金额 -->
      <view class="section">
        <view class="section__hd">
          <text class="section__title">金额</text>
        </view>
        <view class="card">
          <view class="card__row card__row--between">
            <text class="card__slot">单价</text>
            <text class="card__value">{{ fenToYuanText(detail.unitPriceFen) }}</text>
          </view>
          <view class="card__row card__row--between">
            <text class="card__slot">份数</text>
            <text class="card__value">× {{ detail.quantity }}</text>
          </view>
          <view class="card__row card__row--between">
            <text class="card__slot">合计</text>
            <text class="card__value">{{ fenToYuanText(detail.totalAmountFen) }}</text>
          </view>
          <view v-if="detail.balanceUsedFen > 0" class="card__row card__row--between">
            <text class="card__slot">余额抵扣</text>
            <text class="card__value">−{{ fenToYuanText(detail.balanceUsedFen) }}</text>
          </view>
          <view class="card__row card__row--between card__row--total">
            <text class="card__slot">实付</text>
            <text class="card__total">{{ fenToYuanText(detail.payAmountFen) }}</text>
          </view>
        </view>
      </view>

      <!-- 订单信息 -->
      <view class="section">
        <view class="section__hd">
          <text class="section__title">订单信息</text>
        </view>
        <view class="card">
          <view class="card__row card__row--between">
            <text class="card__slot">订单号</text>
            <text class="card__value">{{ detail.orderNo }}</text>
          </view>
          <view class="card__row card__row--between">
            <text class="card__slot">下单时间</text>
            <text class="card__value">{{ formatDateTime(detail.createdAt) }}</text>
          </view>
          <view class="card__row card__row--between">
            <text class="card__slot">支付时间</text>
            <text class="card__value">{{ formatDateTime(detail.paidAt) }}</text>
          </view>
          <view v-if="detail.remark" class="card__row card__row--between">
            <text class="card__slot">备注</text>
            <text class="card__value">{{ detail.remark }}</text>
          </view>
        </view>
      </view>

      <!-- 操作 -->
      <view class="actions">
        <button v-if="cancellable" class="btn btn--ghost" hover-class="btn--hover" @tap="goCancel">
          取消订单
        </button>
        <button class="btn btn--primary" hover-class="btn--hover" @tap="goList">
          返回订单列表
        </button>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P5 · 订单详情（状态机时间线）
 *
 * 验收要点（M1 标准 2 / 3）：状态文案与《状态机 v1.0》三视角映射一致
 * （文案由服务端下发，端上不自造）；截单前可自助取消，截单后引导联系团长。
 */
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { OrderStatus } from '@abox/shared-types';
import type { OrderDetailResult } from '@abox/shared-types';

import { fetchOrderDetail } from '@/api/order';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { SLOT_LABEL, fenToYuanText, formatDateTime, formatMealDate } from '@/utils/format';
import { buildUrl, navigateTo, pageQuery, switchTab } from '@/utils/router';

const { run, loading } = useRequest();

const detail = ref<OrderDetailResult | null>(null);
const errorHint = ref('请返回订单列表重试');
const orderNo = ref('');

/** 可自助取消：待支付 / 已支付（截单后由服务端拒绝并给 40004 + 团长联系方式） */
const cancellable = computed(() => {
  const s = detail.value?.status;
  return s === OrderStatus.PENDING_PAY || s === OrderStatus.PAID;
});

const statusHint = computed(() => {
  switch (detail.value?.status) {
    case OrderStatus.PENDING_PAY:
      return '30 分钟内完成支付，超时订单自动取消';
    case OrderStatus.PAID:
      return '已锁定你的那份饭，截单前可自助取消';
    case OrderStatus.CUT_OFF:
    case OrderStatus.COOKED:
      return '已截单，如需退款请联系团长协助';
    case OrderStatus.DELIVERING:
      return '配送途中，11:30 送达办公楼';
    case OrderStatus.DELIVERED:
      return '已送达取餐点，请凭订单号取餐';
    case OrderStatus.COMPLETED:
      return '订单已完成，感谢支持';
    case OrderStatus.CANCELLED:
      return '订单已取消，款项已按原路退回';
    case OrderStatus.REFUND_APPLYING:
    case OrderStatus.REFUNDING:
      return '退款处理中，请留意到账';
    case OrderStatus.REFUNDED:
      return '退款已到账';
    default:
      return '';
  }
});

async function load(): Promise<void> {
  if (!orderNo.value) return;
  try {
    detail.value = await run(() => fetchOrderDetail(orderNo.value));
  } catch (e) {
    if (detail.value === null && e instanceof ApiError) errorHint.value = e.message;
    toastApiError(e);
  }
}

function goCancel(): void {
  navigateTo(buildUrl('/pages/order-cancel/order-cancel', { orderNo: orderNo.value }));
}

function goList(): void {
  switchTab('/pages/order-list/order-list');
}

onLoad((options) => {
  orderNo.value = pageQuery(options as Record<string, unknown>, 'orderNo');
  void load();
});

// 从取消页返回时需要刷新状态
onShow(() => {
  if (detail.value) void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 120rpx;
  box-sizing: border-box;
}

.status {
  display: flex;
  align-items: center;
  padding: $space-4 0 $space-2;

  &__hint {
    flex: 1;
    margin-left: $space-3;
    font-size: $fs-caption;
    line-height: 1.5;
    color: $c-text-weak;
  }
}

.section {
  margin-top: $space-4;

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }

  &__sub {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.timeline {
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__item {
    display: flex;
    min-height: 72rpx;
  }

  &__rail {
    position: relative;
    flex: none;
    width: 40rpx;
  }

  &__dot {
    width: 16rpx;
    height: 16rpx;
    margin-top: 8rpx;
    background: $c-border;
    border-radius: 50%;
  }

  &__line {
    position: absolute;
    top: 28rpx;
    bottom: 0;
    left: 7rpx;
    width: 2rpx;
    background: $c-border;
  }

  &__body {
    flex: 1;
    padding-bottom: $space-4;
  }

  &__text {
    display: block;
    font-size: $fs-body;
    color: $c-text-weak;
  }

  &__at {
    display: block;
    margin-top: 2rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__item.is-done &__dot {
    background: $c-gold;
  }

  &__item.is-done &__text {
    color: $c-text;
  }

  &__item.is-last &__body {
    padding-bottom: 0;
  }

  &__empty {
    padding: $space-3 0;
    text-align: center;
  }

  &__empty-text {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.card {
  padding: $space-2 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__row {
    display: flex;
    align-items: baseline;
    padding: $space-3 0;
    border-bottom: 1px solid rgba(228, 216, 195, 0.5);

    &:last-child {
      border-bottom: none;
    }

    &--between {
      justify-content: space-between;
    }

    &--total {
      margin-top: $space-1;
    }
  }

  &__slot {
    flex: none;
    width: 96rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__name {
    flex: 1;
    font-size: $fs-body;
    color: $c-text;
  }

  &__from {
    flex: none;
    margin-left: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    font-size: $fs-caption;
    color: $c-text;
    text-align: right;
  }

  &__weak {
    margin-left: $space-2;
    color: $c-text-weak;
  }

  &__total {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }
}

.actions {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  margin-top: $space-5;
}

.btn {
  height: 80rpx;
  font-size: $fs-body;
  line-height: 80rpx;
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

  &--hover {
    opacity: 0.85;
  }
}
</style>
