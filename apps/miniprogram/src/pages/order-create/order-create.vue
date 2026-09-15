<template>
  <view class="page">
    <ab-loading v-if="loading && !daily" text="正在准备下单" />

    <ab-empty-state
      v-else-if="!daily"
      text="无法下单"
      :hint="errorHint"
      action-text="返回首页"
      @action="goHome"
    />

    <template v-else>
      <view class="section">
        <ab-countdown :remain-sec="remainSec" label="距截单" />
      </view>

      <view class="section">
        <ab-meal-card
          :name="daily.setName"
          :meal-date="daily.mealDate"
          :dishes="daily.dishes"
          :rice="daily.rice"
          :price-fen="daily.priceFen"
        />
      </view>

      <!-- 已有订单：不再允许下单，直接引导查看 -->
      <view v-if="daily.existingOrderNo" class="section">
        <view class="notice notice--warn">
          <text class="notice__text">
            你已提交过本场订单（{{ daily.existingOrderNo }}），请勿重复下单
          </text>
        </view>
      </view>

      <template v-else>
        <!-- 份数 -->
        <view class="section">
          <view class="row">
            <text class="row__label">份数</text>
            <view class="stepper">
              <view
                class="stepper__btn"
                :class="{ 'is-disabled': quantity <= 1 }"
                @tap="decQuantity"
              >
                <text class="stepper__sign">−</text>
              </view>
              <text class="stepper__value">{{ quantity }}</text>
              <view
                class="stepper__btn"
                :class="{ 'is-disabled': quantity >= ORDER_MAX_QUANTITY }"
                @tap="incQuantity"
              >
                <text class="stepper__sign">+</text>
              </view>
            </view>
          </view>
        </view>

        <!-- 备注 -->
        <view class="section">
          <view class="row row--top">
            <text class="row__label">备注</text>
            <textarea
              v-model="remark"
              class="remark"
              placeholder="过敏忌口等（选填，不超过 256 字）"
              placeholder-class="remark__placeholder"
              :maxlength="256"
              auto-height
            />
          </view>
        </view>

        <!-- 金额 -->
        <view class="section">
          <view class="amount">
            <view class="amount__row">
              <text class="amount__label">单价</text>
              <text class="amount__value">¥{{ unitPriceText }}</text>
            </view>
            <view class="amount__row">
              <text class="amount__label">份数</text>
              <text class="amount__value">× {{ quantity }}</text>
            </view>
            <view class="amount__row amount__row--total">
              <text class="amount__label">合计</text>
              <text class="amount__total">¥{{ totalText }}</text>
            </view>
          </view>
        </view>
      </template>
    </template>

    <!-- 固定底部提交条 -->
    <view v-if="daily" class="submit-bar">
      <view class="submit-bar__amount">
        <text class="submit-bar__label">应付</text>
        <text class="submit-bar__value">¥{{ submitAmountText }}</text>
      </view>
      <button
        v-if="daily.existingOrderNo"
        class="btn btn--ghost"
        hover-class="btn--hover"
        @tap="goDetail(daily.existingOrderNo)"
      >
        查看订单
      </button>
      <button
        v-else
        class="btn btn--primary"
        :class="{ 'btn--disabled': !canSubmit }"
        hover-class="btn--hover"
        :disabled="!canSubmit"
        @tap="submit"
      >
        {{ submitting ? '提交中…' : daily.canOrder ? '提交订单' : '本场已截单' }}
      </button>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * P3 · 下单确认
 *
 * 验收要点（M1 标准 2 / 4）：
 *   · 下单 → 支付成功 → 支付结果页 → 订单详情，状态 pending_pay → paid
 *   · 同一幂等键重复下单只产生一单
 *
 * 幂等键策略（§1.4）：
 *   进页面生成一次并在「同一意图」内复用 —— 网络超时重试复用**同一个键**，
 *   真正的重复提交才会被服务端拦成 `10006`；
 *   但若服务端**已受理且业务拒绝**（如截单、超份数），该键在 KV 中仍是占位状态
 *   （服务端刻意保留 10 分钟作为锁），故此时**换发新键**，避免用户无法重试。
 */
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { CreateOrderResult, HomeDailyResult } from '@abox/shared-types';

import { fetchDaily } from '@/api/meal';
import { createOrder } from '@/api/order';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useCountdown } from '@/composables/use-countdown';
import { useWechatPay } from '@/composables/use-wechat-pay';
import { ORDER_MAX_QUANTITY } from '@/constants';
import { fenToYuan, uuid } from '@/utils/format';
import { buildUrl, navigateBack, navigateTo, pageQuery, redirectTo } from '@/utils/router';

const { run, loading } = useRequest();
const { remainSec, start } = useCountdown();
const { pay } = useWechatPay();

