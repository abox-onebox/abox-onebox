<template>
  <view class="page">
    <!-- 无 orderNo：选择要代退的订单 -->
    <template v-if="!orderNo">
      <view class="notice">
        <text class="notice__title">截单后退款需团长代提</text>
        <text class="notice__text">
          用户无法自助退款（C6）。请从下方选择订单发起代退申请，运营审批通过后原路退回， 1–3
          个工作日到账。
        </text>
      </view>

      <ab-loading v-if="loading && !candidates.length" text="正在加载订单" />

      <ab-empty-state
        v-else-if="!candidates.length"
        text="本日暂无可代退订单"
        hint="仅已支付且未终结的订单可发起代退"
      />

      <template v-else>
        <text class="section">选择订单（{{ candidates.length }}）</text>
        <view v-for="item in candidates" :key="item.orderNo" class="cand" @tap="pick(item.orderNo)">
          <view class="cand__left">
            <text class="cand__user">{{ displayOr(item.userName, '匿名用户') }}</text>
            <text class="cand__no">{{ item.orderNo }}</text>
          </view>
          <view class="cand__right">
            <text class="cand__amount">{{ fenToYuanText(item.payAmountFen) }}</text>
            <text class="cand__status">{{ item.statusText }}</text>
          </view>
        </view>
      </template>
    </template>

    <!-- 有 orderNo：代退表单 / 结果 -->
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
        <text class="done__title">代退申请已提交</text>
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
            class="textarea"
            placeholder="请描述具体问题（如：菜品有异味，用户已拍照留证）"
            placeholder-class="textarea__ph"
            maxlength="200"
          />
          <input
            v-model="remark"
            class="input"
            type="text"
            placeholder="补充备注（选填，如联系方式 / 处理进展）"
            placeholder-class="textarea__ph"
            maxlength="200"
          />
        </view>

        <view class="submit">
          <button
            class="submit__btn"
            :disabled="submitting"
            hover-class="submit__btn--hover"
            @tap="submit"
          >
            {{ submitting ? '提交中…' : '提交代退申请' }}
          </button>
          <text class="submit__hint">
            提交后订单进入「退款申请中」，运营审批通过才实际退款；本步不动资金
          </text>
        </view>
      </template>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P14 · 退款 / 异常处理（代退申请 · C6）
 *
 * 两态：
 *   · 无 `orderNo`（从 P13 异常入口进入）→ 列出本日**已支付未终结**的订单供选择
 *   · 有 `orderNo`（从 P13 订单行进入）→ 代退表单 → 提交 L7
 *
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
import { displayOr, fenToYuanText } from '@/utils/format';
import { pageQuery } from '@/utils/router';

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
  orderNo.value = pageQuery(options as Record<string, unknown>, 'orderNo');
});

onShow(() => {
  void loadList();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

.notice {
  margin-bottom: $space-4;
  padding: $space-4;
  background: rgba(201, 168, 118, 0.12);
  border-radius: $radius-md;

  &__title {
    display: block;
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__text {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.section {
  display: block;
  padding: $space-2 0 $space-3;
  font-size: $fs-caption;
  color: $c-text-weak;
}

.cand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__left {
    flex: 1;
  }

  &__user {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__no {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__right {
    flex: none;
    text-align: right;
  }

  &__amount {
    display: block;
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }

  &__status {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
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

  &__title {
    display: block;
    margin-bottom: $space-3;
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
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

  &__safe {
    display: block;
    margin-top: $space-2;
    padding: $space-2 $space-3;
    font-size: $fs-caption;
    color: $c-gold;
    background: rgba(201, 168, 118, 0.14);
    border-radius: $radius-sm;
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
    }
  }
}

.reasons {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;

  &__item {
    padding: $space-2 $space-3;
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

.textarea {
  width: 100%;
  height: 180rpx;
  padding: $space-3;
  font-size: $fs-caption;
  line-height: 1.7;
  color: $c-text;
  background: $c-bg;
  border-radius: $radius-md;
  box-sizing: border-box;

  &__ph {
    color: $c-text-weak;
  }
}

.input {
  width: 100%;
  height: 72rpx;
  margin-top: $space-3;
  padding: 0 $space-3;
  font-size: $fs-caption;
  color: $c-text;
  background: $c-bg;
  border-radius: $radius-md;
  box-sizing: border-box;
}

.submit {
  padding: $space-2 0;

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
      opacity: 0.5;
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
