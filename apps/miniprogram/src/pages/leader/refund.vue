<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP14（v4.10.0）：
         顶部横幅 → 处理原则（三段式）→ 段一「已系统处理」→ 段二「退款 / 代退」→ 发起代退 -->

    <!-- ============ 无 orderNo：异常订单总览 + 可代退订单 ============ -->
    <template v-if="!orderNo">
      <!-- ① 顶部横幅 -->
      <view class="banner" :class="allSettled ? 'banner--ok' : 'banner--warn'">
        <text class="banner__text">
          <text class="abi abi-16">{{ I[abnormalTotal > 0 ? 'warn-tri' : 'ok-circle'] }}</text>
          今日异常与退款订单共 {{ abnormalTotal }} 单
          {{ allSettled ? '· 均已处理' : '· 有处理中的单' }}
        </text>
      </view>

      <!-- ② 处理原则 -->
      <view class="card card--principle">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.checklist }}</text> 处理原则（三段式流程）</text
        >
        <text class="rule">
          ① <text class="rule__strong">截单前</text>：用户主动取消 → 系统自动退，团长无需操作
        </text>
        <text class="rule">
          ② <text class="rule__strong">截单后</text>：用户不能自助退款，需私下微信联系团长
        </text>
        <text class="rule">
          ③ 团长在<text class="rule__strong">订单明细</text>点击该成员 → 只可「发起代退申请」，
          不能直接退款
        </text>
        <text class="rule"> ④ 平台运营审批通过后，系统才实际原路退回，团长佣金同步回退 </text>
      </view>

      <ab-loading v-if="loading && !list.length" text="正在加载今日订单" />

      <template v-else>
        <!-- ③ 段一：已系统处理 -->
        <view class="card">
          <text class="card__title card__title--ok">
            <text class="abi abi-16">{{ I['ok-circle'] }}</text> 段一：已系统处理（{{
              autoHandled.length
            }}
            单 · 截单前取消 / 未支付取消）
          </text>
          <text class="card__sub">系统自动退款或自动取消，团长无需操作。</text>

          <view v-if="!autoHandled.length" class="empty">
            <text class="empty__text">今日没有系统自动处理的订单</text>
          </view>

          <view v-for="o in autoHandled" :key="o.orderNo" class="row">
            <view class="row__left">
              <text class="row__name">{{ displayOr(o.userName, '匿名用户') }}</text>
              <text class="row__meta">{{ o.statusText }} · {{ formatTime(o.createdAt) }}</text>
            </view>
            <text class="row__tail row__tail--ok">已取消</text>
          </view>
        </view>

        <!-- ④ 段二：退款 / 代退 -->
        <view class="card card--gold">
          <text class="card__title card__title--gold">
            <text class="abi abi-16">{{ I.crown }}</text> 段二：退款与代退（{{
              refundHandled.length
            }}
            单）
          </text>
          <text class="card__sub">
            截单后用户微信联系团长 → 团长在订单明细「发起代退申请」→ 运营审批通过后原路退回。
          </text>

          <view v-if="!refundHandled.length" class="empty">
            <text class="empty__text">今日没有退款 / 代退订单</text>
          </view>

          <view v-for="o in refundHandled" :key="o.orderNo" class="row">
            <view class="row__left">
              <text class="row__name">{{ displayOr(o.userName, '匿名用户') }}</text>
              <text class="row__meta">{{ o.statusText }} · {{ formatTime(o.createdAt) }}</text>
            </view>
            <text
              class="row__tail"
              :class="isRefunded(o.status) ? 'row__tail--ok' : 'row__tail--warn'"
            >
              {{ isRefunded(o.status) ? '已退款' : '处理中' }}
            </text>
          </view>
        </view>

        <!-- ⑤ 可发起代退 -->
        <view class="card">
          <view class="card__hd">
            <text class="card__title"
              ><text class="abi abi-16">{{ I.refund }}</text> 可发起代退的订单（{{
                candidates.length
              }}）</text
            >
          </view>
          <text class="card__sub">仅已支付且未终结的订单可发起；提交后只登记申请，资金不动。</text>

          <view v-if="!candidates.length" class="empty">
            <text class="empty__text">本日暂无可代退订单</text>
          </view>

          <view
            v-for="item in candidates"
            :key="item.orderNo"
            class="cand"
            hover-class="cand--hover"
            @tap="pick(item.orderNo)"
          >
            <view class="cand__left">
              <text class="cand__user">{{ displayOr(item.userName, '匿名用户') }}</text>
              <text class="cand__no">{{ item.orderNo }}</text>
            </view>
            <view class="cand__right">
              <text class="cand__amount">{{ fenToYuanText(item.payAmountFen) }}</text>
              <text class="cand__status">{{ item.statusText }}</text>
            </view>
          </view>
        </view>
      </template>

      <text class="foot">
        <text class="abi abi-16">{{ I['warn-tri'] }}</text>
        原型此页为「本月历史总览（跨日聚合）」，实装为<text class="foot__strong">当日口径</text>：
        契约里没有跨日异常汇总端点（L4 只接受单个出餐日），故不做跨月统计 ——
        跨日历史需后端补读侧端点，已登记缺陷，不在排版批顺手新造端点。
      </text>
    </template>

    <!-- ============ 有 orderNo：代退表单 / 结果 ============ -->
    <template v-else>
      <view class="card">
        <view class="kv">
          <text class="kv__k">订单号</text>
          <text class="kv__v">{{ orderNo }}</text>
        </view>
        <view v-if="target" class="kv">
          <text class="kv__k">用户</text>
          <text class="kv__v">{{ displayOr(target.userName, '匿名用户') }}</text>
        </view>
        <view v-if="target" class="kv">
          <text class="kv__k">申请退款额</text>
          <text class="kv__v kv__v--strong">{{ fenToYuanText(target.payAmountFen) }}</text>
        </view>
      </view>

      <!-- 提交结果 -->
      <view v-if="result" class="card card--done">
        <text class="done__title"
          ><text class="abi abi-16">{{ I['ok-circle'] }}</text> 代退申请已提交</text
        >
        <view class="kv">
          <text class="kv__k">退款单号</text>
          <text class="kv__v">{{ result.refundNo }}</text>
        </view>
        <view class="kv">
          <text class="kv__k">退款金额</text>
          <text class="kv__v">{{ fenToYuanText(result.amountFen) }}</text>
        </view>
        <view class="kv">
          <text class="kv__k">当前状态</text>
          <text class="kv__v">{{ result.statusText }}</text>
        </view>
        <text class="done__tips">{{ result.tips }}</text>
        <text class="done__safe">本次仅登记申请，账户资金未发生任何变动</text>
      </view>

      <!-- 表单 -->
      <template v-else>
        <view class="card">
          <text class="card__title">退款原因</text>
          <view class="reasons">
            <view
              v-for="r in reasons"
              :key="r.value"
              class="reasons__item"
              :class="{ 'is-active': reasonType === r.value }"
              @tap="reasonType = r.value"
            >
              <text class="reasons__label">{{ r.label }}</text>
            </view>
          </view>
        </view>

        <view class="card">
          <text class="card__title">情况说明</text>
          <textarea
            v-model="reason"
            class="area"
            maxlength="200"
            placeholder="请填写与用户沟通的结果（≤200 字）"
            placeholder-class="area__ph"
          />
        </view>

        <view class="card">
          <text class="card__title">补充备注（选填）</text>
          <textarea
            v-model="remark"
            class="area"
            maxlength="200"
            placeholder="内部备注，用户不可见"
            placeholder-class="area__ph"
          />
        </view>

        <button
          class="btn btn--primary"
          :disabled="submitting"
          hover-class="btn--hover"
          @tap="submit"
        >
          {{ submitting ? '提交中…' : '发起代退申请' }}
        </button>

        <text class="foot">
          <text class="abi abi-16">{{ I['warn-tri'] }}</text> C6
          三段式：本步只登记申请（资金零变动）→ 运营后台审批 → 实际退款并回退佣金。
        </text>
      </template>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P14 · 异常订单总览 / 代退申请（C6 第一段）
 *
 * ⭐ 版式基准 = prototype/index.html renderP14（v4.10.0）
 *
 * 两态：
 *   · 无 `orderNo`（从 P13 异常入口进入）→ 总览（段一 / 段二）+ 可代退订单候选
 *   · 有 `orderNo`（从 P13 订单行进入）→ 代退表单 → 提交 L7
 *
 * ⚠️ **与原型的一处刻意不同（如实降级）**：原型 P14 是「本月异常订单总览」
 *    （跨日聚合，段一 5 单 + 段二 3 单）。实装**只有当日口径** ——
 *    契约 §4.2 没有跨日异常汇总端点（L4 只接受单个 `mealDate`），
 *    若端上循环 30 天拉取会打出几十次请求且口径仍是拼的。
 *    故本页只统计当日，并在页脚说明；跨日历史待后端补读侧端点。
 * ⚠️ 段一 = `cancelled`（系统自动取消/退款）；段二 = `refund_applying` / `refunding` /
 *    `refunded`（退款链路，含团长代退）。**不按「谁发起」再细分** ——
 *    `ab_refund` 没有可靠的「发起方」字段，硬分会把系统退单说成团长退的。
 * ⚠️ 手机号纪律：本页不展示手机号（列表已脱敏，联系用户须走微信群）。
 * ⚠️ C6 三段式：① 团长申请（**本页，只登记 `ab_refund.status='applying'`，资金零变动**）
 *    → ② 运营后台审批 → ③ 实际退款 + 反向结算。本页**不会**让钱动。
 * ⚠️ 关键错误码：`30010` 订单不存在 / `10003` 跨楼越权 / `40008` 已有未终结申请
 *    / `30003` 当前状态不允许代退。
 */
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { REFUND_REASON_LABEL, RefundReasonType } from '@abox/shared-types';

