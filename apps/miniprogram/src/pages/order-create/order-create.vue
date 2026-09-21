<template>
  <view class="page">
    <ab-loading v-if="loading && !daily" text="正在准备下单" />

    <ab-empty-state
      v-else-if="!daily"
      text="无法下单"
      :hint="errorHint"
      illustration="clock"
      action-text="返回首页"
      @action="goHome"
    />

    <template v-else>
      <!-- 倒计时横幅（P3 原型用警示红底） -->
      <view class="countdown countdown--warn">
        <text class="countdown__label">距离截单还剩</text>
        <text class="countdown__num">{{ countdownText }}</text>
      </view>

      <!-- 套餐清单卡 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">明日套餐（{{ quantity }} 份）</text>
          <view v-if="!daily.existingOrderNo" class="stepper">
            <view class="stepper__btn" :class="{ 'is-disabled': quantity <= 1 }" @tap="decQuantity">
              <text>−</text>
            </view>
            <text class="stepper__value">{{ quantity }}</text>
            <view
              class="stepper__btn"
              :class="{ 'is-disabled': quantity >= ORDER_MAX_QUANTITY }"
              @tap="incQuantity"
            >
              <text>+</text>
            </view>
          </view>
        </view>
        <view v-for="(d, i) in daily.dishes" :key="i" class="menu-row">
          <text class="menu-row__name">{{ d.name }}</text>
          <text class="menu-row__from">来自：{{ d.supplierName }}</text>
        </view>
        <view v-if="daily.rice" class="menu-row">
          <text class="menu-row__name">米饭</text>
          <text class="menu-row__from">来自：集散中心</text>
        </view>
        <view class="menu-total">
          <text class="menu-total__calc">{{ quantity }} 份 × ¥{{ unitPriceText }}</text>
          <text class="menu-total__price">¥{{ totalText }}</text>
        </view>
      </view>

      <!-- 已有订单：不再允许下单，直接引导查看 -->
      <view v-if="daily.existingOrderNo" class="guide guide--warn">
        <text class="guide__text">
          你已提交过本场订单（{{ daily.existingOrderNo }}），请勿重复下单
        </text>
      </view>

      <template v-else>
        <!-- 取餐信息（M5-17：把「这一单的团长是谁 / 佣金归谁」写清楚） -->
        <view class="card">
          <text class="card__title">
            <text class="abi abi-16">{{ I.pin }}</text> 取餐信息（{{
              daily.leader?.source === 'bound' ? '跟随团长' : '本楼团长'
            }}）
          </text>
          <view class="pickup-row">
            <text class="pickup-row__leader">
              {{ daily.leader?.name ?? '本楼团长' }}（团长）· {{ daily.leader?.building ?? '' }}
            </text>
          </view>
          <!-- 自动挂靠必须在这里说：这是用户最后一次「付款前」能看见归属的机会 -->
          <text v-if="daily.leader?.source === 'building_default'" class="pickup-row__attr">
            你未绑定团长，本单已自动挂靠本楼团长，佣金归
            TA；如需更换，请通过该楼团长的邀请链接进入。
          </text>
          <!-- ⚠️ 时刻来自响应（`daily.deliverAt`）—— 曾写死 `11:30`（PR-02 收口） -->
          <text class="pickup-row__hint">明天 {{ daily.deliverAt }} 由团长统一取餐并分发</text>
          <view class="pickup-row__tip">
            <text
              ><text class="abi abi-16">{{ I.info }}</text> 有问题？微信直接联系团长沟通</text
            >
          </view>
        </view>

        <!-- 备注 -->
        <view class="card">
          <text class="card__title">备注</text>
          <textarea
            v-model="remark"
            class="remark"
            placeholder="过敏忌口等（选填，不超过 256 字）"
            placeholder-class="remark__placeholder"
            :maxlength="256"
            auto-height
          />
        </view>

        <!-- 支付方式 -->
        <view class="card">
          <text class="card__title"
            ><text class="abi abi-16">{{ I.cash }}</text> 支付方式</text
          >
          <view class="pay-row">
            <text class="pay-row__name"
              ><text class="abi abi-16">{{ I['ok-circle'] }}</text> 微信支付</text
            >
            <text class="pay-row__dot">●</text>
          </view>
        </view>

        <button
          class="btn-primary"
          :class="{ 'is-disabled': !canSubmit }"
          hover-class="btn-primary--hover"
          :disabled="!canSubmit"
          @tap="submit"
        >
          {{ submitting ? '提交中…' : daily.canOrder ? `确认支付 ¥${totalText}` : '本场已截单' }}
        </button>
      </template>

      <button
        v-if="daily.existingOrderNo"
        class="btn-primary btn-primary--ghost"
        hover-class="btn-primary--hover"
        @tap="goDetail(daily.existingOrderNo)"
      >
        查看订单
      </button>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P3 · 下单确认
 *
 * ⭐ 版式基准 = prototype/index.html renderP3（2026-09-18 裁定「19 页逐页对齐原型」）：
 *   警示红倒计时横幅 → 套餐清单卡（菜名 + 来自：供应商，份数 × 单价 = 合计）→
 *   取餐信息卡（跟随团长 · 明天 11:30 统一分发）→ 支付方式卡 → 确认支付。
 *   与原型的差异：备注输入**保留**（原型「简化版」删了它，但 256 字备注是既有验收点）；
 *   份数 stepper 收进套餐卡标题行（原型放在 P1，此处保留便于直接改数）。
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
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

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

