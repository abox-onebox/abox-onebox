<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP1（v4.10.0）：
         倒计时深棕横幅 → 套餐概念大卡 →（团长身份横幅）→ 跟随团长卡 → 无团长引导 → 一饭四菜 → 价格份数 → 立即预订 -->

    <!-- 倒计时横幅（深棕 · 金字 · 居中） -->
    <view v-if="daily" class="countdown">
      <text class="countdown__label">距离截单还剩</text>
      <text class="countdown__num">{{ countdownText }}</text>
      <text class="countdown__sub">今晚 24:00 后将无法下单</text>
    </view>

    <!-- 首屏骨架 -->
    <ab-loading v-if="loading && !daily" text="正在取今日套餐" />

    <template v-else-if="daily">
      <!-- 套餐概念大卡（米金渐变） -->
      <view class="hero-card">
        <text class="hero-card__icon">🍱</text>
        <text class="hero-card__date">{{ mealDateCn }}</text>
        <view class="hero-card__pill">
          <text class="hero-card__pill-text">四方好味汇一盒</text>
          <text class="hero-card__pill-text">每家只出一道拿手菜</text>
        </view>
      </view>

      <!-- 团长身份横幅（L10：仅 isLeader=true 时显示 → 团长工作台 P11） -->
      <view
        v-if="leaderStore.isLeader"
        class="leader-banner"
        hover-class="leader-banner--hover"
        @tap="goWorkbench"
      >
        <text class="leader-banner__icon">📦</text>
        <view class="leader-banner__main">
          <text class="leader-banner__title">您是{{ leaderLevelLabel }}团长</text>
          <text class="leader-banner__sub">{{ daily.leader?.building ?? '' }}</text>
        </view>
        <text class="leader-banner__chip">进入工作台 ›</text>
      </view>

      <!-- 跟随团长卡 -->
      <view v-if="daily.leader" class="card" @tap="tapSwitchLeader">
        <view class="leader-row">
          <view class="leader-row__left">
            <text class="leader-row__label">跟随团长</text>
            <text class="leader-row__name">{{ daily.leader.name || '本楼团长' }}</text>
            <text class="leader-row__building">{{ daily.leader.building }}</text>
          </view>
          <text class="leader-row__switch">点此切换 ›</text>
        </view>
      </view>

      <!-- 找不到团长时的引导（v4.6） -->
      <view v-if="!daily.leader" class="guide">
        <text class="guide__text">
          💡 所在办公楼没有团长？
          <text class="guide__link" @tap="goLeaderApply">申请成为团长</text>
          （无需审核，立即上岗），或通过该楼团长的邀请链接进入。
        </text>
      </view>
      <view v-else-if="!daily.canOrder" class="guide guide--warn">
        <text class="guide__text">{{ daily.reason ?? '当前不可下单' }}</text>
      </view>

      <!-- 一饭四菜（主食并入同一卡） -->
      <view class="card">
        <text class="card__title">🍴 一饭四菜</text>
        <view v-for="(d, i) in daily.dishes" :key="i" class="dish-row">
          <view class="dish-row__emoji">
            <text>{{ dishEmoji(d.category) }}</text>
          </view>
          <view class="dish-row__info">
            <text class="dish-row__name">{{ d.supplierName }}{{ d.name }}</text>
            <view class="dish-row__from-wrap">
              <text class="dish-row__from">来自：{{ d.supplierName }} ›</text>
            </view>
          </view>
        </view>
        <view v-if="daily.rice" class="dish-row">
          <view class="dish-row__emoji">
            <text>🍚</text>
          </view>
          <view class="dish-row__info">
            <text class="dish-row__name">{{ daily.rice }}</text>
            <view class="dish-row__from-wrap">
              <text class="dish-row__from">主食 · 集散中心统一供米</text>
            </view>
          </view>
        </view>
      </view>

      <!-- 价格 + 份数 -->
      <view class="card">
        <view class="price-row">
          <view class="price-row__left">
            <text class="price-row__label">统一售价</text>
            <view class="price-row__price">
              <text class="price-big">¥{{ unitPriceText }}</text>
              <text class="price-unit">/份</text>
            </view>
          </view>
          <view v-if="canPickQuantity" class="qty-control">
            <view class="qty-btn" :class="{ 'is-disabled': quantity <= 1 }" @tap="decQty">
              <text>−</text>
            </view>
            <text class="qty-value">{{ quantity }}</text>
            <view
              class="qty-btn"
              :class="{ 'is-disabled': quantity >= ORDER_MAX_QUANTITY }"
              @tap="incQty"
            >
              <text>+</text>
            </view>
          </view>
        </view>
      </view>

      <text class="max-hint">单笔最多 {{ ORDER_MAX_QUANTITY }} 份</text>

      <button
        v-if="daily.canOrder && !daily.existingOrderNo"
        class="btn-primary"
        hover-class="btn-primary--hover"
        @tap="goCreate"
      >
        立即预订 ¥{{ totalText }}
      </button>
      <button
        v-else-if="daily.existingOrderNo"
        class="btn-primary btn-primary--ghost"
        hover-class="btn-primary--hover"
        @tap="goDetail"
      >
        查看订单（{{ daily.existingOrderNo }}）
      </button>
      <button v-else class="btn-primary btn-primary--disabled" disabled>本场已截单</button>

      <!-- U2 · 往日这盒（原型 P1 之外的既有验收点，保留在页尾） -->
      <view v-if="history.length" class="section">
        <view class="section__hd">
          <text class="section__title">往日这盒</text>
        </view>
        <view class="history">
          <view v-for="item in history" :key="item.mealDate" class="history__item">
            <text class="history__date">{{ formatMealDateShort(item.mealDate) }}</text>
            <text class="history__dishes">{{ item.dishNames.join(' · ') || '—' }}</text>
            <text class="history__count">{{ item.ordersCount }} 份</text>
          </view>
        </view>
      </view>
    </template>

    <ab-empty-state
      v-else
      :text="emptyText"
      :hint="emptyHint"
      action-text="重新加载"
      @action="load"
    />

    <ab-bottom-bar active="index" />
  </view>
