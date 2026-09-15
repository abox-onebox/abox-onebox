<template>
  <view class="page">
    <!-- 余额 -->
    <view v-if="balance" class="hero">
      <text class="hero__label">可提现余额</text>
      <text class="hero__value">{{ fenToYuanText(balance.balanceFen) }}</text>
      <text class="hero__sub">
        冻结中 {{ fenToYuanText(balance.frozenFen) }} · 最低提现
        {{ fenToYuanText(balance.minWithdrawFen) }}
      </text>
    </view>

    <!-- 收款方式 -->
    <view class="card" @tap="goProfile">
      <view class="card__hd">
        <text class="card__title">收款方式</text>
        <text class="card__link">{{ bound ? '修改 ›' : '去绑定 ›' }}</text>
      </view>
      <template v-if="bound">
        <view class="kv">
          <text class="kv__k">{{ payoutTypeLabel }}</text>
          <text class="kv__v">{{ displayOr(profile?.payoutAccount) }}</text>
        </view>
        <view v-if="profile?.payoutName" class="kv">
          <text class="kv__k">收款人</text>
          <text class="kv__v">{{ profile.payoutName }}</text>
        </view>
      </template>
      <text v-else class="card__foot">尚未绑定收款方式，绑定后才能提现</text>
    </view>

    <!-- 提现金额 -->
    <view class="card">
      <view class="card__hd">
        <text class="card__title">提现金额</text>
        <text class="card__link" @tap="fillAll">全部提现</text>
      </view>

      <view class="amount">
        <text class="amount__symbol">¥</text>
        <input
          v-model="amountText"
          class="amount__input"
          type="digit"
          placeholder="0.00"
          placeholder-class="amount__ph"
        />
      </view>

      <text class="amount__hint"> 佣金经灵活用工平台代发并代扣个税，实际到账以平台结算为准 </text>
    </view>

    <view class="submit">
      <button
        class="submit__btn"
        :disabled="submitting || !canSubmit"
        hover-class="submit__btn--hover"
        @tap="submit"
      >
        {{ submitting ? '提交中…' : '申请提现' }}
      </button>
      <text class="submit__hint"> 提交后进入「待审批」并冻结对应金额，运营审批打款后到账 </text>
    </view>

    <!-- 提现记录 -->
    <view class="records">
      <text class="records__title">提现记录</text>

      <ab-loading v-if="loadingRecords && !records.length" text="加载中" inline />

      <ab-empty-state v-else-if="!records.length" text="暂无提现记录" />

      <view v-for="r in records" :key="r.id" class="rec">
        <view class="rec__hd">
          <text class="rec__no">{{ r.withdrawNo }}</text>
          <text class="rec__badge">{{ r.statusText }}</text>
        </view>
        <view class="rec__bd">
          <text class="rec__amount">{{ fenToYuanText(r.amountFen) }}</text>
          <text class="rec__time">{{ formatDateTime(r.createdAt) }}</text>
        </view>
        <text v-if="r.receiveAccount" class="rec__acct">{{ r.receiveAccount }}</text>
        <text v-if="r.failReason" class="rec__fail">{{ r.failReason }}</text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * P18 · 提现申请
 *
 * 数据来源：L11 余额 + L14 资料（收款方式）+ L12 提现申请 + L13 提现记录。
 *
 * ⚠️ L12 的 `amount` 单位是**元**（number），而其余金额出参一律是**分** ——
 *    提交前用 `Number()` 转换，切勿把分直接传进去（否则会放大 100 倍）。
 * ⚠️ 幂等键：**一次「提交意图」一个 key**，失败重试沿用、成功后作废。
 * ⚠️ 三条拦截：`40003` 低于最低额（`payload.minFen`）/ `40007` 未绑定收款方式
 *    / `50004` 可提现余额不足 —— 端上据此给不同引导。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchLeaderProfile } from '@/api/leader';
import type { LeaderProfile } from '@/api/leader';
import { applyWithdraw, fetchLeaderBalance, fetchWithdrawals } from '@/api/leader-finance';
import type { LeaderBalanceData, LeaderWithdrawalItem } from '@/api/leader-finance';
import { ApiError } from '@/api/request';
import { apiErrorMessage, toastApiError, useRequest } from '@/composables/use-request';
import { displayOr, fenToYuanText, formatDateTime, uuid } from '@/utils/format';
import { navigateTo } from '@/utils/router';

const { run } = useRequest();

const balance = ref<LeaderBalanceData | null>(null);
const profile = ref<LeaderProfile | null>(null);
const amountText = ref('');
const submitting = ref(false);
const records = ref<LeaderWithdrawalItem[]>([]);
const loadingRecords = ref(false);

/** 当前「提交意图」的幂等键（失败重试沿用；成功后作废） */
let pendingKey = '';

