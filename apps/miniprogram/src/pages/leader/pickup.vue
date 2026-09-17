<template>
  <view class="page">
    <ab-loading v-if="loading && !today" text="正在加载取餐信息" />

    <ab-empty-state
      v-else-if="!today"
      text="取餐信息加载失败"
      hint="请稍后重试"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <!-- 配送状态 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">配送</text>
          <text class="card__badge">{{ today.delivery?.statusText ?? '待叫车' }}</text>
        </view>
        <view class="kv">
          <text class="kv__k">出餐日</text>
          <text class="kv__v">{{ formatMealDate(today.mealDate) }}</text>
        </view>
        <template v-if="today.delivery">
          <view class="kv">
            <text class="kv__k">预计到达</text>
            <text class="kv__v">{{ formatDateTime(today.delivery.expectedAt) }}</text>
          </view>
          <view v-if="today.delivery.actualAt" class="kv">
            <text class="kv__k">实际送达</text>
            <text class="kv__v">{{ formatDateTime(today.delivery.actualAt) }}</text>
          </view>
        </template>
      </view>

      <!-- 份数盘口 -->
      <view class="card">
        <view class="grid">
          <view class="grid__item">
            <text class="grid__value">{{ today.totalQuantity }}</text>
            <text class="grid__label">总份数</text>
          </view>
          <view class="grid__item">
            <text class="grid__value grid__value--ok">{{ today.confirmedQuantity }}</text>
            <text class="grid__label">已分发</text>
          </view>
          <view class="grid__item">
            <text class="grid__value grid__value--warn">{{ today.pendingQuantity }}</text>
            <text class="grid__label">待分发</text>
          </view>
        </view>
      </view>

      <!-- 本次分发结果 -->
      <view v-if="done" class="card card--done">
        <text class="done__title">分发完成</text>
        <view class="kv">
          <text class="kv__k">确认订单</text>
          <text class="kv__v">{{ done.confirmedCount }} 单</text>
        </view>
        <view class="kv">
          <text class="kv__k">实发份数</text>
          <text class="kv__v">{{ done.confirmedQuantity }} 份</text>
        </view>
        <view class="kv">
          <text class="kv__k">本次计佣</text>
          <text class="kv__v kv__v--strong">¥{{ done.commissionYuan }}</text>
        </view>
        <text class="done__tips">
          佣金按「实发份数 × 单价 ×
          {{ (done.rate * 100).toFixed(0) }}%」计佣，将于次日 02:00
          自动入账到余额，届时可在佣金中心查看
        </text>
        <view class="done__acts">
          <text class="done__link" @tap="goCommission">看佣金 ›</text>
          <text class="done__link" @tap="goOrders">看订单 ›</text>
        </view>
      </view>

      <view v-else-if="repeatedTips" class="card">
        <text class="card__foot">{{ repeatedTips }}</text>
      </view>

      <!-- 待分发订单 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">待分发订单（{{ pendingList.length }}）</text>
          <text v-if="pendingList.length" class="card__link" @tap="toggleAll">
            {{ allSelected ? '取消全选' : '全选' }}
          </text>
        </view>

        <ab-empty-state
          v-if="!pendingList.length"
          text="没有待分发的订单"
          hint="已送达（delivered）的订单才会出现在这里"
        />

        <view v-for="m in pendingList" :key="m.orderNo" class="member" @tap="toggle(m.orderNo)">
          <view class="member__check" :class="{ 'is-on': selected.includes(m.orderNo) }" />
          <view class="member__left">
            <text class="member__name">{{ displayOr(m.userName, '匿名用户') }}</text>
            <text class="member__phone">{{ displayOr(m.phoneMasked, '未留手机号') }}</text>
          </view>
          <view class="member__right">
            <text class="member__qty">{{ m.quantity }} 份</text>
            <text class="member__status">{{ m.statusText }}</text>
          </view>
        </view>
      </view>

      <view v-if="!done" class="submit">
        <button
          class="submit__btn"
          :disabled="submitting || !selected.length"
          hover-class="submit__btn--hover"
          @tap="confirm"
        >
          {{ submitting ? '分发中…' : `一键分发（${selectedQuantity} 份）` }}
        </button>
        <text class="submit__hint">
          分发后订单转为「已完成」，佣金按「实发份数」计佣（次日 02:00
          自动入账）；重复提交不会重复计佣
        </text>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P15 · 取餐确认（一键分发）
 *
 * 数据来源：L8 `GET /leader/pickup/today` → L9 `POST /leader/pickup/confirm`。
 *
 * ⚠️ **计佣基数 = 实发份数**（M2 最高风险口径）：只有 `delivered` 的订单被确认后才计佣，
 *    基数取订单**份数**，剔除已退款 —— 故本页的按钮文案刻意显示「N 份」而非「N 单」。
 * ⚠️ 幂等键策略：**一次「提交意图」一个 key**。失败后重试沿用同一 key（服务端失败即释放键），
 *    成功后立即作废 —— 否则下一批分发会命中 10006 回放上一批结果。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { confirmPickup, fetchPickupToday } from '@/api/leader-order';
