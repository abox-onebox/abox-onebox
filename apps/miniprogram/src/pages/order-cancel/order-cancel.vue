<template>
  <view class="page">
    <ab-loading v-if="loading && !detail" text="正在加载订单" />

    <template v-else-if="detail">
      <!-- 已截单 / 状态不允许：不接受自助取消，直接给出替代路径 -->
      <template v-if="blocked">
        <view class="hero hero--warn">
          <text class="hero__title">无法自助退款</text>
          <text class="hero__desc">
            <!-- ⭐ 2026-10-07 复查⑰：原写「截单后（T-1 24:00）」。本页只有
                 `OrderDetailResult`（它的时刻字段是**送达** `pickup.expectAt`，没有截单时刻），
                 故退化为**不含时刻**的表述，而不是去抄一个写死的 24:00 ——
                 需要截单时刻的页面（首页横幅 / 下单页）一律从 `daily.cutoffAt` 取。 -->
            截单后订单已进入备餐流程，需由团长发起代退申请，平台审批后原路退回。
          </text>
        </view>

        <view class="section">
          <view class="section__hd">
            <text class="section__title">请联系团长</text>
          </view>
          <view class="card">
            <view class="card__row">
              <text class="card__label">团长</text>
              <text class="card__value">{{ leaderName || '本楼团长' }}</text>
            </view>
            <view v-if="leaderPhone" class="card__row" @tap="contactLeader">
              <text class="card__label">电话</text>
              <text class="card__value card__value--link">{{ leaderPhone }}</text>
            </view>
          </view>
        </view>
      </template>

      <template v-else>
        <view class="hero">
          <text class="hero__title">确认取消这笔订单？</text>
          <text class="hero__desc">
            截单前可自助取消，已支付金额将原路退回；余额抵扣部分退回账户余额。
          </text>
        </view>

        <view class="section">
          <view class="section__hd">
            <text class="section__title">订单摘要</text>
          </view>
          <view class="card">
            <view class="card__row">
              <text class="card__label">出餐日</text>
              <text class="card__value">{{ formatMealDate(detail.mealDate) }}</text>
            </view>
            <view class="card__row">
              <text class="card__label">份数</text>
              <text class="card__value">× {{ detail.quantity }}</text>
            </view>
            <view class="card__row">
              <text class="card__label">实付</text>
              <text class="card__value card__value--strong">
                {{ fenToYuanText(detail.payAmountFen) }}
              </text>
            </view>
            <view class="card__row">
              <text class="card__label">订单号</text>
              <text class="card__value">{{ detail.orderNo }}</text>
            </view>
          </view>
        </view>

        <!-- 取消原因（2026-10-04）：用于分析「为什么不要了」，**可不选** -->
        <view class="section">
          <view class="section__hd">
            <text class="section__title">取消原因</text>
            <text class="section__hint">可不选，直接取消也行</text>
          </view>
          <view class="card">
            <view class="reasons">
              <view
                v-for="r in reasonOptions"
                :key="r.key"
                class="chip"
                :class="{ 'chip--on': reason === r.key }"
                hover-class="chip--hover"
                @tap="pick(r.key)"
              >
                <text class="chip__text">{{ r.label }}</text>
              </view>
            </view>

            <textarea
              v-if="reason === 'other'"
              v-model="note"
              class="note-input"
              placeholder="简单说说原因（可不填）"
              :maxlength="CANCEL_NOTE_MAX"
              :auto-height="true"
            />
          </view>
        </view>
      </template>
    </template>

    <ab-empty-state
      v-else
      text="找不到该订单"
      :hint="errorHint"
      illustration="search"
      action-text="返回订单列表"
      @action="goList"
    />

    <view v-if="detail" class="actions">
      <button
        v-if="!blocked && !cancelled"
        class="btn btn--danger"
        hover-class="btn--hover"
        :disabled="submitting"
        @tap="confirm"
      >
        {{ submitting ? '处理中…' : reason ? '确认取消订单' : '不说明，直接取消' }}
      </button>
      <button class="btn btn--ghost" hover-class="btn--hover" @tap="goBack">
        {{ cancelled || blocked ? '返回订单详情' : '先不取消' }}
      </button>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * P7 · 取消订单（仅截单前可自助退）
 *
 * 验收要点（M1 标准 3）：
 *   · 截单前取消成功、金额原路退回
 *   · **截单后调取消接口返回 `40004`**，并引导联系团长代退（C6 三段式第一段）
 *
 * ⚠️ 端上**不做**「是否已截单」的判定作为放行依据 ——
 *    截单是服务端硬闸，端上时钟又不可信，故一律以服务端 `40004` 为准。
 *    本页 `blocked` 只用于「已确定不可自助取消」后的展示降级。
 */
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import {
  CANCEL_NOTE_MAX,
  CANCEL_REASONS,
  CANCEL_REASON_LABEL,
  OrderStatus,
} from '@abox/shared-types';
import type { CancelReason, OrderDetailResult } from '@abox/shared-types';