const bound = computed(() => profile.value?.payoutBound === true);

const payoutTypeLabel = computed(() =>
  profile.value?.payoutType === 'alipay' ? '支付宝' : '银行卡',
);

const amountYuan = computed(() => {
  const n = Number(amountText.value);
  return Number.isFinite(n) ? n : 0;
});

const canSubmit = computed(() => bound.value && amountYuan.value > 0);

async function loadAll(): Promise<void> {
  try {
    const [b, p] = await Promise.all([
      run(() => fetchLeaderBalance()),
      run(() => fetchLeaderProfile()),
    ]);
    balance.value = b;
    profile.value = p;
  } catch (e) {
    toastApiError(e, '余额加载失败');
  }
  await loadRecords();
}

async function loadRecords(): Promise<void> {
  loadingRecords.value = true;
  try {
    const res = await run(() => fetchWithdrawals({ pageSize: 20 }));
    records.value = res.list;
  } catch {
    records.value = [];
  } finally {
    loadingRecords.value = false;
  }
}

function fillAll(): void {
  if (!balance.value) return;
  amountText.value = (balance.value.balanceFen / 100).toFixed(2);
}

async function submit(): Promise<void> {
  if (submitting.value || !canSubmit.value) return;

  const minYuan = (balance.value?.minWithdrawFen ?? 0) / 100;
  if (amountYuan.value < minYuan) {
    uni.showToast({ title: `最低提现 ¥${minYuan.toFixed(2)}`, icon: 'none' });
    return;
  }

  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: '确认提现',
      content: `申请提现 ¥${amountYuan.value.toFixed(2)}，提交后金额将冻结，审批通过后打款。`,
      confirmText: '确认提交',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
  if (!confirmed) return;

  submitting.value = true;
  if (!pendingKey) pendingKey = uuid();

  try {
    const res = await run(() => applyWithdraw({ amount: amountYuan.value }, pendingKey));
    pendingKey = '';
    uni.showToast({ title: `已提交 ${res.withdrawNo}`, icon: 'none', duration: 2400 });
    amountText.value = '';
    await loadAll();
  } catch (e) {
    // 保留 pendingKey：重试沿用同一键，避免重复冻结
    handleWithdrawError(e);
  } finally {
    submitting.value = false;
  }
}

/** 三条资金类拦截 → 给不同引导（其余按通用文案提示） */
function handleWithdrawError(e: unknown): void {
  if (e instanceof ApiError && e.code === 40007) {
    uni.showModal({
      title: '未绑定收款方式',
      content: '请先绑定银行卡或支付宝账号，再发起提现。',
      confirmText: '去绑定',
      success: (r) => {
        if (r.confirm) navigateTo('/pages/leader/profile');
      },
    });
    return;
  }
  if (e instanceof ApiError && e.code === 40003) {
    const minFen = Number((e.payload as { minFen?: number } | null)?.minFen ?? 0);
    uni.showToast({ title: `最低提现 ¥${(minFen / 100).toFixed(2)}`, icon: 'none' });
    return;
  }
  if (e instanceof ApiError && e.code === 50004) {
    uni.showToast({ title: '可提现余额不足', icon: 'none' });
    return;
  }
  uni.showToast({ title: apiErrorMessage(e, '提现失败'), icon: 'none', duration: 2400 });
}

function goProfile(): void {
  navigateTo('/pages/leader/profile');
}

onShow(() => {
  void loadAll();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 120rpx;
  box-sizing: border-box;
}

.hero {
  padding: $space-4 $space-1 $space-5;

  &__label {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    display: block;
    margin-top: $space-2;
    font-size: $fs-display;
    font-weight: 600;
    color: $c-gold;
    font-variant-numeric: tabular-nums;
  }

  &__sub {
    display: block;
    margin-top: $space-2;
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

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-2;
  }

  &__title {
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__link {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__foot {
    display: block;
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
  }
}

.amount {
  display: flex;
  align-items: baseline;
  padding: $space-3 0 $space-2;
  border-bottom: 1px solid $c-border;

  &__symbol {
    font-size: $fs-h1;
    color: $c-text;
  }

  &__input {
    flex: 1;
    margin-left: $space-2;
    font-size: $fs-display;
    font-weight: 600;
    color: $c-text;
  }

  &__ph {
    color: $c-text-weak;
    font-weight: 400;
  }

  &__hint {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.submit {
  margin-bottom: $space-5;

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

.records {
  &__title {
    display: block;
    padding-bottom: $space-3;
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }
}

.rec {
  margin-bottom: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__no {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__badge {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__bd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: $space-2 0;
  }

  &__amount {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }

  &__time {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__acct {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__fail {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-warning;
  }
}
</style>