const countdownText = computed(() => {
  const s = Math.max(0, remainSec.value);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
});

const unitPriceText = computed(() => fenToYuan(daily.value?.priceFen ?? 0));
const totalFen = computed(() => (daily.value?.priceFen ?? 0) * quantity.value);
const totalText = computed(() => fenToYuan(totalFen.value));
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
  const query = options as Record<string, unknown>;
  const mealDate = pageQuery(query, 'mealDate');
  // P1 首页 stepper 带入的份数（原型交互：P1 选份数 → P3 确认）；非法值回落 1
  const qtyRaw = Number(pageQuery(query, 'qty'));
  if (Number.isFinite(qtyRaw) && qtyRaw >= 1) {
    quantity.value = Math.min(Math.floor(qtyRaw), ORDER_MAX_QUANTITY);
  }
  orderIdemKey = uuid();
  payIdemKey = uuid();
  void load(mealDate);
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding-bottom: 60rpx;
  box-sizing: border-box;
}

// ---- 倒计时横幅（P3 原型 = 警示红底） ----
.countdown {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-3 $space-4;
  background: $c-text;
  color: $c-bg;
  border-radius: 0 0 36rpx 36rpx;
  text-align: center;

  &--warn {
    background: $c-warning;
  }

  &__label {
    font-size: $fs-caption;
    opacity: 0.92;
  }

  &__num {
    margin-top: $space-1;
    font-size: 36rpx;
    font-weight: bold;
    color: $c-gold-fg;
    letter-spacing: 2rpx;
    font-family: monospace;
  }
}

// ---- 卡片 ----
.card {
  margin: $space-3 $space-4 0;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: 0 2rpx 8rpx rgba(110, 84, 53, 0.06);

  &__hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: $space-2;
  }

  &__title {
    display: block;
    font-size: $fs-h2;
    font-weight: bold;
    letter-spacing: 1rpx;
    color: $c-text;
  }
}

// ---- 套餐清单行 ----
.menu-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: $space-2 0;
  border-bottom: 1px dashed $c-border-strong;

  &__name {
    font-size: $fs-body;
    color: $c-text;
  }

  &__from {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.menu-total {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  margin-top: $space-3;
  padding-top: $space-3;

  &__calc {
    margin-bottom: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__price {
    font-size: 60rpx;
    font-weight: bold;
    color: $c-text;
    line-height: 1.2;
  }
}

// ---- 份数 stepper ----
.stepper {
  display: flex;
  align-items: center;

  &__btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56rpx;
    height: 56rpx;
    background: $c-surface-2;
    border-radius: $radius-sm;
    color: $c-text;
    font-size: $fs-h2;

    &.is-disabled {
      opacity: 0.35;
    }
  }

  &__value {
    min-width: 80rpx;
    font-size: $fs-h2;
    font-weight: bold;
    text-align: center;
    color: $c-text;
  }
}

// ---- 取餐信息 ----
.pickup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;

  &__leader {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  // 佣金归属明示（M5-17）：用主文字色而非弱灰 —— 这是一条与钱有关的告知，
  // 不该以「可略过」的视觉权重呈现。左侧金边沿用页面既有的提示条语言。
  &__attr {
    display: block;
    margin-top: $space-2;
    padding: $space-2 $space-3;
    border-left: 6rpx solid $c-gold;
    border-radius: $radius-sm;
    background: $c-bg;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text;
  }

  &__hint {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__tip {
    margin-top: $space-3;
    padding: $space-2 $space-3;
    background: $c-bg;
    border-radius: $radius-md;

    text {
      font-size: $fs-caption;
      color: $c-text-weak;
    }
  }
}

// ---- 备注 ----
.remark {
  width: 100%;
  min-height: 60rpx;
  font-size: $fs-body;
  color: $c-text;

  &__placeholder {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 支付方式 ----
.pay-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-2 0;

  &__name {
    font-size: $fs-body;
    color: $c-text;
  }

  &__dot {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-gold-fg;
  }
}

// ---- 无订单提示（左红边） ----
.guide {
  margin: $space-3 $space-4 0;
  padding: $space-2 $space-3;
  background: $c-surface-3;
  border-left: 6rpx solid $c-gold;
  border-radius: $radius-sm;

  &--warn {
    border-left-color: $c-warning;
  }

  &__text {
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

// ---- 确认支付（金棕渐变大按钮） ----
.btn-primary {
  display: block;
  width: calc(100% - #{($space-4 * 2)});
  margin: $space-4 $space-4 0;
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

  &--ghost {
    background: $c-surface;
    color: $c-text;
    border: 1px solid $c-text;
  }

  &.is-disabled {
    background: rgba(154, 139, 114, 0.2);
    color: $c-text-weak;
  }
}
</style>