</template>

<script setup lang="ts">
/**
 * P1 · 首页（融合套餐详情）
 *
 * ⭐ 版式基准 = prototype/index.html renderP1（v4.10.0 · 2026-09-18 裁定「19 页逐页对齐原型」）：
 *   倒计时深棕横幅 → 套餐概念大卡 →（团长身份横幅 · L10 仅 isLeader）→ 跟随团长卡 →
 *   无团长引导 → 一饭四菜（含主食行）→ 价格 + 份数 → 立即预订。
 *
 * 验收要点（M1 标准 1 / 5）：
 *   · 微信授权后**直接进首页**，不索要手机号与地址（C3 / L9）
 *   · 倒计时显示距 T-1 24:00 的真实剩余时间（以服务端 `countdownSec` 起表）
 *
 * 数据来源：U1 明日套餐（含 `canOrder` 权威判定、已有订单、跟随团长）+ U2 历史归档。
 * 「往日这盒」是原型之外的既有验收点（U2），保留在页尾。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { HomeDailyResult, HomeHistoryItem } from '@abox/shared-types';
import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';

import { fetchDaily, fetchHistory } from '@/api/meal';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useCountdown } from '@/composables/use-countdown';
import { buildUrl, navigateTo } from '@/utils/router';
import { formatMealDateShort, dishEmoji } from '@/utils/format';
import { ORDER_MAX_QUANTITY } from '@/constants';
import { useLeaderStore } from '@/stores/leader';

const leaderStore = useLeaderStore();
const { run, loading } = useRequest();
const { remainSec, start } = useCountdown();

const daily = ref<HomeDailyResult | null>(null);
const history = ref<HomeHistoryItem[]>([]);
const loadError = ref<ApiError | null>(null);
/** 份数（原型 P1 的 stepper；带入 P3 下单确认） */
const quantity = ref(1);

const emptyText = computed(() => {
  const code = loadError.value?.code;
  if (code === undefined) return '今日暂无开团';
  // 30005 未开团 / 其余按提示语兜底
  return '本楼今日未开团';
});

const emptyHint = computed(
  () => loadError.value?.message ?? '请通过楼长的邀请链接进入，或稍后再试',
);

const countdownText = computed(() => {
  const s = Math.max(0, remainSec.value);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
});

/** mealDate → 「9月19日 周六」（原型概念卡日期行） */
const mealDateCn = computed(() => {
  const raw = daily.value?.mealDate;
  if (!raw) return '';
  const dt = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return raw;
  const week = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()];
  return `${dt.getMonth() + 1}月${dt.getDate()}日 周${week}`;
});