import { applyRefundByLeader, fetchLeaderOrders } from '@/api/leader-order';
import type { LeaderOrderItem, LeaderRefundApplyData } from '@/api/leader-order';
import { apiErrorMessage, useRequest } from '@/composables/use-request';
import { displayOr, fenToYuanText, formatTime } from '@/utils/format';
import { pageQuery } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

/** 可发起代退的原因（与 shared-types 同一来源，端上不自造文案） */
const reasons = Object.values(RefundReasonType).map((v) => ({
  value: v,
  label: REFUND_REASON_LABEL[v],
}));

const { run, loading } = useRequest();

const orderNo = ref('');
const reasonType = ref<string>(RefundReasonType.QUALITY);
const reason = ref('');
const remark = ref('');
const submitting = ref(false);
const result = ref<LeaderRefundApplyData | null>(null);

const list = ref<LeaderOrderItem[]>([]);

/** 可代退的订单：已支付且未终结（排除待支付 / 已完成 / 取消 / 已退款） */
const candidates = computed(() =>
  list.value.filter((o) =>
    [
      'paid',
      'cut_off',
      'cooked',
      'delivering',
      'delivered',
      'refund_applying',
      'refunding',
    ].includes(String(o.status)),
  ),
);

/** 段一：系统自动处理（取消） */
const autoHandled = computed(() => list.value.filter((o) => String(o.status) === 'cancelled'));

