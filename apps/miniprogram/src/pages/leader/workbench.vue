<template>
  <view class="page">
    <ab-loading v-if="loading && !data" text="正在加载今日战报" />

    <ab-empty-state
      v-else-if="!data"
      text="今日战报加载失败"
      :hint="errorText"
      action-text="重新加载"
      @action="reload"
    />

    <template v-else>
      <!-- 团长身份条 -->
      <view class="hero">
        <view class="hero__left">
          <text class="hero__name">{{ profileName }}</text>
          <text class="hero__level">{{ data.today.levelLabel }}</text>
        </view>
        <text class="hero__rate">佣金 {{ ratePercent }}%</text>
      </view>

      <!-- 今日战报 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">今日战报</text>
          <text class="card__sub">{{ formatMealDate(data.today.mealDate) }}</text>
        </view>

        <view class="grid">
          <view class="grid__item">
            <text class="grid__value">{{ data.today.orderCount }}</text>
            <text class="grid__label">有效订单</text>
          </view>
          <view class="grid__item">
            <text class="grid__value">{{ data.today.quantity }}</text>
            <text class="grid__label">下单份数</text>
          </view>
          <view class="grid__item">
            <text class="grid__value">{{ fenToYuanText(data.today.amountFen) }}</text>
            <text class="grid__label">成交额</text>
          </view>
        </view>

        <view class="brief">
          <text class="brief__text">
            已确认分发 {{ data.today.completedQuantity }} 份
            <text v-if="data.today.refundCount > 0" class="brief__warn">
              · 退款中 {{ data.today.refundCount }} 单
            </text>
          </text>
          <text class="brief__amount">{{ fenToYuanText(data.today.commissionFen) }}</text>
        </view>
        <text class="card__foot">
          佣金按「实发份数」结算（已分发 {{ data.today.completedQuantity }} 份 × 单价 ×
          {{ ratePercent }}%），取餐确认后才入账
        </text>
      </view>

      <!-- 明日进度 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">明日进度</text>
          <text class="card__sub">{{ formatMealDate(data.tomorrow.mealDate) }}</text>
        </view>

        <ab-countdown :remain-sec="remainSec" label="距截单" />

        <view class="brief brief--plain">
          <text class="brief__text">
            已订 {{ data.tomorrow.orderedCount }} 份 · {{ data.tomorrow.orderedOrders }} 单
          </text>
          <text v-if="data.tomorrow.canOrder" class="brief__link" @tap="goOrder">去下单 ›</text>
        </view>
      </view>

      <!-- 取餐点 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">取餐点</text>
          <text class="card__badge">{{ data.pickup.statusText }}</text>
        </view>

        <text class="pickup__point">{{ displayOr(data.pickup.point, '待分配办公楼 / 楼层') }}</text>

        <view class="pickup__meta">
          <text class="pickup__meta-item">预计到达 {{ data.pickup.expectAt }}</text>
          <text v-if="data.pickup.driverName" class="pickup__meta-item">
            · {{ data.pickup.driverName }}
          </text>
          <text v-if="data.pickup.plateNo" class="pickup__meta-item">
            · {{ data.pickup.plateNo }}
          </text>
        </view>

        <text v-if="data.pickup.actualAt" class="card__foot">
          实际送达 {{ formatDateTime(data.pickup.actualAt) }}
        </text>
      </view>

      <!-- 快捷入口 -->
      <view class="entries">
        <view
          v-for="entry in entries"
          :key="entry.path"
          class="entries__item"
          hover-class="entries__item--hover"
          @tap="go(entry.path)"
        >
          <text class="entries__label">{{ entry.label }}</text>
          <text class="entries__desc">{{ entry.desc }}</text>
        </view>
      </view>
    </template>

    <ab-bottom-bar active="leader" />
  </view>
</template>