const leaderLevelLabel = computed(() => {
  const level = leaderStore.info?.level;
  return level ? (LEADER_LEVEL_META[level as LeaderLevel]?.label ?? '团长') : '';
});

const unitPriceText = computed(() => ((daily.value?.priceFen ?? 0) / 100).toFixed(2));
const totalText = computed(() =>
  (((daily.value?.priceFen ?? 0) * quantity.value) / 100).toFixed(2),
);

/** 已下单 / 已截单时不给改份数（下一步只有「查看订单」） */
const canPickQuantity = computed(
  () => Boolean(daily.value?.canOrder) && !daily.value?.existingOrderNo,
);

function decQty(): void {
  if (quantity.value > 1) quantity.value -= 1;
}

function incQty(): void {
  if (quantity.value < ORDER_MAX_QUANTITY) quantity.value += 1;
}

/** 拉取首页数据；历史归档失败不拖垮首页 */
async function load(): Promise<void> {
  try {
    const d = await run(() => fetchDaily());

    daily.value = d;
    loadError.value = null;
    quantity.value = 1;
    // 以服务端剩余秒数起表，规避设备时钟偏差
    start(d.countdownSec);

    try {
      const h = await run(() => fetchHistory(1, 3));
      history.value = h.list;
    } catch {
      history.value = [];
    }
  } catch (e) {
    if (daily.value === null) loadError.value = e instanceof ApiError ? e : null;
    toastApiError(e);
  }
}

function goCreate(): void {
  const d = daily.value;
  if (!d) return;
  navigateTo(
    buildUrl('/pages/order-create/order-create', { mealDate: d.mealDate, qty: quantity.value }),
  );
}

function goDetail(): void {
  const orderNo = daily.value?.existingOrderNo;
  if (!orderNo) return;
  navigateTo(buildUrl('/pages/order-detail/order-detail', { orderNo }));
}

function goWorkbench(): void {
  navigateTo('/pages/leader/workbench');
}

function goLeaderApply(): void {
  navigateTo('/pages/leader-apply/leader-apply');
}

/** MVP 无「切换办公楼/团长」能力（进入方式 = 邀请链接绑定），如实告知 */
function tapSwitchLeader(): void {
  uni.showToast({ title: '更换楼栋请通过该楼团长邀请链接进入', icon: 'none' });
}

