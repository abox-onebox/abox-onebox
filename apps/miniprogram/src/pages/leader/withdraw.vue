<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP18（v4.10.0）：
         居中可提现大额 → 收款方式 → 提现金额输入 → 提现记录 → 确认/取消 -->

    <!-- ① 可提现余额 -->
    <view class="top">
      <text class="top__amount">{{ fenToYuanText(balance?.balanceFen ?? 0) }}</text>
      <text class="top__label">可提现余额</text>
      <text v-if="(balance?.frozenFen ?? 0) > 0" class="top__frozen">
        冻结中 {{ fenToYuanText(balance?.frozenFen ?? 0) }}（提现处理占用）
      </text>
    </view>

    <!-- ② 收款方式（原型未画，实装保留：未绑卡提交必 40007） -->
    <view class="card" hover-class="card--hover" @tap="goProfile">
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
      <text v-else class="card__warn">尚未绑定收款方式，绑定后才能提现</text>
    </view>

    <!-- ③ 提现金额 -->
    <view class="card">
      <text class="card__title">提现金额</text>

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

      <view class="amount__ft">
        <text class="amount__all" @tap="fillAll">全部提现</text>
        <text class="amount__hint">平台代发 · 预计 1–2 个工作日到账（个税已代扣）</text>
      </view>
      <text class="amount__min">最低提现 {{ fenToYuanText(balance?.minWithdrawFen ?? 0) }}</text>
    </view>

    <!-- ④ 提现记录 -->
    <view class="card">
      <text class="card__title">📋 提现记录</text>

      <ab-loading v-if="loadingRecords && !records.length" text="加载中" inline />

      <ab-empty-state v-else-if="!records.length" text="暂无提现记录" />

      <template v-else>
        <view v-for="r in records" :key="r.id" class="rec">
          <view class="rec__left">
            <text class="rec__no">{{ formatDate(r.createdAt) }} · 平台代发</text>
            <text class="rec__status">{{ r.statusText }}</text>
            <text v-if="r.failReason" class="rec__fail">{{ r.failReason }}</text>
          </view>
          <text class="rec__amount">−{{ fenToYuanText(r.amountFen) }}</text>
        </view>

        <view class="rec__total">
          <text class="rec__total-k">合计已提现</text>
          <text class="rec__total-v">{{ fenToYuanText(balance?.withdrawnFen ?? 0) }}</text>
        </view>
      </template>
    </view>

    <!-- ⑤ 操作 -->
    <button
      class="btn btn--primary"
      :disabled="submitting || !canSubmit"
      hover-class="btn--hover"
      @tap="submit"
    >
      {{ submitting ? '提交中…' : '确认提现' }}
    </button>
    <button class="btn btn--ghost" hover-class="btn--hover" @tap="goBack">取消</button>

    <text class="foot">
      提交后进入「待审批」并冻结对应金额，运营审批打款后到账；佣金经灵活用工平台代发并代扣个税。
    </text>
  </view>
</template>

<script setup lang="ts">
/**
 * P18 · 提现申请
 *
 * ⭐ 版式基准 = prototype/index.html renderP18（v4.10.0）
 *
 * 数据来源：L11 余额 + L14 资料（收款方式）+ L12 提现申请 + L13 提现记录。
 *
 * ⚠️ L12 的 `amount` 单位是**元**（number），而其余金额出参一律是**分** ——
 *    提交前用 `Number()` 转换，切勿把分直接传进去（否则会放大 100 倍）。
 * ⚠️ 幂等键：**一次「提交意图」一个 key**，失败重试沿用、成功后作废。
 * ⚠️ 三条拦截：`40003` 低于最低额（`payload.minFen`）/ `40007` 未绑定收款方式
 *    / `50004` 可提现余额不足 —— 端上据此给不同引导。
 * ⚠️ 「合计已提现」取 L11 `withdrawnFen`（团长维度快照），不用列表累加
 *    ——列表是分页的（一页 20 条），累加会得到偏小的数。
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
import { navigateTo, navigateBack } from '@/utils/router';

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

/** 记录行只显示日期（原型「09-12 · 平台代发」） */
function formatDate(iso: string | null): string {
  const full = formatDateTime(iso);
  return full.length >= 10 ? full.slice(5, 10) : full;
}

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

