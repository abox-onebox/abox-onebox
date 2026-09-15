<template>
  <view class="page">
    <ab-loading v-if="loading && !result" text="正在确认支付结果" />

    <template v-else-if="result">
      <view class="hero">
        <text class="hero__icon">{{ paid ? '✓' : result.status === 'cancelled' ? '×' : '·' }}</text>
        <text class="hero__title">{{ heroTitle }}</text>
        <text class="hero__amount">¥{{ fenToYuan(result.payAmountFen) }}</text>
        <text v-if="result.failReason" class="hero__reason">{{ result.failReason }}</text>
      </view>

      <view class="section">
        <view class="info">
          <view class="info__row">
            <text class="info__label">订单号</text>
            <text class="info__value">{{ result.orderNo }}</text>
          </view>
          <view class="info__row">
            <text class="info__label">订单状态</text>
            <ab-status-badge :text="result.statusText" :status="result.status" />
          </view>
          <view class="info__row">
            <text class="info__label">支付时间</text>
            <text class="info__value">{{ formatDateTime(result.paidAt) }}</text>
          </view>
        </view>
      </view>

      <view class="section">
        <view class="notice">
          <text class="notice__text">{{ tipText }}</text>
        </view>
      </view>

      <view class="actions">
        <button class="btn btn--primary" hover-class="btn--hover" @tap="goDetail">查看订单</button>
        <button
          v-if="!paid && canRetry"
          class="btn btn--ghost"
          hover-class="btn--hover"
          @tap="retryPay"
        >
          {{ paying ? '支付中…' : '重新支付' }}
        </button>
        <button class="btn btn--plain" hover-class="btn--hover" @tap="goHome">回到首页</button>
      </view>
    </template>

    <ab-empty-state
      v-else
      text="找不到该订单"
      :hint="errorHint"
      action-text="回到首页"
      @action="goHome"
    />
  </view>
</template>

<script setup lang="ts">
/**
 * P4 · 支付结果
 *
 * ⚠️ 状态以 **U8 服务端查询**为准，不看 `uni.requestPayment` 的回调结果：
 *    微信的 success 只代表「用户完成支付动作」，真正入账由服务端回调决定。
 *    故本页进入时立刻查一次 U8；未入账时再轮询几次（mock 回调有延迟）。
 */
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { PayResultView } from '@abox/shared-types';

import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useWechatPay } from '@/composables/use-wechat-pay';
import { fenToYuan, formatDateTime } from '@/utils/format';
import { buildUrl, navigateTo, pageQuery, switchTab } from '@/utils/router';

const { run, loading } = useRequest();
const { pay, paying, pollResult } = useWechatPay();

const result = ref<PayResultView | null>(null);
const errorHint = ref('请返回首页重试');
const orderNo = ref('');

const paid = computed(() => result.value?.paid === true);
const canRetry = computed(() => result.value?.status === 'pending_pay');

const heroTitle = computed(() => {
  const r = result.value;
  if (!r) return '';
  if (r.paid) return '支付成功';
  if (r.status === 'cancelled') return '订单已取消';
  return '等待支付';
});

const tipText = computed(() => {
  const r = result.value;
  if (!r) return '';
  if (r.paid) return '已锁定你的那份饭。截单前可在订单详情自助取消；截单后如需退款请联系团长。';
  if (r.status === 'cancelled') return '30 分钟内未完成支付，订单已自动取消，可回到首页重新下单。';
  return '支付尚未完成。可点击「重新支付」继续，超时未支付订单会自动取消。';
});

async function load(): Promise<void> {
  if (!orderNo.value) return;
  try {
    // 首次查询 + 必要轮询（回调可能有延迟）
    result.value = await run(() => pollResult(orderNo.value));
  } catch (e) {
    if (e instanceof ApiError) errorHint.value = e.message;
    toastApiError(e);
  }
}

async function retryPay(): Promise<void> {
  try {
    result.value = await run(() => pay(orderNo.value));
  } catch (e) {
    toastApiError(e);
  }
}

function goDetail(): void {
  navigateTo(buildUrl('/pages/order-detail/order-detail', { orderNo: orderNo.value }));
}

function goHome(): void {
  switchTab('/pages/index/index');
}

onLoad((options) => {
  orderNo.value = pageQuery(options as Record<string, unknown>, 'orderNo');
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4;
  box-sizing: border-box;
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-5 0 $space-5;
  text-align: center;

  &__icon {
    width: 96rpx;
    height: 96rpx;
    font-size: 48rpx;
    line-height: 96rpx;
    color: $c-surface;
    background: $c-success;
    border-radius: 50%;
  }

  &__title {
    margin-top: $space-3;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__amount {
    margin-top: $space-2;
    font-size: $fs-display;
    font-weight: 600;
    color: $c-text;
  }

  &__reason {
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-warning;
  }
}

.section {
  margin-bottom: $space-4;
}

.info {
  padding: $space-3 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: $space-2 0;
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    font-size: $fs-caption;
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

  &--plain {
    color: $c-text-weak;
    background: transparent;
  }

  &--hover {
    opacity: 0.85;
  }
}
</style>
