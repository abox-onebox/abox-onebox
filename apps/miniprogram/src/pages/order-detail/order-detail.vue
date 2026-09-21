<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP5（v4.10.0）：
         状态渐变卡 → 出餐进度（6 步）→ 订单号（可复制）→ 套餐明细 → 取餐方式 → 动作 -->

    <ab-loading v-if="loading && !detail" text="正在加载订单" />

    <ab-empty-state
      v-else-if="!detail"
      text="找不到该订单"
      :hint="errorHint"
      illustration="search"
      action-text="返回订单列表"
      @action="goList"
    />

    <template v-else>
      <!-- 状态卡：正常流转用金棕渐变；异常态（取消 / 退款族）用灰渐变 -->
      <view class="status" :class="abnormal ? 'status--muted' : ''">
        <view class="status__left">
          <text class="status__label">订单状态</text>
          <text class="status__text">{{ detail.statusText }}</text>
        </view>
        <text class="abi abi-deco-34 status__icon">{{ I[abnormal ? 'x-circle' : 'rice'] }}</text>
      </view>
      <text class="status__hint">{{ statusHint }}</text>

      <!-- 出餐进度（服务端 6 步状态机时间线） -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title"
            ><text class="abi abi-16">{{ I.pin }}</text> 出餐进度</text
          >
          <text class="card__sub">{{ doneCount }}/{{ detail.timeline.length }} 步</text>
        </view>
        <view class="timeline">
          <view
            v-for="(node, i) in detail.timeline"
            :key="node.node"
            class="tl"
            :class="{
              'is-done': node.done,
              'is-doing': dotState(node, i) === 'doing',
              'is-last': i === detail.timeline.length - 1,
            }"
          >
            <view class="tl__rail">
              <view class="tl__dot" :class="`is-${dotState(node, i)}`">
                <text v-if="node.done" class="abi abi-deco-28 tl__dot-ico">{{ I.check }}</text>
              </view>
              <view
                v-if="i !== detail.timeline.length - 1"
                class="tl__line"
                :class="{ 'is-done': node.done }"
              />
            </view>
            <view class="tl__body">
              <text class="tl__text">{{ node.text }}</text>
              <text class="tl__at">{{ node.at ? formatDateTime(node.at) : '—' }}</text>
            </view>
          </view>
          <view v-if="!detail.timeline.length" class="tl__empty">
            <text class="tl__empty-text">暂无可展示的进度节点</text>
          </view>
        </view>
      </view>

      <!-- 订单号 + 复制 -->
      <view class="card card--row">
        <view class="ono">
          <text class="ono__label">订单号</text>
          <text class="ono__value">{{ detail.orderNo }}</text>
        </view>
        <button class="mini-btn" hover-class="mini-btn--hover" @tap="copyOrderNo">
          <text class="abi abi-20">{{ I.copy }}</text> 复制
        </button>
      </view>

      <!-- 套餐明细 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title"
            ><text class="abi abi-16">{{ I.rice }}</text> 套餐明细</text
          >
          <text class="card__sub"
            >{{ formatMealDate(detail.mealDate) }} · × {{ detail.quantity }}</text
          >
        </view>
        <view v-for="dish in detail.dishes" :key="`${dish.slot}-${dish.name}`" class="dish">
          <text class="dish__slot">{{ SLOT_LABEL[dish.slot] || '菜品' }}</text>
          <text class="dish__name">{{ dish.name }}</text>
          <text class="dish__from">{{
            dish.supplierName ? `来自：${dish.supplierName}` : ''
          }}</text>
        </view>
        <view v-if="!detail.dishes.length" class="dish">
          <text class="dish__slot">套餐</text>
          <text class="dish__name">配菜待公布</text>
          <text class="dish__from" />
        </view>

        <!-- 金额：单价 → 份数 → 合计 →（余额抵扣）→ 实付 -->
        <view class="sum">
          <view class="sum__row">
            <text class="sum__label">单价 × 份数</text>
            <text class="sum__value">
              {{ fenToYuanText(detail.unitPriceFen) }} × {{ detail.quantity }}
            </text>
          </view>
          <view class="sum__row">
            <text class="sum__label">订单金额</text>
            <text class="sum__value">{{ fenToYuanText(detail.totalAmountFen) }}</text>
          </view>
          <view v-if="detail.balanceUsedFen > 0" class="sum__row">
            <text class="sum__label">余额抵扣</text>
            <text class="sum__value">−{{ fenToYuanText(detail.balanceUsedFen) }}</text>
          </view>
          <view class="sum__row sum__row--total">
            <text class="sum__label">实付</text>
            <text class="sum__total">{{ fenToYuanText(detail.payAmountFen) }}</text>
          </view>
        </view>

        <view v-if="detail.remark" class="remark">
          <text class="remark__text">备注：{{ detail.remark }}</text>
        </view>
      </view>

      <!-- 取餐方式 -->
      <view class="card">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.pin }}</text> 取餐方式</text
        >
        <text class="pickup__who">
          <text class="pickup__strong">{{ leaderName }}</text
          >（团长）· {{ detail.pickup.point }}
        </text>
        <!-- ⚠️ 时刻来自响应（`pickup.expectAt`，服务端按生效时间轴派生）—— 曾写死 `11:30`，
             改配置后会与系统行为不一致（PR-02 收口） -->
        <text class="pickup__when"
          >明日 {{ detail.pickup.expectAt }} 由团长统一取餐并分发至取餐点</text
        >
        <view class="pickup__acts">
          <button class="ghost-btn" hover-class="ghost-btn--hover" @tap="contactLeader">
            <text class="abi abi-20">{{ I.phone }}</text> 联系团长
          </button>
          <button class="ghost-btn" hover-class="ghost-btn--hover" @tap="goSupport">
            <text class="abi abi-20">{{ I.message }}</text> 平台客服
          </button>
        </view>
      </view>

      <!-- 订单信息（原型未单列，保留既有验收点：下单/支付时间） -->
      <view class="card">
        <view class="kv">
          <text class="kv__k">下单时间</text>
          <text class="kv__v">{{ formatDateTime(detail.createdAt) }}</text>
        </view>
        <view class="kv">
          <text class="kv__k">支付时间</text>
          <text class="kv__v">{{ formatDateTime(detail.paidAt) }}</text>
        </view>
      </view>

      <!-- 动作 -->
      <view class="acts">
        <template v-if="abnormal">
          <button class="btn-primary" hover-class="btn-primary--hover" @tap="goHome">
            看看今日套餐 ›
          </button>
          <button class="btn-secondary" hover-class="btn-secondary--hover" @tap="goList">
            查看我的全部订单
          </button>
        </template>
        <template v-else>
          <button
            v-if="cancellable"
            class="btn-warning"
            hover-class="btn-warning--hover"
            @tap="goCancel"
          >
            取消订单（截单前可自助）
          </button>
          <button class="btn-secondary" hover-class="btn-secondary--hover" @tap="goHome">
            返回首页
          </button>
        </template>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P5 · 订单详情（状态机时间线）
 *
 * ⭐ 版式基准 = prototype/index.html renderP5（v4.10.0）
 *
 * 验收要点（M1 标准 2 / 3）：
 *   · 状态文案**由服务端下发**（`statusText`，三视角映射唯一来源，端上不自造）
 *   · 截单前可自助取消；截单后引导联系团长（服务端 `40004` + `leaderContact`）
 *
 * ⚠️ 团长手机号在出参里**已脱敏**（§1.6），故「联系团长」**不做 `makePhoneCall`**
 *    （拨一个 `138****0001` 只会失败），改为提示走楼栋微信群 / 平台客服 ——
 *    这比渲染一个点了没反应的按钮诚实。
 */
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { OrderStatus } from '@abox/shared-types';
import type { OrderDetailResult, OrderTimelineNode } from '@abox/shared-types';

