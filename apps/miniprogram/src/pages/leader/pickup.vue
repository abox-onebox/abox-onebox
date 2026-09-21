<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP15（v4.10.0）：
         配送状态大卡（绿渐变）→ 总份数四指标 → 分发重点提醒 → 成员列表 → 一键分发主按钮 -->

    <ab-loading v-if="loading && !today" text="正在加载取餐信息" />

    <ab-empty-state
      v-else-if="!today"
      text="取餐信息加载失败"
      hint="请稍后重试"
      illustration="warn-tri"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <!-- ① 配送状态大卡 -->
      <view class="hero" :class="`hero--${deliveryTone}`">
        <text class="hero__label">配送状态</text>
        <text class="hero__status">{{ today.delivery?.statusText ?? '待叫车' }}</text>
        <text class="hero__where">{{ heroWhere }}</text>
        <text class="hero__foot"
          ><text class="abi abi-16">{{ I.info }}</text>
          送达提醒通过团长群通知；取餐后请及时分发</text
        >
      </view>

      <!-- ② 本办公楼总份数 -->
      <view class="card">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.package }}</text> 本办公楼总份数</text
        >

        <view class="stats">
          <view class="stats__item">
            <text class="stats__value">{{ today.totalQuantity }}</text>
            <text class="stats__label">有效份数</text>
          </view>
          <view class="stats__item">
            <text class="stats__value stats__value--ok">{{ today.confirmedQuantity }}</text>
            <text class="stats__label">已分发</text>
          </view>
          <view class="stats__item">
            <text class="stats__value stats__value--warn">{{ today.pendingQuantity }}</text>
            <text class="stats__label">待分发</text>
          </view>
          <view class="stats__item">
            <text class="stats__value stats__value--gold">{{
              fenToYuanText(expectCommissionFen)
            }}</text>
            <text class="stats__label">预计佣金 {{ ratePercent }}%</text>
          </view>
        </view>

        <text class="card__foot">{{ statsFoot }}</text>
      </view>

      <!-- ③ 分发重点提醒（2 份以上） -->
      <view v-if="multiList.length" class="card card--alert">
        <view class="alert__hd">
          <text class="abi abi-24 alert__icon">{{ I['warn-tri'] }}</text>
          <view class="alert__body">
            <text class="alert__title">分发重点提醒</text>
            <text class="alert__sub">以下同事点了 2 份以上，分发时务必核对：</text>
          </view>
        </view>
        <view class="alert__pills">
          <text v-for="m in multiList" :key="m.name" class="alert__pill">
            {{ m.name }} × {{ m.quantity }}
          </text>
        </view>
      </view>

      <!-- 本次分发结果 -->
      <view v-if="done" class="card card--done">
        <text class="done__title"
          ><text class="abi abi-16">{{ I['ok-circle'] }}</text> 分发完成</text
        >
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
          佣金按「实发份数 × 单价 × {{ (done.rate * 100).toFixed(0) }}%」计佣，
          将于次日自动入账到余额（届时可在佣金中心查看）
        </text>
        <view class="done__acts">
          <text class="done__link" @tap="goCommission">看佣金 ›</text>
          <text class="done__link" @tap="goOrders">看订单 ›</text>
        </view>
      </view>

      <view v-else-if="repeatedTips" class="card">
        <text class="card__foot">{{ repeatedTips }}</text>
      </view>

      <!-- ④ 成员列表 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title"
            ><text class="abi abi-16">{{ I.users }}</text> 成员列表（{{
              today.members.length
            }}
            单）</text
          >
          <text v-if="pendingList.length" class="card__link" @tap="toggleAll">
            {{ allSelected ? '取消全选' : '全选' }}
          </text>
        </view>
        <text class="card__sub">退款订单系统自动跳过，无需分发</text>

        <ab-empty-state
          v-if="!today.members.length"
          text="本楼今日暂无订单"
          hint="T-1 截单后本楼有订单才会出现在这里"
          illustration="box"
        />

        <template v-else>
          <view
            v-for="m in today.members"
            :key="m.orderNo"
            class="member"
            :class="{ 'member--pending': isPending(m.orderNo) }"
            @tap="isPending(m.orderNo) && toggle(m.orderNo)"
          >
            <view
              v-if="isPending(m.orderNo)"
              class="member__check"
              :class="{ 'is-on': selected.includes(m.orderNo) }"
            />
            <view v-else class="member__check member__check--muted" />

            <view class="member__left">
              <text class="member__name">{{ displayOr(m.userName, '匿名用户') }}</text>
              <text class="member__sub">
                {{ m.quantity }} 份 · {{ displayOr(m.phoneMasked, '未留手机号') }}
              </text>
            </view>

            <view class="member__right">
              <text class="member__status" :class="statusTone(m.status)">{{ m.statusText }}</text>
            </view>
          </view>
        </template>
      </view>

      <!-- ⑤ 一键分发 -->
      <view v-if="!done" class="submit">
        <button
          class="submit__btn"
          :disabled="submitting || !selected.length"
          hover-class="submit__btn--hover"
          @tap="confirm"
        >
          <text v-if="submitting">分发中…</text>
          <text v-else
            ><text class="abi abi-20">{{ I.check }}</text> 一键分发并结算佣金（{{
              selectedQuantity
            }}
            份 · {{ fenToYuanText(selectedCommissionFen) }}）</text
          >
        </button>
        <text class="submit__hint">
          佣金按「实发份数」计佣、次日入账；重复提交不会重复计佣（幂等）
        </text>
        <text class="submit__hint">
          <text class="abi abi-16">{{ I.clock }}</text> 超时未操作 →
          由系统自动确认（口径同上，仍按实发份数计佣）
        </text>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P15 · 取餐确认（一键分发并结算佣金）
 *
 * ⭐ 版式基准 = prototype/index.html renderP15（v4.10.0）
 *
 * 数据来源：
 *   · L8 `GET /leader/pickup/today`  —— 份数盘口 + 配送状态 + 成员列表（主数据）
 *   · L9 `POST /leader/pickup/confirm` —— 一键分发（**幂等**）
 *   · L1 `GET /leader/workbench`     —— 今日单价与费率（用于「预计佣金」，L8 无金额字段）
 *
 * ⚠️ **计佣基数 = 实发份数**（M2 最高风险口径）：只有 `delivered` / `delivering` 的订单被
 *    确认后才计佣，基数取订单**份数**并剔除已退款 —— 故按钮文案刻意显示「N 份」而非「N 单」。
 * ⚠️ 「预计佣金」是**端上派生值**（`有效份数 × 单价 × 费率`），与 L9 返回的
 *    `commissionFen`（**实算值**）不是一回事；分发完成后一律以 L9 返回为准，
 *    故二者在页面上分处两处、措辞不同（「预计」vs「本次计佣」）。
 * ⚠️ 幂等键策略：**一次「提交意图」一个 key**。失败后重试沿用同一 key（服务端失败即释放键），
 *    成功后立即作废 —— 否则下一批分发会命中 10006 回放上一批结果。
 * ⚠️ 原型写「14:00 后未操作将自动按全部已分发处理」：具体时刻属**可配节奏**，
 *    端上不复制该数字（见 `order-timeline.ts`），只说「超时由系统自动确认」。
 * ⚠️ 原型该页「仅状态显示、无勾选」，实装**保留勾选**并默认全选 ——
 *    默认行为等于「一键全部分发」，同时保留个别漏发/补发的细粒度控制。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchWorkbench } from '@/api/leader';
