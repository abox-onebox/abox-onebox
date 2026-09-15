<template>
  <view class="page">
    <ab-loading v-if="loading && !today" text="正在加载本楼概况" />

    <ab-empty-state
      v-else-if="!today"
      text="概况加载失败"
      hint="请稍后重试"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <!-- 楼群 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">{{ displayOr(profile?.buildingName, '本楼') }}</text>
          <text class="card__sub">{{ displayOr(profile?.floor, '未设楼层') }}</text>
        </view>
        <text class="card__foot">
          取餐点：{{ displayOr(pickupPoint, '待分配') }} · {{ formatMealDate(today.mealDate) }}
        </text>
      </view>

      <!-- 份数盘口 -->
      <view class="card">
        <view class="grid">
          <view class="grid__item">
            <text class="grid__value">{{ today.totalQuantity }}</text>
            <text class="grid__label">楼群总份数</text>
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
        <view class="actions">
          <text class="actions__hint">确认收货后可一键分发，佣金按实发份数入账</text>
          <text class="actions__link" @tap="goPickup">去确认 ›</text>
        </view>
      </view>

      <!-- 配送 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">配送</text>
          <text class="card__badge">{{ deliveryStatusText }}</text>
        </view>

        <template v-if="today.delivery">
          <view class="kv">
            <text class="kv__k">预计到达</text>
            <text class="kv__v">{{ formatDateTime(today.delivery.expectedAt) }}</text>
          </view>
          <view class="kv">
            <text class="kv__k">实际送达</text>
            <text class="kv__v">{{
              displayOr(formatDateTime(today.delivery.actualAt), '未送达')
            }}</text>
          </view>
          <view v-if="today.delivery.driverName" class="kv">
            <text class="kv__k">司机</text>
            <text class="kv__v">
              {{ today.delivery.driverName }}
              <text v-if="today.delivery.plateNo"> · {{ today.delivery.plateNo }}</text>
            </text>
          </view>
          <view v-if="today.delivery.driverPhone" class="kv">
            <text class="kv__k">联系电话</text>
            <text class="kv__v">{{ today.delivery.driverPhone }}</text>
          </view>
        </template>

        <text v-else class="card__foot">今日尚无配送单（T-1 24:00 截单后 00:30 生成）</text>
      </view>

      <!-- 楼群成员 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">楼群订单</text>
          <text class="card__sub">{{ today.members.length }} 单</text>
        </view>

        <ab-empty-state v-if="!today.members.length" text="本楼今日暂无订单" />

        <view v-for="m in today.members" :key="m.orderNo" class="member">
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
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P12 · 本楼概况
 *
 * 数据来源：L8 `GET /leader/pickup/today`（份数盘口 + 配送 + 楼群订单）
 *          + L14 `GET /leader/profile`（楼名 / 楼层，L8 不返回）
 *
 * ⚠️ `delivery.expectedAt` / `actualAt` 都是 **UTC ISO**（`....Z`）；
 *    端上用 `formatDateTime` 解析（该函数按字符串取北京时间，不受设备时区影响）。
 * ⚠️ 手机号取服务端 `phoneMasked`，端上不还原明文（§1.6）。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchLeaderProfile } from '@/api/leader';
import type { LeaderProfile } from '@/api/leader';
import { fetchPickupToday } from '@/api/leader-order';
import type { PickupTodayData } from '@/api/leader-order';
import { toastApiError, useRequest } from '@/composables/use-request';
import { displayOr, formatDateTime, formatMealDate } from '@/utils/format';
import { navigateTo } from '@/utils/router';

const { run, loading } = useRequest();

const today = ref<PickupTodayData | null>(null);
const profile = ref<LeaderProfile | null>(null);

const pickupPoint = computed(() => {
  const name = profile.value?.buildingName;
  const floor = profile.value?.floor;
  return [name, floor].filter(Boolean).join(' ') || '';
});

const deliveryStatusText = computed(() => today.value?.delivery?.statusText ?? '待叫车');

async function reload(): Promise<void> {
  try {
    const [t, p] = await Promise.all([
      run(() => fetchPickupToday()),
      run(() => fetchLeaderProfile()),
    ]);
    today.value = t;
    profile.value = p;
  } catch (e) {
    toastApiError(e, '本楼概况加载失败');
  }
}

function goPickup(): void {
  navigateTo('/pages/leader/pickup');
}

onShow(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4;
  box-sizing: border-box;
}

.card {
  margin-bottom: $space-4;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;
  box-shadow: $shadow-card;

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

  &__badge {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__foot {
    display: block;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
  }
}

.grid {
  display: flex;
  align-items: flex-end;
  padding-bottom: $space-3;

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

.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: $space-3;
  border-top: 1px solid rgba(228, 216, 195, 0.6);

  &__hint {
    flex: 1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__link {
    flex: none;
    margin-left: $space-2;
    font-size: $fs-caption;
    color: $c-gold;
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
  }
}

.member {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px solid rgba(228, 216, 195, 0.5);

  &:last-child {
    border-bottom: none;
    padding-bottom: 0;
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
</style>