import { fetchOrderDetail } from '@/api/order';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { SLOT_LABEL, fenToYuanText, formatDateTime, formatMealDate } from '@/utils/format';
import { buildUrl, navigateTo, pageQuery, switchTab } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const { run, loading } = useRequest();

const detail = ref<OrderDetailResult | null>(null);
const errorHint = ref('请返回订单列表重试');
const orderNo = ref('');

/** 可自助取消：待支付 / 已支付（截单后由服务端拒绝并给 40004 + 团长联系方式） */
const cancellable = computed(() => {
  const s = detail.value?.status;
  return s === OrderStatus.PENDING_PAY || s === OrderStatus.PAID;
});

/**
 * 异常态 = 取消 / 退款族（原型用灰渐变卡片表示「这单不再往前走」）
 *
 * ⚠️ 用**状态机常量**判断而不是字符串字面量：新增状态时这里会跟着走类型检查。
 */
const abnormal = computed(() => {
  const s = detail.value?.status;
  return (
    s === OrderStatus.CANCELLED ||
    s === OrderStatus.REFUND_APPLYING ||
    s === OrderStatus.REFUNDING ||
    s === OrderStatus.REFUNDED
  );
});

const doneCount = computed(() => detail.value?.timeline.filter((n) => n.done).length ?? 0);