import { confirmPickup, fetchPickupToday } from '@/api/leader-order';
import type { PickupConfirmDone, PickupTodayData } from '@/api/leader-order';
import { apiErrorMessage, useRequest } from '@/composables/use-request';
import { displayOr, fenToYuanText, formatDateTime, uuid } from '@/utils/format';
import { navigateTo } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const { run, loading } = useRequest();

const today = ref<PickupTodayData | null>(null);
/** 今日单价（分）与费率 —— 取自 L1，用于端上派生「预计佣金」 */
const unitPriceFen = ref(0);
const rate = ref(0);

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

const ratePercent = computed(() => (rate.value ? (rate.value * 100).toFixed(0) : '--'));

/** 预计佣金（端上派生）= 有效份数 × 单价 × 费率 */
const expectCommissionFen = computed(() =>
  Math.round((today.value?.totalQuantity ?? 0) * unitPriceFen.value * rate.value),
);

/** 本次勾选对应的预计佣金 */
const selectedCommissionFen = computed(() =>
  Math.round(selectedQuantity.value * unitPriceFen.value * rate.value),
);

/** 2 份以上（分发重点提醒） */
const multiList = computed(() =>
  (today.value?.members ?? [])
    .filter((m) => m.quantity >= 2)
    .map((m) => ({ name: displayOr(m.userName, '匿名用户'), quantity: m.quantity })),
);

/** 配送状态色调：已送达 → 成功绿；配送中 → 金棕；未发车 → 暖棕 */
const deliveryTone = computed(() => {
  const s = today.value?.delivery?.status;
  if (s === 'arrived') return 'done';
  if (s === 'en_route' || s === 'called') return 'moving';
  return 'idle';
});

const heroWhere = computed(() => {
  const d = today.value?.delivery;
  if (!d) return '尚未生成配送单';
  const at = d.actualAt ? formatDateTime(d.actualAt) : formatDateTime(d.expectedAt);
  return `${at}${d.driverName ? ` · ${d.driverName}` : ''}`;
});

const statsFoot = computed(() => {
  const t = today.value;
  if (!t) return '';
  if (t.pendingQuantity === 0 && t.confirmedQuantity > 0) return '（今日已全部分发完毕）';
  return '（退款订单已从份数中剔除，不参与分发与计佣）';
});

