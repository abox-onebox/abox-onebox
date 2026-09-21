<template>
  <view class="page">
    <ab-loading v-if="loading && !result" text="正在确认支付结果" />

    <template v-else-if="result">
      <!-- 结果 hero（原型 P4：大 ✅ + 标题 + 订单号） -->
      <view class="hero">
        <text class="abi abi-deco-40 hero__icon">{{
          I[paid ? 'ok-circle' : result.status === 'cancelled' ? 'x-circle' : 'clock']
        }}</text>
        <text class="hero__title">{{ heroTitle }}</text>
        <text class="hero__order-no">订单号 {{ result.orderNo }}</text>
        <text v-if="result.failReason" class="hero__reason">{{ result.failReason }}</text>
      </view>

      <!-- 订单信息卡（原型 P4：套餐/金额/支付方式/截单时间） -->
      <view class="info">
        <view class="info__row">
          <text class="info__label">金额</text>
          <text class="info__value">¥{{ fenToYuan(result.payAmountFen) }}</text>
        </view>
        <view class="info__row">
          <text class="info__label">支付方式</text>
          <text class="info__value">微信支付</text>
        </view>
        <view class="info__row">
          <text class="info__label">截单时间</text>
          <text class="info__value">今晚 24:00</text>
        </view>
        <view class="info__row">
          <text class="info__label">订单状态</text>
          <ab-status-badge :text="result.statusText" :status="result.status" />
        </view>
        <view v-if="result.paidAt" class="info__row">
          <text class="info__label">支付时间</text>
          <text class="info__value">{{ formatDateTime(result.paidAt) }}</text>
        </view>
      </view>

      <view class="tip">
        <text class="tip__text">{{ tipText }}</text>
      </view>

      <button class="btn-primary" hover-class="btn-primary--hover" @tap="goDetail">
        查看订单详情
      </button>
      <button
        v-if="!paid && canRetry"
        class="btn-secondary"
        hover-class="btn-secondary--hover"
        :disabled="paying"
        @tap="retryPay"
      >
        {{ paying ? '支付中…' : '重新支付' }}
      </button>
      <button class="btn-secondary" hover-class="btn-secondary--hover" @tap="goHome">
        返回首页
      </button>
    </template>

    <ab-empty-state
      v-else
      text="找不到该订单"
      :hint="errorHint"
      illustration="search"
      action-text="回到首页"
      @action="goHome"
    />
  </view>
</template>

<script setup lang="ts">
/**
 * P4 · 支付结果
 *
 * ⭐ 版式基准 = prototype/index.html renderP4（2026-09-18 裁定「19 页逐页对齐原型」）：
 *   大 ✅ + 「支付成功」+ 订单号 → 信息卡（金额 / 支付方式 / 截单时间 / 订单状态）→
 *   查看订单详情 / 返回首页。
 *   与原型的差异：原型只画了支付成功一个态；实装保留**完整三态**
 *   （等待支付 + 重新支付 / 已取消 —— U7「支付失败不改单」与 U8 服务端查询为准是既有验收点）。
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
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

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
  padding: $space-4 $space-4 80rpx;
  box-sizing: border-box;
}

// ---- 结果 hero（居中大图标） ----
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 100rpx 0 $space-4;
  text-align: center;

  &__icon {
    line-height: 1;
  }

  &__title {
    margin-top: $space-4;
    font-size: 44rpx;
    font-weight: bold;
    color: $c-text;
  }

  &__order-no {
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__reason {
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-warn-fg;
  }
}

// ---- 订单信息卡 ----
.info {
  margin: $space-4 $space-2 0;
  padding: $space-4 $space-4;
  background: $c-surface-3;
  border: 1px solid $c-border-strong;
  border-radius: 28rpx;

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

// ---- 状态提示 ----
.tip {
  margin: $space-4 $space-2 0;
  padding: $space-3;
  background: rgba(201, 168, 118, 0.1);
  border-radius: $radius-md;

  &__text {
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
  }
}

// ---- 按钮（主 = 金棕渐变 · 次 = 描边） ----
.btn-primary {
  display: block;
  width: 100%;
  margin: $space-5 0 0;
  padding: $space-3 0;
  background: linear-gradient(135deg, $c-text 0%, $c-gold-deep 100%);
  color: $c-bg;
  font-size: $fs-h2;
  font-weight: bold;
  letter-spacing: 4rpx;
  text-align: center;
  border: none;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    filter: brightness(1.08);
  }
}

.btn-secondary {
  display: block;
  width: 100%;
  margin: $space-3 0 0;
  padding: $space-3 0;
  background: $c-surface;
  color: $c-text;
  font-size: $fs-body;
  text-align: center;
  border: 1px solid $c-text;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &[disabled] {
    opacity: 0.5;
  }

  &--hover {
    opacity: 0.85;
  }
}
</style>