onShow(() => {
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding-bottom: 200rpx;
  box-sizing: border-box;
}

// ---- 倒计时横幅（深棕 · 金字 · 居中，贴导航栏） ----
.countdown {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-3 $space-4;
  background: $c-text;
  color: $c-bg;
  border-radius: 0 0 36rpx 36rpx;
  text-align: center;

  &__label {
    font-size: $fs-caption;
    opacity: 0.92;
  }

  &__num {
    margin-top: $space-1;
    font-size: 36rpx;
    font-weight: bold;
    color: $c-gold;
    letter-spacing: 2rpx;
    font-family: monospace;
  }

  &__sub {
    margin-top: $space-1;
    font-size: $fs-caption;
    opacity: 0.85;
  }
}

// ---- 套餐概念大卡（米金渐变） ----
.hero-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: $space-2 $space-4 0;
  padding: 44rpx $space-4;
  background: linear-gradient(135deg, #d2c5a0, $c-gold);
  border-radius: 36rpx;
  color: #ffffff;
  text-align: center;

  &__icon {
    font-size: 96rpx;
    line-height: 1;
  }

  &__date {
    margin-top: $space-2;
    font-size: $fs-caption;
    opacity: 0.92;
    letter-spacing: 2rpx;
  }

  &__pill {
    display: flex;
    flex-direction: column;
    margin-top: $space-4;
    padding: $space-2 $space-4;
    background: rgba(255, 255, 255, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: $radius-lg;
  }

  &__pill-text {
    font-size: $fs-caption;
    line-height: 1.6;
    letter-spacing: 1rpx;
  }
}

// ---- 团长身份横幅（金→棕渐变） ----
.leader-banner {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin: $space-3 $space-4 0;
  padding: $space-3 $space-4;
  background: linear-gradient(135deg, $c-gold, $c-text);
  border-radius: $radius-md;
  color: #ffffff;
  box-shadow: 0 8rpx 24rpx rgba(201, 168, 118, 0.35);

  &--hover {
    opacity: 0.9;
  }

  &__icon {
    font-size: 60rpx;
    line-height: 1;
  }

  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  &__title {
    font-size: $fs-body;
    font-weight: bold;
  }

  &__sub {
    margin-top: $space-1;
    font-size: $fs-caption;
    opacity: 0.92;
  }

  &__chip {
    font-size: $fs-caption;
    padding: $space-1 $space-2;
    background: rgba(255, 255, 255, 0.2);
    border-radius: $radius-sm;
  }
}

// ---- 通用卡片 ----
.card {
  margin: $space-3 $space-4 0;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: 0 2rpx 8rpx rgba(110, 84, 53, 0.06);

  &__title {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-h2;
    font-weight: bold;
    letter-spacing: 1rpx;
    color: $c-text;
  }
}

// ---- 跟随团长卡 ----
.leader-row {
  display: flex;
  align-items: center;
  justify-content: space-between;

  &__left {
    display: flex;
    flex-direction: column;
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__name {
    margin-top: $space-1;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__building {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__switch {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 无团长引导 / 截单原因（左侧金边提示条） ----
.guide {
  margin: $space-3 $space-4 0;
  padding: $space-2 $space-3;
  background: #fbf7ee;
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

  &__link {
    color: #b8915c;
    text-decoration: underline;
  }
}

// ---- 一饭四菜 ----
.dish-row {
  display: flex;
  align-items: center;
  gap: $space-3;
  padding: $space-3 0;
  border-bottom: 1px dashed #d4c4a8;

  &:last-child {
    border-bottom: none;
  }

  &__emoji {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 112rpx;
    height: 112rpx;
    background: #efe5d0;
    border-radius: $radius-lg;
    font-size: 64rpx;
  }

  &__info {
    flex: 1;
    min-width: 0;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__from-wrap {
    margin-top: $space-1;
    text-align: right;
  }

  &__from {
    font-size: $fs-caption;
    color: #b8915c;
  }
}

// ---- 价格 + 份数 ----
.price-row {
  display: flex;
  align-items: center;
  justify-content: space-between;

  &__left {
    display: flex;
    flex-direction: column;
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__price {
    display: flex;
    align-items: baseline;
    margin-top: $space-1;
  }
}

.price-big {
  font-size: 60rpx;
  font-weight: bold;
  color: $c-text;
  line-height: 1.2;
}

.price-unit {
  margin-left: $space-1;
  font-size: $fs-body;
  color: $c-text-weak;
}

.qty-control {
  display: inline-flex;
  align-items: center;
  background: $c-bg;
  border: 1px solid #d4c4a8;
  border-radius: $radius-pill;
  overflow: hidden;
}

.qty-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 60rpx;
  height: 60rpx;
  background: #efe5d0;
  color: $c-text;
  font-size: 36rpx;

  &.is-disabled {
    opacity: 0.35;
  }
}

.qty-value {
  width: 72rpx;
  text-align: center;
  font-size: $fs-body;
  font-weight: bold;
  color: $c-text;
}

.max-hint {
  display: block;
  margin: $space-1 $space-4 0;
  text-align: right;
  font-size: $fs-caption;
  color: $c-text-weak;
}

// ---- 立即预订（金棕渐变大按钮） ----
.btn-primary {
  display: block;
  width: calc(100% - #{($space-4 * 2)});
  margin: $space-3 $space-4 0;
  padding: $space-3 0;
  background: linear-gradient(135deg, $c-text 0%, #b8915c 100%);
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

  &--disabled {
    background: rgba(154, 139, 114, 0.2);
    color: $c-text-weak;
  }
}

// ---- 往日这盒（U2 · 原型外保留项） ----
.section {
  margin: $space-4 $space-4 0;

  &__hd {
    display: flex;
    align-items: center;
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }
}

.history {
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__item {
    display: flex;
    align-items: baseline;
    padding: $space-3 $space-4;

    & + & {
      border-top: 1px solid $c-border;
    }
  }

  &__date {
    flex: none;
    width: 90rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__dishes {
    flex: 1;
    overflow: hidden;
    font-size: $fs-caption;
    color: $c-text;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  &__count {
    flex: none;
    margin-left: $space-2;
    font-size: $fs-caption;
    color: $c-gold;
  }
}
</style>
