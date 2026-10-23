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
          <text class="card__title">明日组合（{{ quantity }} 份）</text>
          <view class="stepper">
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
        <view v-for="(d, i) in daily.items" :key="i" class="menu-row">
          <text class="menu-row__name">{{ d.name }}</text>
          <text class="menu-row__from">来自：{{ d.supplierName }}</text>
        </view>
        <view v-if="daily.rice" class="menu-row">
          <text class="menu-row__name">随附（米饭）</text>
          <text class="menu-row__from">来自：集散中心</text>
        </view>
        <view class="menu-total">
          <text class="menu-total__calc">{{ quantity }} 份 × ¥{{ unitPriceText }}</text>
          <!-- 券抵扣（只读）：自动选用「本单抵扣最多」的那张，不新增输入项
               —— 交付铁律：用户侧表单必要字段仅「份数」一项 -->
          <view v-if="bestCoupon" class="menu-total__cut">
            <text class="menu-total__cut-name">{{ bestCoupon.name }}</text>
            <text class="menu-total__cut-origin">¥{{ totalText }}</text>
            <text class="menu-total__cut-amount">−¥{{ discountText }}</text>
          </view>
          <text class="menu-total__price">¥{{ payText }}</text>
        </view>
      </view>

      <!-- 已订过 → 必须说清「本单是新增的一单」
           ⚠️ 不说的话，从首页「再来一单」进来的人会以为自己在改上一单的份数，
              付完款才发现是两张单。多单放开后这个误会是新出现的，故在这里堵。 -->
      <view v-if="daily.existingOrderNo" class="guide">
        <text class="guide__text">
          {{ orderedSummary }}，本单是新增的一单，单独支付，不会修改已有订单
        </text>
      </view>

      <!-- ⚠️ 用 `<block>` 而非 `<template>`：此处原本是 `v-else` 分支，放开多单后不再需要
           条件，但直接写成裸 `<template>` 会触发 `vue/no-lone-template`（门禁 max-warnings=0）。
           `<block>` 在 uni-app 各端编译为无节点，语义等价。 -->
      <block>
        <!-- 取餐信息（M5-17：把「这一单的团长是谁 / 佣金归谁」写清楚） -->
        <view class="card">
          <text class="card__title">
            <text class="abi abi-16">{{ I.pin }}</text> 取货信息（{{
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
          <text class="pickup-row__hint">明天 {{ daily.deliverAt }} 由团长统一取货并分发</text>
          <view class="pickup-row__tip">
            <text
              ><text class="abi abi-16">{{ I.info }}</text> 有问题？微信直接联系团长沟通</text
            >
          </view>
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
          <!-- ⭐ 提审自检清单 v1.2 第 4 条：对**用户权利的限制**必须「付款前」明示。
               事后写在取消页 / 订单详情 / 协议里都不算 —— 审核看的是「用户按下付款那一刻
               知不知道这单截单后不能自助退」。此前本页只有倒计时与「本场已截单」，
               付款前 0 处说明，判定不通过（2026-09-25 补）。 -->
          <text class="pickup-row__hint">
            <text class="abi abi-16">{{ I.info }}</text>
            {{ cutoffRefundHint }}
          </text>
        </view>

        <button
          class="btn-primary"
          :class="{ 'is-disabled': !canSubmit }"
          hover-class="btn-primary--hover"
          :disabled="!canSubmit"
          @tap="submit"
        >
          {{ submitting ? '提交中…' : daily.canOrder ? `确认支付 ¥${payText}` : '本场已截单' }}
        </button>
      </block>

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
 *   与原型的差异：备注输入**已移除**（交付铁律 · 用户侧下单字段仅「份数」一项，
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
import { computed, ref, watch } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { CreateOrderResult, HomeDailyResult } from '@abox/shared-types';

import { fetchAvailableCoupons } from '@/api/coupon';
import type { AvailableCouponItem } from '@/api/coupon';
import { fetchDaily } from '@/api/meal';
import { createOrder } from '@/api/order';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useCountdown } from '@/composables/use-countdown';
import { useWechatPay } from '@/composables/use-wechat-pay';
import { ORDER_MAX_QUANTITY } from '@/constants';
import { fenToYuan, formatTime, uuid } from '@/utils/format';
import { buildUrl, navigateBack, navigateTo, pageQuery, redirectTo } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const { run, loading } = useRequest();
const { remainSec, start } = useCountdown();
const { pay } = useWechatPay();

const daily = ref<HomeDailyResult | null>(null);
const quantity = ref(1);
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

/**
 * 代金券（2026-10-23）：**自动选用本单抵扣最多的那张**，不做「选券」控件
 *
 * ⚠️ 为什么不让用户自己选：
 *   ① 交付铁律 —— 用户侧表单必要字段**仅「份数」一项**，选券控件是第二个输入项，
 *      与「极简下单」直接冲突；
 *   ② 选券没有真实收益：自动取最大抵扣，用户手动选**不可能选出更优的结果**；
 *   ③ 「留着以后用」在一期不成立 —— 券按有效期排序消耗并不会更划算。
 *
 * ⚠️ 门槛判定**一律问服务端**（`/coupon/my-available?totalFen=`）：
 *    端上自己算门槛就是第二份判据，迟早漂移成「页面说能用、下单报门槛不足」。
 *    故改份数 → 重新问一次服务端（金额变了，可用性可能变）。
 *
 * ⚠️ 券是**辅助**：接口失败只记日志、不打断下单（无券时按原价继续）。
 */
const coupons = ref<AvailableCouponItem[]>([]);

const bestCoupon = computed<AvailableCouponItem | null>(() => {
  const ok = coupons.value.filter((c) => c.applicable && c.discountFen > 0);
  if (!ok.length) return null;
  return ok.reduce((a, b) => (b.discountFen > a.discountFen ? b : a));
});

const discountFen = computed(() => bestCoupon.value?.discountFen ?? 0);
const discountText = computed(() => fenToYuan(discountFen.value));
/** 应付 = 总额 − 券抵扣（与服务端 `payAmountFen` 同口径） */
const payFen = computed(() => Math.max(0, totalFen.value - discountFen.value));
const payText = computed(() => fenToYuan(payFen.value));

async function loadCoupons(): Promise<void> {
  if (!daily.value || totalFen.value <= 0) {
    coupons.value = [];
    return;
  }
  try {
    // ⚠️ 与其它调用点同口径：一律经 `useRequest.run()`（带登录态保障与统一错误形态），
    //    不裸调 api —— `mp:no-bare-call` 门禁就是守这条的。
    coupons.value = await run(() => fetchAvailableCoupons(totalFen.value));
  } catch (e) {
    // 券是辅助能力：拿不到就按无券继续，绝不阻断下单
    console.warn('[order-create] 可用券读取失败，按无券继续', e);
    coupons.value = [];
  }
}

watch(totalFen, () => {
  void loadCoupons();
});
/**
 * 能否提交（2026-10-03 变更）
 *
 * ⚠️ 原判据含 `!existingOrderNo`：一人一日一单时用来堵重复提交。放开多单后它会导致
 *    「已订一单的人永远付不了第二单」，故移除 —— 重复提交改由 `Idempotency-Key`
 *    拦（同一键回放 → 10006），换键下单是用户的新意图。
 */
const canSubmit = computed(() => !!daily.value?.canOrder && !submitting.value);

/**
 * 已订概览文案（与首页 P1 同一口径）
 *
 * ⚠️ 后端未下发聚合字段时（如线上仍是旧版 API）退化成只报单数 —— 直接插值
 *    `existingQuantity` 会渲染出「已订 份」这种空档。
 */
/**
 * 「截单后不能自助退」的说明 —— **时刻从响应取**，端上不写死
 *
 * ⭐ 2026-10-07 整体复查⑰：此句原写死「截单后（T-1 24:00）」（与首页横幅同一族）。
 *    `cutoffAt` 由服务端按生效时间轴派生且**后台可改**，写死就是第二份时刻定义。
 *    ⚠️ 取不到时**退化成不含时刻的表述**（「截单后…」），而不是回落写死的 24:00 ——
 *       回落值等于把同一个缺陷换个位置留下。
 */
const cutoffRefundHint = computed(() => {
  const t = formatTime(daily.value?.cutoffAt);
  const when = t && t !== '--' ? `截单后（T-1 ${t}）` : '截单后';
  return `${when}订单进入备货流程，不支持自助退款，需由团长发起代退申请，平台审批后原路退回。`;
});

const orderedSummary = computed(() => {
  const n = daily.value?.existingOrderCount ?? 0;
  const q = daily.value?.existingQuantity ?? 0;
  if (q > 0) return `你今日已订 ${q} 份（${n} 单）`;
  return '你今日已订 1 单';
});

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
    await loadCoupons();
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
            // 自动选中的券（无券时不传，服务端按无券处理）
            couponCode: bestCoupon.value?.code || undefined,
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

  // ---- 券抵扣（只读行） ----
  &__cut {
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    margin-bottom: $space-1;
  }

  &__cut-name {
    margin-right: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  // 原价：划除（券抵扣后仍让用户看见「原本是多少」，避免以为涨价/算错）
  &__cut-origin {
    margin-right: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
    text-decoration: line-through;
  }

  &__cut-amount {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-ok-fg;
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
