<template>
  <view class="page">
    <ab-loading v-if="loading && !detail" text="正在加载订单" />

    <template v-else-if="detail">
      <!-- 已截单 / 状态不允许：不接受自助取消，直接给出替代路径 -->
      <template v-if="blocked">
        <view class="hero hero--warn">
          <text class="hero__title">无法自助退款</text>
          <text class="hero__desc">
            截单后（T-1 24:00）订单已进入备餐流程，需由团长发起代退申请，平台审批后原路退回。
          </text>
        </view>

        <view class="section">
          <view class="section__hd">
            <text class="section__title">请联系团长</text>
          </view>
          <view class="card">
            <view class="card__row">
              <text class="card__label">团长</text>
              <text class="card__value">{{ leaderName || '本楼团长' }}</text>
            </view>
            <view v-if="leaderPhone" class="card__row" @tap="callLeader">
              <text class="card__label">电话</text>
              <text class="card__value card__value--link">{{ leaderPhone }}</text>
            </view>
          </view>
        </view>
      </template>

      <template v-else>
        <view class="hero">
          <text class="hero__title">确认取消这笔订单？</text>
          <text class="hero__desc">
            截单前可自助取消，已支付金额将原路退回；余额抵扣部分退回账户余额。
          </text>
        </view>

        <view class="section">
          <view class="section__hd">
            <text class="section__title">订单摘要</text>
          </view>
          <view class="card">
            <view class="card__row">
              <text class="card__label">出餐日</text>
              <text class="card__value">{{ formatMealDate(detail.mealDate) }}</text>
            </view>
            <view class="card__row">
              <text class="card__label">份数</text>
              <text class="card__value">× {{ detail.quantity }}</text>
            </view>
            <view class="card__row">
              <text class="card__label">实付</text>
              <text class="card__value card__value--strong">
                {{ fenToYuanText(detail.payAmountFen) }}
              </text>
            </view>
            <view class="card__row">
              <text class="card__label">订单号</text>
              <text class="card__value">{{ detail.orderNo }}</text>
            </view>
          </view>
        </view>
      </template>
    </template>

    <ab-empty-state
      v-else
      text="找不到该订单"
      :hint="errorHint"
      action-text="返回订单列表"
      @action="goList"
    />

    <view v-if="detail" class="actions">
      <button
        v-if="!blocked && !cancelled"
        class="btn btn--danger"
        hover-class="btn--hover"
        :disabled="submitting"
        @tap="confirm"
      >
        {{ submitting ? '处理中…' : '确认取消订单' }}
      </button>
      <button class="btn btn--ghost" hover-class="btn--hover" @tap="goBack">
        {{ cancelled || blocked ? '返回订单详情' : '先不取消' }}
      </button>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * P7 · 取消订单（仅截单前可自助退）
 *
 * 验收要点（M1 标准 3）：
 *   · 截单前取消成功、金额原路退回
 *   · **截单后调取消接口返回 `40004`**，并引导联系团长代退（C6 三段式第一段）
 *
 * ⚠️ 端上**不做**「是否已截单」的判定作为放行依据 ——
 *    截单是服务端硬闸，端上时钟又不可信，故一律以服务端 `40004` 为准。
 *    本页 `blocked` 只用于「已确定不可自助取消」后的展示降级。
 */
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { OrderStatus } from '@abox/shared-types';
import type { OrderDetailResult } from '@abox/shared-types';

import { cancelOrder, fetchOrderDetail } from '@/api/order';
import { ApiError, CODE_REFUND_NOT_ALLOWED } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { fenToYuanText, formatMealDate, maskPhone } from '@/utils/format';
import { navigateBack, pageQuery, switchTab } from '@/utils/router';

const { run, loading } = useRequest();

const detail = ref<OrderDetailResult | null>(null);
const errorHint = ref('请返回订单列表重试');
const orderNo = ref('');
const submitting = ref(false);
const cancelled = ref(false);
/** 服务端已明确拒绝（40004）/ 状态本身不可自助取消 → 降级为「联系团长」 */
const rejectedByServer = ref(false);

/** 可自助取消的状态（截单与否由服务端二次判定） */
const cancellableStatus = computed(() => {
  const s = detail.value?.status;
  return s === OrderStatus.PENDING_PAY || s === OrderStatus.PAID;
});

const blocked = computed(() => rejectedByServer.value || !cancellableStatus.value);

const leaderName = computed(
  () => detail.value?.leaderContact?.name ?? detail.value?.pickup.leaderName ?? '',
);
const leaderPhone = computed(() =>
  maskPhone(detail.value?.leaderContact?.phone ?? detail.value?.pickup.leaderPhone),
);

async function load(): Promise<void> {
  if (!orderNo.value) return;
  try {
    detail.value = await run(() => fetchOrderDetail(orderNo.value));
  } catch (e) {
    if (detail.value === null && e instanceof ApiError) errorHint.value = e.message;
    toastApiError(e);
  }
}

async function confirm(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const res = await run(() => cancelOrder(orderNo.value));
    cancelled.value = true;
    uni.showToast({
      title: res.refundInitiated ? '已取消，款项原路退回' : '订单已取消',
      icon: 'none',
      duration: 2200,
    });
    // 返回详情页后其 onShow 会重新拉取，状态自然刷新
    setTimeout(() => goBack(), 1200);
  } catch (e) {
    if (e instanceof ApiError && e.code === CODE_REFUND_NOT_ALLOWED) {
      // 40004：已截单 → 转「联系团长代退」引导，并把服务端给的团长联系方式补进详情
      rejectedByServer.value = true;
      const payload = e.payload as {
        leaderContact?: { name: string | null; phone: string | null } | null;
      } | null;
      if (payload?.leaderContact && detail.value) {
        detail.value = { ...detail.value, leaderContact: payload.leaderContact };
      }
      void load();
      return;
    }
    toastApiError(e);
  } finally {
    submitting.value = false;
  }
}

function callLeader(): void {
  if (!leaderPhone.value) return;
  uni.makePhoneCall({ phoneNumber: leaderPhone.value, fail: () => undefined });
}

function goBack(): void {
  navigateBack();
}

function goList(): void {
  switchTab('/pages/order-list/order-list');
}

onLoad((options) => {
  orderNo.value = pageQuery(options as Record<string, unknown>, 'orderNo');
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
  padding: $space-5 0 $space-3;

  &__title {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__desc {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &--warn &__title {
    color: $c-warning;
  }
}

.section {
  margin-top: $space-4;

  &__hd {
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
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
    justify-content: space-between;
    padding: $space-3 0;
    border-bottom: 1px solid rgba(228, 216, 195, 0.5);

    &:last-child {
      border-bottom: none;
    }
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    font-size: $fs-caption;
    color: $c-text;

    &--strong {
      font-size: $fs-h2;
      font-weight: 600;
    }

    &--link {
      color: $c-info;
    }
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

  &--danger {
    color: $c-surface;
    background: $c-warning;
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
