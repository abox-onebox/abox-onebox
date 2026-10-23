<template>
  <view class="page">
    <!-- 版式基准 = P9 账户余额（同族列表页）：说明条 → 列表卡 → 兜底文案 -->

    <ab-loading v-if="loading && !list.length" text="正在读取优惠券" />

    <view v-else-if="!list.length" class="empty">
      <text class="abi abi-deco-34 empty__icon">{{ I.gift }}</text>
      <text class="empty__text">还没有优惠券</text>
      <text class="empty__hint">推荐同事成为团长、或客服补偿时，券会发到这里</text>
      <button class="empty__btn" hover-class="empty__btn--hover" @tap="goOrder">去下单</button>
    </view>

    <template v-else>
      <!-- 口径说明条 -->
      <view class="tips">
        <text class="tips__text">
          下单时可选券抵扣；券<text class="tips__strong">不找零、不折现</text>，
          一单只能用一张。取消订单或退款后，券会<text class="tips__strong">自动退回</text>。
        </text>
      </view>

      <!-- 可用券 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title"
            ><text class="abi abi-16">{{ I.gift }}</text> 可用 {{ usableCount }} 张</text
          >
        </view>

        <view v-if="!usable.length" class="card__none">
          <text class="card__none-text">暂无可用券</text>
        </view>

        <view
          v-for="item in usable"
          :key="item.code"
          class="cp"
          hover-class="cp--hover"
          @tap="goOrder"
        >
          <view class="cp__left">
            <text class="cp__amount">{{ fenToYuanText(item.faceValueFen) }}</text>
            <text class="cp__cond">{{
              item.thresholdFen > 0 ? `满 ${fenToYuanText(item.thresholdFen)} 可用` : '无门槛'
            }}</text>
          </view>
          <view class="cp__mid">
            <text class="cp__name">{{ item.name }}</text>
            <text class="cp__date">{{ rangeText(item) }}</text>
          </view>
          <view class="cp__right">
            <text class="cp__go">去使用</text>
          </view>
        </view>
      </view>

      <!-- 不可用券（已用 / 已过期：是资产记录，不藏） -->
      <view v-if="unusable.length" class="card">
        <view class="card__hd">
          <text class="card__title">不可用 {{ unusable.length }} 张</text>
        </view>

        <view v-for="item in unusable" :key="item.code" class="cp cp--off">
          <view class="cp__left">
            <text class="cp__amount">{{ fenToYuanText(item.faceValueFen) }}</text>
            <text class="cp__cond">{{
              item.thresholdFen > 0 ? `满 ${fenToYuanText(item.thresholdFen)} 可用` : '无门槛'
            }}</text>
          </view>
          <view class="cp__mid">
            <text class="cp__name">{{ item.name }}</text>
            <text class="cp__date">{{ rangeText(item) }}</text>
          </view>
          <view class="cp__right">
            <text class="cp__why">{{ item.unavailableReason || '不可用' }}</text>
          </view>
        </view>
      </view>

      <text class="foot"
        >券的有效期与来源以本页为准；如有疑问请联系平台客服（我的 → 联系客服）</text
      >
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * 我的优惠券（用户端 · 2026-10-23）
 *
 * 数据来源：`GET /coupon/my` —— 全部券 + 服务端判好的 `available` / `unavailableReason`。
 *
 * ⚠️ 判据不自造：`available` 与「为什么不可用」都取服务端 —— 有效期窗口的
 *    「含不含边界」只有一处定义（后端 `inWindow`）。端上再算一遍必然漂移，
 *    表现为「页面说能用、下单说过期」。
 *
 * ⚠️ 为什么**已用过 / 已过期**的券也要列出来：那是用户已经拿到手的资产，
 *    藏起来会让人以为「我的券丢了」。分区展示即可，不混在可用里。
 *
 * ⚠️ 交互极简（券是辅助功能，不作主玩法）：整卡点击 = 回首页下单，
 *    不做「券详情 / 转赠 / 兑换码输入」—— 一期没有这些通道，做了就是死入口。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchMyCoupons } from '@/api/coupon';
import type { MyCouponItem } from '@/api/coupon';
import { toastApiError, useRequest } from '@/composables/use-request';
import { fenToYuanText } from '@/utils/format';
import { switchTab } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const list = ref<MyCouponItem[]>([]);
const { run, loading } = useRequest();

const usable = computed(() => list.value.filter((c) => c.available));
const unusable = computed(() => list.value.filter((c) => !c.available));
const usableCount = computed(() => usable.value.length);

/** 有效期区间文案（只取日期，不显示时分 —— 券按天生效） */
function rangeText(item: MyCouponItem): string {
  const from = (item.validFrom || '').slice(0, 10);
  const to = (item.validTo || '').slice(0, 10);
  if (!from || !to) return '';
  return `${from} 至 ${to}`;
}

async function load(): Promise<void> {
  try {
    list.value = await run(() => fetchMyCoupons());
  } catch (e) {
    toastApiError(e);
  }
}

/** 券只能在下单时用，故「去使用」= 回首页 */
function goOrder(): void {
  switchTab('/pages/index/index');
}

onShow(() => {
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-3 $space-4 $space-5;
  box-sizing: border-box;
}

// ---- 说明条 ----
.tips {
  padding: $space-3;
  background: $c-surface-3;
  border-left: 6rpx solid $c-info;
  border-radius: $radius-sm;

  &__text {
    display: block;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &__strong {
    font-weight: bold;
    color: $c-text;
  }
}

// ---- 列表卡 ----
.card {
  margin-top: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: 0 2rpx 8rpx rgba(110, 84, 53, 0.06);

  &__hd {
    margin-bottom: $space-2;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__none {
    padding: $space-3 0;
    text-align: center;
  }

  &__none-text {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 单张券 ----
.cp {
  display: flex;
  align-items: center;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

  &:last-child {
    border-bottom: none;
  }

  &--hover {
    opacity: 0.86;
  }

  // 不可用：整卡降饱和（保留可读性，不改用灰底以免误触）
  &--off {
    opacity: 0.55;
  }

  &__left {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 168rpx;
    padding-right: $space-3;
    border-right: 1px dashed $c-border-strong;
  }

  &__amount {
    font-size: 44rpx;
    font-weight: bold;
    color: $c-gold-deep;
  }

  &__cond {
    margin-top: 4rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__mid {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 0 $space-3;
  }

  &__name {
    font-size: $fs-body;
    color: $c-text;
  }

  &__date {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__right {
    flex: none;
  }

  &__go {
    padding: 6rpx $space-3;
    font-size: $fs-caption;
    color: #ffffff;
    background: $c-gold-deep;
    border-radius: $radius-pill;
  }

  &__why {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 空态 ----
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-5 0;

  &__icon {
    opacity: 0.4;
  }

  &__text {
    margin-top: $space-2;
    font-size: $fs-body;
    color: $c-text;
  }

  &__hint {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
    text-align: center;
    line-height: 1.7;
  }

  &__btn {
    height: 68rpx;
    margin-top: $space-4;
    padding: 0 $space-5;
    line-height: 68rpx;
    color: #ffffff;
    font-size: $fs-body;
    background: $c-gold-deep;
    border: none;
    border-radius: $radius-pill;

    &::after {
      border: none;
    }

    &--hover {
      opacity: 0.88;
    }
  }
}

.foot {
  display: block;
  margin-top: $space-3;
  padding: 0 $space-1;
  font-size: $fs-caption;
  line-height: 1.7;
  color: $c-text-weak;
}
</style>
