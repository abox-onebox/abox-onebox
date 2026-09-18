<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP9（v4.10.0）：
         余额渐变大卡（含说明 + 去使用）→ 口径说明条 → 流水记录卡（含合计） -->

    <ab-loading v-if="loadingBalance && !balance" text="正在读取余额" />

    <template v-else>
      <!-- 余额大卡（深棕 → 金渐变） -->
      <view class="hero">
        <text class="hero__label">账户余额</text>
        <text class="hero__amount">{{ fenToYuanText(balance?.balanceFen ?? 0) }}</text>
        <text class="hero__sub">{{
          balance?.note || '余额来自订单退款与团长佣金入账，不支持充值；下单时可直接抵扣'
        }}</text>
        <view v-if="frozenText" class="hero__frozen">
          <text class="hero__frozen-text">其中冻结 {{ frozenText }}（提现 / 平台冻结）</text>
        </view>
        <view class="hero__acts">
          <button class="hero__btn" hover-class="hero__btn--hover" @tap="goUse">去使用</button>
        </view>
      </view>

      <!-- 口径说明条（左金边 · 文案以服务端口径为准，端上不自造） -->
      <view class="tips">
        <text class="tips__text">
          余额来自<text class="tips__strong">订单退款</text>与<text class="tips__strong"
            >团长佣金入账</text
          >，<text class="tips__strong">不支持充值</text>（避免形成预付资金）；下单时可直接抵扣。
        </text>
        <text class="tips__text">
          ⚠️ 原型文案原写「用户余额仅来自订单退款、团长佣金余额是独立账户」，与实装不符：
          用户与团长<text class="tips__strong">共用同一账户</text>，佣金入账也进这里
          （同一条余额链路）—— 故本页按全部流水列出，不做类型过滤。
        </text>
      </view>

      <!-- 流水记录 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">📊 流水记录</text>
          <text class="card__count">共 {{ summary?.count ?? 0 }} 笔</text>
        </view>

        <ab-loading v-if="loadingLogs && !list.length" text="正在读取流水" />

        <view v-else-if="!list.length" class="empty">
          <text class="empty__icon">🧾</text>
          <text class="empty__text">还没有余额流水</text>
          <text class="empty__hint">退款到账或佣金入账后，会在这里逐笔列出</text>
        </view>

        <template v-else>
          <view v-for="item in list" :key="item.id" class="row">
            <view class="row__left">
              <text class="row__type">{{ item.typeText }}</text>
              <text class="row__ref">{{ item.relatedId || item.remark || '—' }}</text>
            </view>
            <view class="row__right">
              <text class="row__amount" :class="item.direction > 0 ? 'is-in' : 'is-out'">
                {{ item.direction > 0 ? '+' : '−' }}{{ fenToYuanText(item.amountFen) }}
              </text>
              <text class="row__date">{{ formatDateTime(item.createdAt) }}</text>
            </view>
          </view>

          <!-- 合计（按**全量**统计，不受分页影响 —— 服务端 summary 口径） -->
          <view class="total">
            <text class="total__text">
              收入 {{ fenToYuanText(summary?.inFen ?? 0) }} − 支出
              {{ fenToYuanText(summary?.outFen ?? 0) }}
            </text>
            <text class="total__net">= {{ fenToYuanText(summary?.netFen ?? 0) }}</text>
          </view>

          <button
            v-if="hasMore"
            class="more"
            hover-class="more--hover"
            :disabled="loadingLogs"
            @tap="loadMore"
          >
            {{ loadingLogs ? '加载中…' : '加载更多' }}
          </button>
        </template>
      </view>

      <text class="foot">余额异常请联系平台客服（我的 → 客服微信号），由人工核对处理</text>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P9 · 账户余额明细（用户侧）
 *
 * ⭐ 版式基准 = prototype/index.html renderP9（v4.10.0）
 *
 * 数据来源（M5-10 新增，此前本页是**脚手架占位页**）：
 *   · U13 `GET /me/balance`      —— 余额快照（整数分）+ 口径说明 `note`
 *   · U14 `GET /me/balance/logs` —— 流水（分页）+ **全量**收支汇总 `summary`
 *
 * ⚠️ 与团长端「余额流水」（P17 · L19）读的是**同一张 `ab_balance`**：
 *    用户与团长共用同一小程序身份，佣金入账与下单抵扣走同一条余额链路。
 *    故本页**不按类型过滤**（原型那套「用户只看退款」的切分与实装不符）——
 *    否则大卡显示含佣金的总额、下方流水却把佣金藏起来，用户自己加不出上面那个数。
 *
 * ⚠️ `amountFen` **恒为正数**，方向看 `direction`；与 L10 佣金明细的冲销笔
 *    （`amountFen` 本身为负）**口径不同**，不得共用同一套正负号逻辑。
 * ⚠️ `typeText` 一律取服务端（端上不自造文案）。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchMyBalance, fetchMyBalanceLogs } from '@/api/user';