/**
 * 时间线节点三态 —— 规格 §八「时间线 · 节点 15px 圆形」+ 清单 §七「已过 / 当前 / 未到」。
 *
 * ⚠️ 端上只实现**有数据支撑**的三态：契约 `OrderTimelineNode` 只有 `done: boolean`，
 *    **没有「异常」字段**；而规格 §八 承诺了「异常实心叉」。
 *    这是**规格与契约的口径不一致**（已登记），端上不凭空造数据
 *    ⇒ 异常态留待契约补字段后再实现。
 *
 * 「当前」的判据 = 第一个未完成节点（与 `doneCount` 同位，不另立第二份真源）。
 */
function dotState(node: OrderTimelineNode, i: number): 'done' | 'doing' | 'todo' {
  if (node.done) return 'done';
  return i === doneCount.value ? 'doing' : 'todo';
}

const leaderName = computed(
  () => detail.value?.pickup.leaderName || detail.value?.leaderContact?.name || '本楼团长',
);

/**
 * 送达时刻（`HH:mm`）—— **来自响应**，不在端上写死（PR-02 收口）
 *
 * 真源是服务端 `currentTimeline().arrival`（后台 `set_meal.delivery_arrival_time` 可改）。
 * 端上拿不到真源 ⇒ 只能由 `pickup.expectAt` 下发。原先这里与取餐卡各写死一个 `11:30`，
 * 改一次配置就会出现「取餐卡说 12:00、状态提示还说 11:30」。
 */
const arriveAt = computed(() => detail.value?.pickup?.expectAt ?? '');

const statusHint = computed(() => {
  switch (detail.value?.status) {
    case OrderStatus.PENDING_PAY:
      return '30 分钟内完成支付，超时订单自动取消';
    case OrderStatus.PAID:
      return '已锁定你的那份饭，截单前可自助取消';
    case OrderStatus.CUT_OFF:
    case OrderStatus.COOKED:
      return '已截单，如需退款请联系团长协助';
    case OrderStatus.DELIVERING:
      // ⚠️ 曾写死 `'配送途中，11:30 送达办公楼'`（PR-02 收口）—— 同上，改用响应值
      return arriveAt.value ? `配送途中，${arriveAt.value} 送达办公楼` : '配送途中，即将送达办公楼';
    case OrderStatus.DELIVERED:
      return '已送达取餐点，请凭订单号取餐';
    case OrderStatus.COMPLETED:
      return '订单已完成，感谢支持';
    case OrderStatus.CANCELLED:
      return '订单已取消，款项已按原路退回';
    case OrderStatus.REFUND_APPLYING:
    case OrderStatus.REFUNDING:
      return '退款处理中，请留意到账';
    case OrderStatus.REFUNDED:
      return '退款已到账';
    default:
      return '';
  }
});