<script setup lang="ts">
/**
 * P11 · 团长工作台
 *
 * 数据来源：L1 `GET /leader/workbench`（今日战报 + 明日进度 + 取餐点，一次拿全）。
 *
 * ⚠️ 佣金口径（M2 最高风险项）：**计佣基数 = 实发份数**（`completedQuantity`），
 *    不是下单份数 —— 故「取餐确认 / 一键分发」（P15 · L9）之前佣金恒为 0。
 * ⚠️ `today.cutoffAt` 是 `+08:00` 带偏移 ISO，直接 `Date.parse` 即可；
 *    而 `pickup.actualAt` 是 UTC（`....Z`）—— 两者都用 `Date.parse`，结果一致。
 */
import { computed, onUnmounted, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchWorkbench } from '@/api/leader';
import type { LeaderWorkbenchData } from '@/api/leader';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useLeaderStore } from '@/stores/leader';
import { displayOr, fenToYuanText, formatDateTime, formatMealDate } from '@/utils/format';
import { navigateTo, switchTab } from '@/utils/router';

const { run, loading, error } = useRequest();
const leaderStore = useLeaderStore();

const data = ref<LeaderWorkbenchData | null>(null);
const remainSec = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

const errorText = computed(() => error.value?.message ?? '请稍后重试');
/** 姓名优先取本地身份档案（L1 工作台不回传姓名，避免为一行字多打一次 L14） */
const profileName = computed(() => leaderStore.info?.realName || '团长工作台');
const ratePercent = computed(() => (data.value ? (data.value.today.rate * 100).toFixed(0) : '--'));

const entries = [
  { label: '订单明细', desc: '本楼今日订单', path: '/pages/leader/orders' },
  { label: '取餐确认', desc: '一键分发计佣', path: '/pages/leader/pickup' },
  { label: '佣金中心', desc: '日 / 月明细', path: '/pages/leader/commission' },
  { label: '分享中心', desc: '邀请码与小程序码', path: '/pages/leader/share' },
  { label: '本楼概况', desc: '楼群与配送', path: '/pages/leader/building' },
  { label: '团长资料', desc: '收款 / 退出', path: '/pages/leader/profile' },
];

/** 截单倒计时：每秒重算剩余秒数（不依赖服务端推送） */
function startCountdown(): void {
  stopCountdown();
  const tick = (): void => {
    const iso = data.value?.tomorrow.cutoffAt;
    remainSec.value = iso ? Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000)) : 0;
  };
  tick();
  timer = setInterval(tick, 1000);
}

function stopCountdown(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function reload(): Promise<void> {
  try {
    data.value = await run(() => fetchWorkbench());
    startCountdown();
  } catch (e) {
    toastApiError(e, '今日战报加载失败');
  }
}

function go(path: string): void {
  navigateTo(path);
}

function goOrder(): void {
  switchTab('/pages/index/index');
}

onShow(() => {
  void reload();
});

onUnmounted(() => {
  stopCountdown();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 $space-1 $space-4;

  &__left {
    display: flex;
    align-items: baseline;
  }

  &__name {
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__level {
    margin-left: $space-3;
    padding: 2rpx $space-2;
    font-size: $fs-caption;
    color: $c-text;
    background: rgba(201, 168, 118, 0.24);
    border-radius: $radius-sm;
  }

  &__rate {
    font-size: $fs-caption;
    color: $c-gold;
  }
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
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
  }
}

.grid {
  display: flex;
  align-items: flex-end;
  padding: $space-2 0 $space-3;

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
  }

  &__label {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.brief {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: $space-3;
  border-top: 1px solid rgba(228, 216, 195, 0.6);

  &--plain {
    margin-top: $space-3;
  }

  &__text {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__warn {
    color: $c-warning;
  }

  &__amount {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-gold;
  }

  &__link {
    font-size: $fs-caption;
    color: $c-gold;
  }
}

.pickup {
  &__point {
    display: block;
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__meta {
    margin-top: $space-2;
  }

  &__meta-item {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.entries {
  display: flex;
  flex-wrap: wrap;
  gap: $space-3;

  &__item {
    flex: 1 1 45%;
    padding: $space-4;
    background: $c-surface;
    border: 1px solid $c-border;
    border-radius: $radius-md;

    &--hover {
      opacity: 0.85;
    }
  }

  &__label {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__desc {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}
</style>