/** 三条拦截分别给引导（低于最低额 / 未绑卡 / 余额不足） */
function handleWithdrawError(e: unknown): void {
  if (e instanceof ApiError) {
    if (e.code === 40007) {
      uni.showToast({ title: '请先绑定收款方式', icon: 'none' });
      setTimeout(() => goProfile(), 800);
      return;
    }
    if (e.code === 40003) {
      const minFen = Number((e.payload as { minFen?: number } | null)?.minFen ?? 0);
      uni.showToast({
        title: minFen ? `最低提现 ¥${(minFen / 100).toFixed(2)}` : apiErrorMessage(e),
        icon: 'none',
      });
      return;
    }
    if (e.code === 50004) {
      uni.showToast({ title: '可提现余额不足', icon: 'none' });
      return;
    }
  }
  uni.showToast({ title: apiErrorMessage(e, '提现失败'), icon: 'none', duration: 2400 });
}

function goProfile(): void {
  navigateTo('/pages/leader/profile');
}

function goBack(): void {
  navigateBack();
}

onShow(() => {
  void loadAll();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4;
  box-sizing: border-box;
}

// ---- ① 可提现大额 ----
.top {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-5 0 $space-4;

  &__amount {
    font-size: 88rpx;
    font-weight: bold;
    color: #b8892f;
    letter-spacing: 2rpx;
    font-variant-numeric: tabular-nums;
  }

  &__label {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__frozen {
    margin-top: $space-2;
    padding: 6rpx $space-3;
    font-size: $fs-caption;
    color: $c-text;
    background: #fbf7ee;
    border-radius: $radius-pill;
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

  &--hover {
    opacity: 0.88;
  }

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-2;
  }

  &__title {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__hd &__title {
    margin-bottom: 0;
  }

  &__link {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__warn {
    display: block;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-warning;
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

// ---- ③ 金额输入 ----
.amount {
  display: flex;
  align-items: center;
  padding-bottom: $space-2;
  border-bottom: 1px solid $c-border;

  &__symbol {
    flex: none;
    font-size: 44rpx;
    font-weight: bold;
    color: $c-text;
  }

  &__input {
    flex: 1;
    height: 76rpx;
    margin-left: $space-2;
    font-size: 44rpx;
    font-weight: bold;
    color: $c-text;
  }

  &__ph {
    color: $c-border;
  }

  &__ft {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-top: $space-2;
  }

  &__all {
    font-size: $fs-caption;
    color: #b8892f;
    text-decoration: underline;
  }

  &__hint {
    flex: 1;
    margin-left: $space-3;
    font-size: 22rpx;
    line-height: 1.6;
    color: $c-text-weak;
    text-align: right;
  }

  &__min {
    display: block;
    margin-top: $space-2;
    font-size: 22rpx;
    color: $c-text-weak;
  }
}

// ---- ④ 提现记录 ----
.rec {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed #d4c4a8;

  &__left {
    flex: 1;
    min-width: 0;
  }

  &__no {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__status {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__fail {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-warning;
  }

  &__amount {
    flex: none;
    margin-left: $space-3;
    font-size: $fs-body;
    color: $c-text-weak;
    font-variant-numeric: tabular-nums;
  }

  &__total {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-top: $space-3;
    padding-top: $space-3;
    border-top: 1px dashed $c-border;

    &-k {
      font-size: $fs-caption;
      color: $c-text-weak;
    }

    &-v {
      font-size: $fs-body;
      font-weight: bold;
      color: $c-text;
    }
  }
}

// ---- ⑤ 按钮 ----
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
    background: linear-gradient(135deg, $c-gold, #b8892f);
    border: none;
  }

  &--ghost {
    color: $c-text;
    background: $c-surface;
    border: 1px solid $c-border;
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
}
</style>