async function load(): Promise<void> {
  if (!orderNo.value) return;
  try {
    detail.value = await run(() => fetchOrderDetail(orderNo.value));
  } catch (e) {
    if (detail.value === null && e instanceof ApiError) errorHint.value = e.message;
    toastApiError(e);
  }
}

function copyOrderNo(): void {
  const no = detail.value?.orderNo;
  if (!no) return;
  uni.setClipboardData({
    data: no,
    success: () => uni.showToast({ title: '订单号已复制', icon: 'none' }),
  });
}

/** ⚠️ 手机号已脱敏 → 不拨号，引导走微信群（原型示例里的「已拨打」在本期做不到） */
function contactLeader(): void {
  uni.showToast({
    title: `请在楼栋微信群 @${leaderName.value}，或联系平台客服`,
    icon: 'none',
    duration: 2600,
  });
}

function goSupport(): void {
  navigateTo('/pages/support/contact');
}

function goCancel(): void {
  navigateTo(buildUrl('/pages/order-cancel/order-cancel', { orderNo: orderNo.value }));
}

function goList(): void {
  switchTab('/pages/order-list/order-list');
}

function goHome(): void {
  switchTab('/pages/index/index');
}

onLoad((options) => {
  orderNo.value = pageQuery(options as Record<string, unknown>, 'orderNo');
  void load();
});