const daily = ref<HomeDailyResult | null>(null);
const quantity = ref(1);
const remark = ref('');
const submitting = ref(false);
const errorHint = ref('请返回首页重试');

/** 下单幂等键（同一意图内复用） */
let orderIdemKey = '';
/** 支付幂等键（U7 独立作用域 `idem:pay:*`） */
let payIdemKey = '';

const unitPriceText = computed(() => fenToYuan(daily.value?.priceFen ?? 0));
const totalFen = computed(() => (daily.value?.priceFen ?? 0) * quantity.value);
const totalText = computed(() => fenToYuan(totalFen.value));
const submitAmountText = computed(() => (daily.value?.existingOrderNo ? '0.00' : totalText.value));
const canSubmit = computed(
  () => !!daily.value?.canOrder && !daily.value.existingOrderNo && !submitting.value,
);

function decQuantity(): void {
  if (quantity.value > 1) quantity.value -= 1;
}

function incQuantity(): void {
  if (quantity.value < ORDER_MAX_QUANTITY) quantity.value += 1;
}

async function load(mealDate: string): Promise<void> {
  try {
    const d = await run(() => fetchDaily(mealDate || undefined));
    daily.value = d;
    start(d.countdownSec);
  } catch (e) {
    if (e instanceof ApiError) errorHint.value = e.message;
    toastApiError(e);
  }
}

/**
 * 提交订单并唤起支付
 *
 * ⚠️ 支付失败/取消**不改订单状态**：订单已落库为 `pending_pay`，
 *    一律跳支付结果页，由用户在结果页选择「重新支付」或稍后从订单详情继续。
 */
async function submit(): Promise<void> {
  const d = daily.value;
  if (!d || !canSubmit.value) return;

  submitting.value = true;
  try {
    let created: CreateOrderResult;
    try {
      created = await run(() =>
        createOrder(
          {
            mealDate: d.mealDate,
            quantity: quantity.value,
            remark: remark.value.trim() || undefined,
          },
          orderIdemKey,
        ),
      );
    } catch (e) {
      // 服务端已受理并拒绝（业务码 > 0）→ 换发新键，让用户可以改条件后重试
      if (e instanceof ApiError && e.code > 0) orderIdemKey = newOrderKey();
      throw e;
    }

    try {
      await pay(created.orderNo, payIdemKey);
    } catch (e) {
      console.warn('[order-create] 支付未完成，订单保留为待支付', e);
    }

    redirectTo(buildUrl('/pages/pay-result/pay-result', { orderNo: created.orderNo }));
  } catch (e) {
    toastApiError(e);
  } finally {
    submitting.value = false;
  }
}

/** 换发新的下单幂等键（服务端已受理并拒绝的场景使用，避免被占位锁挡住重试） */
function newOrderKey(): string {
  return uuid();
}

function goHome(): void {
  navigateBack();
}

function goDetail(orderNo: string): void {
  navigateTo(buildUrl('/pages/order-detail/order-detail', { orderNo }));
}

onLoad((options) => {
  const mealDate = pageQuery(options as Record<string, unknown>, 'mealDate');
  orderIdemKey = uuid();
  payIdemKey = uuid();
  void load(mealDate);
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

.section {
  margin-bottom: $space-4;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &--top {
    align-items: flex-start;
  }

  &__label {
    flex: none;
    font-size: $fs-body;
    color: $c-text;
  }
}

.stepper {
  display: flex;
  align-items: center;

  &__btn {
    width: 56rpx;
    height: 56rpx;
    line-height: 52rpx;
    text-align: center;
    border: 1px solid $c-border;
    border-radius: $radius-sm;

    &.is-disabled {
      opacity: 0.4;
    }
  }

  &__sign {
    font-size: $fs-h2;
    color: $c-text;
  }

  &__value {
    min-width: 88rpx;
    font-size: $fs-h2;
    text-align: center;
    color: $c-text;
  }
}

.remark {
  flex: 1;
  margin-left: $space-4;
  min-height: 60rpx;
  font-size: $fs-body;
  text-align: right;
  color: $c-text;

  &__placeholder {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.amount {
  padding: $space-3 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: $space-2 0;

    &--total {
      margin-top: $space-2;
      padding-top: $space-3;
      border-top: 1px solid $c-border;
    }
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    font-size: $fs-body;
    color: $c-text;
  }

  &__total {
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }
}

.submit-bar {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 $space-4;
  padding-bottom: calc(#{$space-3} + env(safe-area-inset-bottom));
  background: $c-surface;
  border-top: 1px solid $c-border;

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    margin-left: $space-2;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }
}

.btn {
  min-width: 260rpx;
  height: 76rpx;
  padding: 0 $space-5;
  font-size: $fs-body;
  line-height: 76rpx;
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