import type { MyBalanceLogItem, MyBalanceLogsData, UserBalanceData } from '@/api/user';
import { toastApiError, useRequest } from '@/composables/use-request';
import { fenToYuanText, formatDateTime } from '@/utils/format';
import { PAGE_SIZE } from '@/constants';
import { switchTab } from '@/utils/router';

const balance = ref<UserBalanceData | null>(null);
const list = ref<MyBalanceLogItem[]>([]);
const summary = ref<MyBalanceLogsData['summary'] | null>(null);
const page = ref(1);
const hasMore = ref(false);

const { run, loading: loadingBalance } = useRequest();
const { run: runLogs, loading: loadingLogs } = useRequest();

const frozenText = computed(() =>
  (balance.value?.frozenFen ?? 0) > 0 ? fenToYuanText(balance.value?.frozenFen ?? 0) : '',
);

async function loadBalance(): Promise<void> {
  try {
    balance.value = await run(() => fetchMyBalance());
  } catch (e) {
    toastApiError(e);
  }
}

async function fetchLogPage(target: number): Promise<void> {
  const res = await runLogs(() => fetchMyBalanceLogs({ page: target, pageSize: PAGE_SIZE }));
  list.value = target === 1 ? res.list : [...list.value, ...res.list];
  summary.value = res.summary;
  page.value = res.page;
  hasMore.value = res.hasMore;
}

async function loadLogs(): Promise<void> {
  try {
    await fetchLogPage(1);
  } catch (e) {
    toastApiError(e);
  }
}

async function loadMore(): Promise<void> {
  if (loadingLogs.value || !hasMore.value) return;
  try {
    await fetchLogPage(page.value + 1);
  } catch (e) {
    toastApiError(e);
  }
}

/** 「去使用」= 回首页下单（余额在下单时自动抵扣，故没有独立的「用余额」动作） */
function goUse(): void {
  if ((balance.value?.balanceFen ?? 0) <= 0) {
    uni.showToast({ title: '当前无可抵扣余额', icon: 'none' });
    return;
  }
  switchTab('/pages/index/index');
}

onShow(() => {
  void loadBalance();
  void loadLogs();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-3 $space-4 $space-5;
  box-sizing: border-box;
}

// ---- 余额大卡（深棕 → 金渐变） ----
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 44rpx $space-4;
  background: linear-gradient(135deg, $c-text, #b8892f);
  border-radius: 36rpx;
  color: #ffffff;
  text-align: center;
  box-shadow: 0 10rpx 28rpx rgba(110, 84, 53, 0.22);

  &__label {
    font-size: $fs-caption;
    opacity: 0.92;
  }

  &__amount {
    margin: $space-2 0;
    font-size: 76rpx;
    font-weight: bold;
    letter-spacing: 2rpx;
  }

  &__sub {
    font-size: $fs-caption;
    line-height: 1.6;
    opacity: 0.9;
  }

  &__frozen {
    margin-top: $space-2;
    padding: 4rpx $space-3;
    background: rgba(255, 255, 255, 0.18);
    border-radius: $radius-sm;
  }

  &__frozen-text {
    font-size: $fs-caption;
  }

  &__acts {
    margin-top: $space-4;
  }

  &__btn {
    height: 64rpx;
    padding: 0 $space-5;
    line-height: 64rpx;
    color: $c-text;
    font-size: $fs-body;
    background: #ffffff;
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

// ---- 口径说明条（左蓝边） ----
.tips {
  margin-top: $space-3;
  padding: $space-3;
  background: #fbf7ee;
  border-left: 6rpx solid $c-info;
  border-radius: $radius-sm;

  &__text {
    display: block;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;

    & + & {
      margin-top: $space-1;
    }
  }

  &__strong {
    font-weight: bold;
    color: $c-text;
  }
}

// ---- 流水卡 ----
.card {
  margin-top: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: 0 2rpx 8rpx rgba(110, 84, 53, 0.06);

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

  &__count {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed #d4c4a8;

  &__left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  &__type {
    font-size: $fs-body;
    color: $c-text;
  }

  &__ref {
    margin-top: $space-1;
    overflow: hidden;
    font-size: $fs-caption;
    color: $c-text-weak;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  &__right {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin-left: $space-3;
  }

  &__amount {
    font-size: $fs-body;
    font-weight: bold;

    &.is-in {
      color: $c-success;
    }

    &.is-out {
      color: $c-warning;
    }
  }

  &__date {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-top: $space-3;
  padding: $space-2 $space-3;
  background: #fbf7ee;
  border-radius: $radius-sm;

  &__text {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__net {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-5 0;

  &__icon {
    font-size: 72rpx;
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
  }
}

.more {
  height: 68rpx;
  margin-top: $space-3;
  line-height: 68rpx;
  color: $c-gold;
  font-size: $fs-caption;
  background: $c-bg;
  border: 1px solid $c-border;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.88;
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