// 从取消页返回时需要刷新状态
onShow(() => {
  if (detail.value) void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-3 $space-4 $space-5;
  box-sizing: border-box;
}

// ---- 状态渐变卡 ----
.status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-4;
  background: linear-gradient(135deg, $c-gold, $c-gold-deep);
  border-radius: 28rpx;
  color: #ffffff;
  box-shadow: 0 8rpx 24rpx rgba(184, 137, 47, 0.22);

  &--muted {
    background: linear-gradient(135deg, $c-text-disabled, $c-text-weak);
    box-shadow: none;
  }

  &__left {
    display: flex;
    flex-direction: column;
  }

  &__label {
    font-size: $fs-caption;
    opacity: 0.9;
  }

  &__text {
    margin-top: $space-1;
    font-size: $fs-h1;
    font-weight: bold;
  }

  &__icon {
    line-height: 1;
  }

  &__hint {
    display: block;
    margin: $space-2 $space-1 0;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

// ---- 卡片 ----
.card {
  margin-top: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: 0 2rpx 8rpx rgba(110, 84, 53, 0.06);

  &--row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-2;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__sub {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 时间线 ----
.timeline {
  padding-top: $space-1;
}

.tl {
  display: flex;
  min-height: 76rpx;

  &__rail {
    position: relative;
    flex: none;
    width: 44rpx;
  }

  // 节点 15px 圆形（规格 §八）。三态：已完成实心勾 / 当前空心 / 未到弱化点。
  &__dot {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    // 15px 圆形（30rpx）· 守规格 §八原值。勾走**装饰档** `abi-deco-28`（14px）——
    // 与 `avatar__icon` / `level__icon` / `grid__icon` 同族约定：**圆/徽标容器内的字形走装饰档**。
    // （早先按功能档 16px(32rpx) 会撑破 30rpx 圆点；走装饰档后圆点无需变形。）
    width: 30rpx;
    height: 30rpx;
    margin-top: 4rpx;
    border-radius: 50%;
    // 「未到」= 弱化装饰态：信息由文字承担 ⇒ WCAG 1.4.11 装饰豁免（见 s6-contrast.py）
    background: $c-mut-bd;

    // 已完成：实心 + 勾
    &.is-done {
      background: $c-gold-deep;
    }

    // 当前进行中：空心描边
    &.is-doing {
      background: transparent;
      border: 3rpx solid $c-gold-deep;
    }
  }

  &__dot-ico {
    font-family: $font-family-base;
    line-height: 1;
    color: $c-surface;
  }

  &__line {
    position: absolute;
    // top = 圆点高 30 + 上边距 4 + 间隙 4；left = 圆点中心 15 − 线宽 2/2
    top: 38rpx;
    bottom: 0;
    left: 14rpx;
    width: 2rpx;
    background: $c-mut-bd;

    // 已过段落的连线随之加深，与「已过」文字同层
    &.is-done {
      background: $c-gold-deep;
    }
  }

  &__body {
    flex: 1;
    padding-bottom: $space-3;
  }

  &__text {
    display: block;
    font-size: $fs-body;
    color: $c-text-weak;
  }

  &__at {
    display: block;
    margin-top: 2rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &.is-done .tl__text {
    font-weight: bold;
    color: $c-text;
  }

  // 「当前」节点文字同样用主文字色（节点色与文字色分离：节点归节点，文字归文字）
  &.is-doing .tl__text {
    color: $c-text;
  }

  &.is-last .tl__body {
    padding-bottom: 0;
  }

  &__empty {
    padding: $space-3 0;
    text-align: center;
  }

  &__empty-text {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 订单号 ----
.ono {
  display: flex;
  flex-direction: column;

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    margin-top: 2rpx;
    font-family: monospace;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }
}

.mini-btn {
  flex: none;
  height: 56rpx;
  padding: 0 $space-3;
  line-height: 56rpx;
  color: $c-text;
  font-size: $fs-caption;
  background: $c-surface-3;
  border: 1px solid $c-border;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.85;
  }
}

// ---- 套餐明细 ----
.dish {
  display: flex;
  align-items: baseline;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

  &__slot {
    flex: none;
    width: 72rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__name {
    flex: 1;
    font-size: $fs-body;
    color: $c-text;
  }

  &__from {
    flex: none;
    margin-left: $space-2;
    font-size: $fs-caption;
    color: $c-gold-fg;
  }
}

// ---- 金额 ----
.sum {
  margin-top: $space-3;

  &__row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: $space-1 0;

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
    font-size: $fs-caption;
    color: $c-text;
  }

  &__total {
    font-size: 40rpx;
    font-weight: bold;
    color: $c-gold-fg;
  }
}

.remark {
  margin-top: $space-3;
  padding: $space-2 $space-3;
  background: $c-surface-3;
  border-radius: $radius-sm;

  &__text {
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

// ---- 取餐方式 ----
.pickup {
  &__who {
    display: block;
    margin-top: $space-2;
    font-size: $fs-body;
    color: $c-text;
  }

  &__strong {
    font-weight: bold;
  }

  &__when {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__acts {
    display: flex;
    gap: $space-3;
    margin-top: $space-3;
  }
}

.ghost-btn {
  flex: 1;
  height: 68rpx;
  line-height: 68rpx;
  color: $c-text;
  font-size: $fs-caption;
  background: $c-surface-3;
  border: 1px solid $c-border;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.85;
  }
}

// ---- 键值行 ----
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

// ---- 动作 ----
// ⚠️ 三个按钮**刻意直写**而不抽 `%placeholder` + `@extend`：
//    uni-app 的 scoped SCSS 在 `@extend` 跨样式块时行为随版本变化，
//    一旦解析失败，报错位置会指到 vue-loader 而不是这一行（排障成本远高于重复三行）。
.acts {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  margin-top: $space-5;
}

.btn-primary {
  height: 88rpx;
  line-height: 88rpx;
  color: $c-bg;
  font-size: $fs-h2;
  font-weight: bold;
  letter-spacing: 2rpx;
  background: linear-gradient(135deg, $c-text 0%, $c-gold-deep 100%);
  border: none;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    filter: brightness(1.08);
  }
}

.btn-warning {
  height: 88rpx;
  line-height: 88rpx;
  color: #ffffff;
  font-size: $fs-h2;
  font-weight: bold;
  background: linear-gradient(135deg, $c-warning, $c-warn-fg);
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
  height: 88rpx;
  line-height: 88rpx;
  color: $c-text;
  font-size: $fs-body;
  background: transparent;
  border: 1px solid $c-border;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.85;
  }
}
</style>