/** 段二：退款链路（含代退） */
const refundHandled = computed(() =>
  list.value.filter((o) => ['refund_applying', 'refunding', 'refunded'].includes(String(o.status))),
);

const abnormalTotal = computed(() => autoHandled.value.length + refundHandled.value.length);

/** 段二全部已终结（refunded）→ 顶栏显示「均已处理」 */
const allSettled = computed(
  () => refundHandled.value.length > 0 && refundHandled.value.every((o) => isRefunded(o.status)),
);

function isRefunded(status: unknown): boolean {
  return String(status) === 'refunded';
}

/** 表单页要展示的订单（从列表里找；找不到则只显示订单号） */
const target = computed(() => list.value.find((o) => o.orderNo === orderNo.value) ?? null);

async function loadList(): Promise<void> {
  try {
    const res = await run(() => fetchLeaderOrders({ pageSize: 100 }));
    list.value = res.list;
  } catch {
    list.value = [];
  }
}

function pick(no: string): void {
  orderNo.value = no;
  result.value = null;
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  if (!reason.value.trim()) {
    uni.showToast({ title: '请填写情况说明', icon: 'none' });
    return;
  }

  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: '确认提交代退申请',
      content: '提交后订单进入「退款申请中」，运营审批通过才实际退款。本步不动资金。',
      confirmText: '确认提交',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
  if (!confirmed) return;

  submitting.value = true;
  try {
    result.value = await run(() =>
      applyRefundByLeader(orderNo.value, {
        reasonType: reasonType.value as RefundReasonType,
        reason: reason.value.trim(),
        remark: remark.value.trim() || undefined,
      }),
    );
    uni.showToast({ title: '已提交申请', icon: 'none' });
  } catch (e) {
    uni.showToast({ title: apiErrorMessage(e, '提交失败'), icon: 'none', duration: 2400 });
  } finally {
    submitting.value = false;
  }
}