import { cancelOrder, fetchOrderDetail } from '@/api/order';
import { ApiError, CODE_REFUND_NOT_ALLOWED } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useSubscribeMessage } from '@/composables/use-subscribe-message';
import { fenToYuanText, formatMealDate, maskPhone } from '@/utils/format';
import { navigateBack, pageQuery, switchTab } from '@/utils/router';

const { run, loading } = useRequest();
const subscribe = useSubscribeMessage();

const detail = ref<OrderDetailResult | null>(null);
const errorHint = ref('请返回订单列表重试');
const orderNo = ref('');
const submitting = ref(false);
const cancelled = ref(false);
/** 服务端已明确拒绝（40004）/ 状态本身不可自助取消 → 降级为「联系团长」 */
const rejectedByServer = ref(false);

/**
 * 取消原因（2026-10-04 新增）
 *
 * ⚠️ **可跳过**：`reason` 为 null 直接提交即可，按钮文案会跟着变成「不说明，直接取消」。
 *    服务端此时落 `cancel_reason = null`、来源仍记 `user` —— 区分「不愿说」与
 *    「系统清掉」靠的是来源字段，不是理由。
 */
const reason = ref<CancelReason | null>(null);
const note = ref('');

/** 选项列表（标签取自真源 `CANCEL_REASON_LABEL`，端上不维护第二份文案） */
const reasonOptions = CANCEL_REASONS.map((key) => ({
  key,
  label: CANCEL_REASON_LABEL[key],
}));

/** 再点一次已选项 = 取消选择；换选项时清掉旧补充，避免串到别的理由上 */
function pick(key: CancelReason): void {
  reason.value = reason.value === key ? null : key;
  note.value = '';
}

/** 可自助取消的状态（截单与否由服务端二次判定） */
const cancellableStatus = computed(() => {
  const s = detail.value?.status;
  return s === OrderStatus.PENDING_PAY || s === OrderStatus.PAID;
});

const blocked = computed(() => rejectedByServer.value || !cancellableStatus.value);

const leaderName = computed(
  () => detail.value?.leaderContact?.name ?? detail.value?.pickup.leaderName ?? '',
);
const leaderPhone = computed(() =>
  maskPhone(detail.value?.leaderContact?.phone ?? detail.value?.pickup.leaderPhone),
);

async function load(): Promise<void> {
  if (!orderNo.value) return;
  try {
    detail.value = await run(() => fetchOrderDetail(orderNo.value));
  } catch (e) {
    if (detail.value === null && e instanceof ApiError) errorHint.value = e.message;
    toastApiError(e);
  }
}

async function confirm(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    // ⭐ M4-3：请求「退款结果通知」订阅授权（`refund_result` —— 原型标注的**必推项**）
    //
    // ⚠️ 「必推」是**产品意图**，不是「无需用户同意」：微信订阅消息是一次性授权，
    //    没授权就推不出去（微信回 `43101`）。所以必须在**用户点击的这一下**要授权，
    //    否则「退款必推」在微信侧根本发不出去 —— 而这条链路此前完全缺失。
    // 位置在第一个 `await` 之前（手势窗口），模板清单由 `onLoad` 预加载。
    subscribe.requestFor(['refund_result'], (results) => {
      console.log('[subscribe] refund_result', results);
    });

    const res = await run(() => cancelOrder(orderNo.value, reason.value, note.value));
    cancelled.value = true;
    uni.showToast({
      title: res.refundInitiated ? '已取消，款项原路退回' : '订单已取消',
      icon: 'none',
      duration: 2200,
    });
    // 返回详情页后其 onShow 会重新拉取，状态自然刷新
    setTimeout(() => goBack(), 1200);
  } catch (e) {
    if (e instanceof ApiError && e.code === CODE_REFUND_NOT_ALLOWED) {
      // 40004：已截单 → 转「联系团长代退」引导，并把服务端给的团长联系方式补进详情
      rejectedByServer.value = true;
      const payload = e.payload as {
        leaderContact?: { name: string | null; phone: string | null } | null;
      } | null;
      if (payload?.leaderContact && detail.value) {
        detail.value = { ...detail.value, leaderContact: payload.leaderContact };
      }
      void load();
      return;
    }
    toastApiError(e);
  } finally {
    submitting.value = false;
  }
}