function isPending(orderNo: string): boolean {
  return pendingList.value.some((m) => m.orderNo === orderNo);
}

function statusTone(status: unknown): string {
  const s = String(status);
  if (s === 'completed') return 'is-done';
  if (s === 'delivered' || s === 'delivering') return 'is-pending';
  return '';
}

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
    return;
  }

  // 单价与费率：best-effort（失败只影响「预计佣金」这一格）
  try {
    const w = await fetchWorkbench();
    rate.value = w.today.rate;
    unitPriceFen.value = w.today.quantity > 0 ? w.today.amountFen / w.today.quantity : 0;
  } catch {
    // 保留 0：预计佣金显示 ¥0.00 而非编造
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
  padding: $space-4 $space-4 260rpx;
  box-sizing: border-box;
}

// ---- ① 配送状态大卡 ----
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40rpx $space-4;
  border-radius: 36rpx;
  color: #ffffff;
  text-align: center;
  box-shadow: 0 10rpx 26rpx rgba(110, 84, 53, 0.18);

  &--done {
    background: linear-gradient(135deg, $c-success, $c-ok-fg);
  }

  &--moving {
    background: linear-gradient(135deg, $c-gold, $c-gold-deep);
  }

  &--idle {
    background: linear-gradient(135deg, $c-text-weak, $c-text);
  }

  &__label {
    font-size: $fs-caption;
    opacity: 0.9;
  }

  &__status {
    margin: $space-2 0;
    font-size: 46rpx;
    font-weight: bold;
  }

  &__where {
    font-size: $fs-caption;
    opacity: 0.9;
  }

  &__foot {
    width: 100%;
    margin-top: $space-3;
    padding-top: $space-3;
    border-top: 1px solid rgba(255, 255, 255, 0.24);
    font-size: 22rpx;
    line-height: 1.6;
    opacity: 0.88;
  }
}

// ---- 通用卡片 ----
.card {
  margin-top: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &--done {
    border-color: $c-gold;
  }

  &--alert {
    background: rgba(196, 69, 54, 0.05);
    border-color: rgba(196, 69, 54, 0.3);
  }

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-1;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__sub {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__link {
    font-size: $fs-caption;
    color: $c-gold-fg;
  }

  &__foot {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
    text-align: center;
  }
}

// ---- ② 四指标 ----
.stats {
  display: flex;
  align-items: flex-end;
  padding: $space-3 0 0;

  &__item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  &__value {
    font-size: 38rpx;
    font-weight: bold;
    color: $c-text;
    font-variant-numeric: tabular-nums;

    &--ok {
      color: $c-ok-fg;
    }

    &--warn {
      color: $c-warn-fg;
    }

    &--gold {
      color: $c-gold-fg;
    }
  }

  &__label {
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }
}

// ---- ③ 重点提醒 ----
.alert {
  &__hd {
    display: flex;
    align-items: center;
  }

  &__icon {
    flex: none;
  }

  &__body {
    flex: 1;
    min-width: 0;
    margin-left: $space-2;
  }

  &__title {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__sub {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__pills {
    display: flex;
    flex-wrap: wrap;
    margin-top: $space-3;
  }

  &__pill {
    margin: 0 $space-2 $space-2 0;
    padding: 6rpx $space-3;
    font-size: $fs-caption;
    color: $c-warn-fg;
    background: rgba(196, 69, 54, 0.15);
    border-radius: $radius-pill;
  }
}

// ---- 分发结果 ----
.done {
  &__title {
    display: block;
    margin-bottom: $space-3;
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-ok-fg;
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
    margin-top: $space-3;
  }

  &__link {
    margin-right: $space-4;
    font-size: $fs-caption;
    color: $c-gold-fg;
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
      font-weight: bold;
      color: $c-gold-fg;
    }
  }
}

// ---- ④ 成员列表 ----
.member {
  display: flex;
  align-items: center;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

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

    &--muted {
      opacity: 0.3;
    }
  }

  &__left {
    flex: 1;
    min-width: 0;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__sub {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__right {
    flex: none;
    margin-left: $space-3;
  }

  &__status {
    font-size: $fs-caption;
    color: $c-text-weak;

    &.is-done {
      color: $c-ok-fg;
    }

    &.is-pending {
      color: $c-gold-fg;
    }
  }
}

// ---- ⑤ 提交 ----
.submit {
  margin-top: $space-4;

  &__btn {
    height: 96rpx;
    font-size: 32rpx;
    font-weight: bold;
    line-height: 96rpx;
    color: #ffffff;
    background: linear-gradient(135deg, $c-success, $c-ok-fg);
    border: none;
    border-radius: $radius-pill;

    &::after {
      border: none;
    }

    &--hover {
      opacity: 0.88;
    }

    &[disabled] {
      opacity: 0.4;
    }
  }

  &__hint {
    display: block;
    margin-top: $space-2;
    font-size: 22rpx;
    line-height: 1.7;
    color: $c-text-weak;
    text-align: center;
  }
}
</style>