onLoad((options) => {
  orderNo.value = pageQuery(options, 'orderNo');
});

onShow(() => {
  void loadList();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: 0 $space-4 $space-5;
  box-sizing: border-box;
}

// ---- ① 顶部横幅 ----
.banner {
  margin: 0 (-$space-4) $space-3;
  padding: $space-3 $space-4;
  border-radius: 0 0 28rpx 28rpx;
  text-align: center;

  &--warn {
    color: #ffffff;
    background: $c-warning;
  }

  &--ok {
    color: #ffffff;
    background: $c-success;
  }

  &__text {
    font-size: $fs-caption;
    font-weight: bold;
  }
}

// ---- 通用卡片 ----
.card {
  margin-bottom: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &--principle {
    background: linear-gradient(135deg, $c-trace-card-from, $c-trace-card-to);
    border-color: $c-warning;
  }

  &--gold {
    border-color: $c-gold;
  }

  &--done {
    border-color: $c-gold;
  }

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__title {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;

    &--ok {
      color: $c-ok-fg;
    }

    &--gold {
      color: $c-gold-fg;
    }
  }

  &__hd &__title {
    margin-bottom: 0;
  }

  &__sub {
    display: block;
    margin-bottom: $space-2;
    font-size: 22rpx;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.rule {
  display: block;
  margin-bottom: 6rpx;
  font-size: 22rpx;
  line-height: 1.8;
  color: $c-text;

  &__strong {
    font-weight: bold;
  }
}

// ---- 行 ----
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

  &:last-of-type {
    border-bottom: none;
  }

  &__left {
    flex: 1;
    min-width: 0;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__meta {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__tail {
    flex: none;
    margin-left: $space-3;
    font-size: $fs-caption;
    color: $c-text-weak;

    &--ok {
      color: $c-ok-fg;
    }

    &--warn {
      color: $c-warn-fg;
    }
  }
}

.empty {
  padding: $space-4 0;
  text-align: center;

  &__text {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 候选 ----
.cand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

  &:last-of-type {
    border-bottom: none;
  }

  &--hover {
    opacity: 0.82;
  }

  &__left {
    flex: 1;
    min-width: 0;
  }

  &__user {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__no {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__right {
    flex: none;
    margin-left: $space-3;
    text-align: right;
  }

  &__amount {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__status {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }
}

// ---- 表单 ----
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

.reasons {
  display: flex;
  flex-wrap: wrap;

  &__item {
    margin: 0 $space-2 $space-2 0;
    padding: $space-2 $space-4;
    border: 1px solid $c-border;
    border-radius: $radius-pill;

    &.is-active {
      background: $c-text;
      border-color: $c-text;
    }
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__item.is-active &__label {
    color: $c-surface;
  }
}

.area {
  width: 100%;
  height: 160rpx;
  padding: $space-3;
  font-size: $fs-caption;
  line-height: 1.6;
  color: $c-text;
  background: $c-bg;
  border-radius: $radius-md;
  box-sizing: border-box;

  &__ph {
    color: $c-text-weak;
  }
}

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

  &__safe {
    display: block;
    margin-top: $space-2;
    font-size: 22rpx;
    color: $c-gold-fg;
  }
}

// ---- 按钮 ----
.btn {
  display: block;
  height: 88rpx;
  margin-top: $space-3;
  line-height: 88rpx;
  font-size: $fs-body;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.88;
  }

  &--primary {
    color: #ffffff;
    font-weight: bold;
    background: linear-gradient(135deg, $c-gold, $c-gold-deep);
    border: none;
  }

  &[disabled] {
    opacity: 0.45;
  }
}

.foot {
  display: block;
  margin-top: $space-3;
  padding: 0 $space-1;
  font-size: 22rpx;
  line-height: 1.7;
  color: $c-text-weak;

  &__strong {
    font-weight: bold;
    color: $c-text;
  }
}
</style>