/**
 * 「联系团长」→ **引导**，不拨号
 *
 * ⚠️ 2026-10-04 整体复查（报告 ⑩）修正：此处原为
 *    `uni.makePhoneCall({ phoneNumber: leaderPhone.value, fail: () => undefined })`，
 *    而 `leaderPhone` 由 `maskPhone()` 派生 —— 服务端对团长手机号**恒脱敏**
 *    （`order.service.ts:417/451/490`），拨一个 `138****0001` **必然失败**；
 *    更要命的是 `fail: () => undefined` 把失败**静默吞掉**：既不弹错也不打日志，
 *    表现为「点了完全没反应」，而开发者工具里拨号本就不可用 ⇒ 测试会当工具限制放过。
 *
 * ⭐ 禁用依据**就写在隔壁**：`order-detail.vue:266-268`「团长手机号在出参里已脱敏…
 *    故『联系团长』**不做 makePhoneCall**」。同一件事在两处给出了两份结论，
 *    取消页（10-04 批次改过「取消原因」）没同步这条口径。⇒ 此处与详情页取同一写法。
 */
function contactLeader(): void {
  uni.showToast({
    title: leaderName.value
      ? `请在楼栋微信群 @${leaderName.value}，或联系平台客服`
      : '请在楼栋微信群联系团长，或联系平台客服',
    icon: 'none',
    duration: 2600,
  });
}

function goBack(): void {
  navigateBack();
}

function goList(): void {
  switchTab('/pages/order-list/order-list');
}

onLoad((options) => {
  orderNo.value = pageQuery(options as Record<string, unknown>, 'orderNo');
  // 预加载订阅模板清单（**不在点击回调里拉** —— 手势窗口会失效，见 composable 头注）
  void subscribe.preload();
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

.hero {
  padding: $space-5 0 $space-3;

  &__title {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__desc {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &--warn &__title {
    color: $c-warn-fg;
  }
}

.section {
  margin-top: $space-4;

  &__hd {
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }
}

.card {
  padding: $space-2 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: $space-3 0;
    border-bottom: 1px solid rgba(228, 216, 195, 0.5);

    &:last-child {
      border-bottom: none;
    }
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    font-size: $fs-caption;
    color: $c-text;

    &--strong {
      font-size: $fs-h2;
      font-weight: 600;
    }

    &--link {
      color: $c-info-fg; // 文字位一律走加强档（原色 $c-info 只作图标/描边；二者同值时也不留口子）
    }
  }
}

/* 取消原因 —— 选项用「色块 + 文字」而非状态原色（设计替换 §六：等级/状态原色退出文字位） */
.reasons {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  padding: $space-3 0;
}

.chip {
  padding: $space-2 $space-3;
  background: transparent;
  border: 1px solid $c-border;
  border-radius: $radius-pill;

  &__text {
    font-size: $fs-caption;
    color: $c-text;
  }

  /* 选中 = 实心反转（暖棕底 + 米色字），不引入新色值 */
  &--on {
    background: $c-text;
    border-color: $c-text;

    .chip__text {
      color: $c-surface;
    }
  }

  &--hover {
    opacity: 0.85;
  }
}

.note-input {
  width: 100%;
  min-height: 120rpx;
  margin-bottom: $space-3;
  padding: $space-2 $space-3;
  font-size: $fs-caption;
  color: $c-text;
  background: $c-bg;
  border: 1px solid $c-border;
  border-radius: $radius-sm;
  box-sizing: border-box;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  margin-top: $space-5;
}

.btn {
  height: 80rpx;
  font-size: $fs-body;
  line-height: 80rpx;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--danger {
    color: $c-surface;
    background: $c-warning;
  }

  &--ghost {
    color: $c-text;
    background: transparent;
    border: 1px solid $c-text;
  }

  &--hover {
    opacity: 0.85;
  }
}
</style>