import type { PickupConfirmDone, PickupTodayData } from '@/api/leader-order';
import { apiErrorMessage, useRequest } from '@/composables/use-request';
import { displayOr, formatDateTime, formatMealDate, uuid } from '@/utils/format';
import { navigateTo } from '@/utils/router';

const { run, loading } = useRequest();

const today = ref<PickupTodayData | null>(null);
const selected = ref<string[]>([]);
const submitting = ref(false);
const done = ref<PickupConfirmDone | null>(null);
const repeatedTips = ref('');

/** 当前「提交意图」的幂等键（失败重试沿用；成功后作废） */
let pendingKey = '';

/** 可分发：已送达 / 配送中（服务端只推进这两态） */
const pendingList = computed(() =>
  (today.value?.members ?? []).filter((m) =>
    ['delivered', 'delivering'].includes(String(m.status)),
  ),
);

const allSelected = computed(
  () => pendingList.value.length > 0 && selected.value.length === pendingList.value.length,
);

const selectedQuantity = computed(() =>
  pendingList.value
    .filter((m) => selected.value.includes(m.orderNo))
    .reduce((sum, m) => sum + Number(m.quantity || 0), 0),
);

function syncDefaultSelection(): void {
  // 默认全选待分发订单（一次取餐通常整批分发）
  selected.value = pendingList.value.map((m) => m.orderNo);
}

function toggle(orderNo: string): void {
  const i = selected.value.indexOf(orderNo);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(orderNo);
}

function toggleAll(): void {
  selected.value = allSelected.value ? [] : pendingList.value.map((m) => m.orderNo);
}

async function reload(): Promise<void> {
  try {
    done.value = null;
    repeatedTips.value = '';
    const res = await run(() => fetchPickupToday());
    today.value = res;
    syncDefaultSelection();
  } catch (e) {
    if (!today.value) today.value = null;
    uni.showToast({ title: apiErrorMessage(e), icon: 'none' });
  }
}

async function confirm(): Promise<void> {
  if (submitting.value || !selected.value.length) return;

  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: '确认分发',
      content: `将为 ${selected.value.length} 单、共 ${selectedQuantity.value} 份确认取餐并计佣。确认后不可撤销。`,
      confirmText: '确认分发',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
  if (!confirmed) return;

  submitting.value = true;
  if (!pendingKey) pendingKey = uuid();

  try {
    const res = await run(() => confirmPickup(selected.value, pendingKey));
    pendingKey = '';
    if (res.repeated) {
      repeatedTips.value = res.tips;
      uni.showToast({ title: res.tips, icon: 'none' });
    } else {
      done.value = res;
      uni.showToast({ title: `已分发 ${res.confirmedQuantity} 份`, icon: 'none' });
    }
    const fresh = await run(() => fetchPickupToday());
    today.value = fresh;
    selected.value = [];
  } catch (e) {
    // 失败保留 pendingKey：用户点「重试」时沿用同一键，不会产生重复计佣
    uni.showToast({ title: apiErrorMessage(e, '分发失败'), icon: 'none', duration: 2400 });
  } finally {
    submitting.value = false;
  }
}

function goCommission(): void {
  navigateTo('/pages/leader/commission');
}

function goOrders(): void {
  navigateTo('/pages/leader/orders');
}

onShow(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 220rpx;
  box-sizing: border-box;
}

.card {
  margin-bottom: $space-4;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &--done {
    border-color: $c-gold;
  }

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

  &__badge {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__link {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__foot {
    display: block;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.done {
  &__title {
    display: block;
    margin-bottom: $space-3;
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-success;
  }

  &__tips {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &__acts {
    display: flex;
    gap: $space-4;
    margin-top: $space-3;
  }

  &__link {
    font-size: $fs-caption;
    color: $c-gold;
  }
}

.grid {
  display: flex;
  align-items: flex-end;

  &__item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  &__value {
    font-size: $fs-display;
    font-weight: 600;
    color: $c-text;
    font-variant-numeric: tabular-nums;

    &--ok {
      color: $c-success;
    }

    &--warn {
      color: $c-warning;
    }
  }

  &__label {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: $space-2 0;

  &__k {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__v {
    font-size: $fs-caption;
    color: $c-text;

    &--strong {
      font-size: $fs-h2;
      font-weight: 600;
      color: $c-gold;
    }
  }
}

.member {
  display: flex;
  align-items: center;
  padding: $space-3 0;
  border-bottom: 1px solid rgba(228, 216, 195, 0.5);

  &:last-child {
    border-bottom: none;
  }

  &__check {
    flex: none;
    width: 32rpx;
    height: 32rpx;
    margin-right: $space-3;
    border: 1px solid $c-border;
    border-radius: 50%;

    &.is-on {
      background: $c-gold;
      border-color: $c-gold;
    }
  }

  &__left {
    flex: 1;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__phone {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__right {
    flex: none;
    text-align: right;
  }

  &__qty {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__status {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.submit {
  &__btn {
    height: 88rpx;
    font-size: $fs-body;
    line-height: 88rpx;
    color: $c-surface;
    background: $c-text;
    border-radius: $radius-pill;

    &::after {
      border: none;
    }

    &--hover {
      opacity: 0.85;
    }

    &[disabled] {
      opacity: 0.4;
    }
  }

  &__hint {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
    text-align: center;
  }
}
</style>
