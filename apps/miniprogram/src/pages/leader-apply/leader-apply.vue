<template>
  <view class="page">
    <!-- 头部说明（C3：提交即生效，无审核） -->
    <view class="hero">
      <text class="hero__title">成为团长</text>
      <text class="hero__sub">
        勾选《团长合作协议》后提交即生效，无需审核 —— 立即以见习团长身份（8%）开始接单
      </text>
    </view>

    <!-- 服务办公楼（C3：来自邀请链接绑定，端上不读定位） -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">服务办公楼</text>
      </view>
      <view class="card">
        <view class="card__row">
          <text class="card__label">办公楼</text>
          <text class="card__value">{{ buildingText }}</text>
        </view>
      </view>
      <view v-if="!hasBuilding" class="tip">
        <text class="tip__text tip__text--warn">
          你还没有绑定办公楼。请先通过团长的邀请链接进入小程序完成绑定，再申请成为团长。
        </text>
      </view>
    </view>

    <!-- 资料 -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">填写资料</text>
      </view>
      <view class="form">
        <view class="field">
          <text class="field__label">公司 + 姓名<text class="field__req"> *</text></text>
          <input
            v-model="realName"
            class="field__input"
            placeholder="如：XX 公司 · 张某某"
            placeholder-class="field__placeholder"
            :maxlength="32"
          />
        </view>
        <view class="field">
          <text class="field__label">手机号<text class="field__req"> *</text></text>
          <input
            v-model="phone"
            class="field__input"
            type="number"
            placeholder="用于到楼下提醒用户取餐"
            placeholder-class="field__placeholder"
            :maxlength="11"
          />
        </view>
        <view class="field field--last">
          <text class="field__label">所在楼层</text>
          <input
            v-model="floor"
            class="field__input"
            placeholder="如：12F（选填）"
            placeholder-class="field__placeholder"
            :maxlength="32"
          />
        </view>
      </view>
    </view>

    <!-- 4 级佣金（本地渲染，与《接口规范》§4.6 同源：shared-types） -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">4 级佣金</text>
        <text class="section__tag">月单与介绍须同时满足</text>
      </view>
      <view class="card">
        <view v-for="row in levelRules" :key="row.key" class="rule">
          <view class="rule__hd">
            <text class="rule__name">{{ row.name }}</text>
            <text class="rule__rate">{{ Math.round(row.rate * 100) }}%</text>
          </view>
          <text class="rule__cond">{{ row.condition }}</text>
        </view>
      </view>
      <view class="tip">
        <text class="tip__text">{{ EXPIRE_RULE }}</text>
      </view>
    </view>

    <!-- 协议 -->
    <view class="section">
      <view class="agree" @tap="toggleAgree">
        <view class="agree__box" :class="{ 'is-checked': agreed }">
          <text v-if="agreed" class="agree__tick">✓</text>
        </view>
        <text class="agree__text">
          我已阅读并同意<text class="agree__link" @tap.stop="openAgreement">《团长合作协议》</text>
        </text>
      </view>
    </view>

    <view class="submit-bar">
      <button
        class="btn"
        :class="canSubmit ? 'btn--primary' : 'btn--disabled'"
        hover-class="btn--hover"
        :disabled="!canSubmit"
        @tap="submit"
      >
        {{ submitting ? '提交中…' : '提交申请并立即生效' }}
      </button>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 团长申请页（M2 · 任务 2.2 · L17/L18）
 *
 * 验收要点（M2 标准 ①）：
 *   「勾选协议后**立即生效**，tabBar 出现团长入口（无审核流程）」
 *   → 提交成功后写 `leaderStore`（`abox_is_leader`），`ab-bottom-bar` 立即变 5 项。
 *
 * ⚠️ C3 / L9 两条硬约束在本页的体现：
 *   ① 办公楼**不可手选** —— 取用户已绑定的 `buildingId`（由团长邀请链接绑定，端上不读定位）；
 *      未绑定则引导先去绑定，而不是放开一个办公楼下拉框。
 *   ② 协议必须显式勾选才可提交；不勾选连 `agreementVersion` 都不发，
 *      服务端据此返回 10001（「勾选 + 服务端留痕」，第三方 CA 电子签属二期）。
 *
 * ⚠️ 佣金规则**本地渲染**而非调 `GET /leader/level-rules`：
 *   该接口挂了 `LeaderGuard`，此时用户还不是团长（会 10003）；
 *   且规则唯一来源就是 `@abox/shared-types` 的 `LEADER_LEVEL_META`，本地渲染与服务端同源。
 */
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';

import { fetchMe } from '@/api/auth';
import { applyLeader } from '@/api/leader';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useSubscribeMessage } from '@/composables/use-subscribe-message';
import { useLeaderStore } from '@/stores/leader';
import { useUserStore } from '@/stores/user';
import { switchTab } from '@/utils/router';

/** 协议版本号：与《团长合作协议》文本版本一一对应，随文本升级而改 */
const AGREEMENT_VERSION = 'v1.0';
const EXPIRE_RULE = '见习团长 30 天内未促成订单将自动取消资格';

/** 等级阶梯（低 → 高），与后端 `LeaderLevelService.rules()` 同序 */
const LADDER: readonly LeaderLevel[] = [
  LeaderLevel.TRAINEE,
  LeaderLevel.FORMAL,
  LeaderLevel.GOLD,
  LeaderLevel.CHIEF,
];

const { run } = useRequest();
const subscribe = useSubscribeMessage();
const userStore = useUserStore();
const leaderStore = useLeaderStore();

const realName = ref('');
const phone = ref('');
const floor = ref('');
const agreed = ref(false);
const submitting = ref(false);

const hasBuilding = computed(() => !!userStore.info?.buildingId);
const buildingText = computed(() => (hasBuilding.value ? '已绑定（见首页取餐点）' : '未绑定'));

const phoneValid = computed(() => /^1[3-9]\d{9}$/.test(phone.value.trim()));
const canSubmit = computed(
  () =>
    hasBuilding.value &&
    realName.value.trim().length > 0 &&
    phoneValid.value &&
    agreed.value &&
    !submitting.value,
);

const levelRules = computed(() =>
  LADDER.map((key) => {
    const meta = LEADER_LEVEL_META[key];
    return {
      key,
      name: `${meta.label}团长`,
      rate: meta.rate,
      condition:
        key === LeaderLevel.TRAINEE
          ? '提交申请即生效'
          : `月单 > ${meta.monthlyOrders} 且介绍 ${meta.referrals} 名转正团长`,
    };
  }),
);

/** 进页面刷新一次资料，确保 `buildingId` 是最新的（可能刚通过邀请链接绑定） */
async function refresh(): Promise<void> {
  try {
    const me = await run(() => fetchMe());
    userStore.setLogin(userStore.token, {
      id: me.id,
      nickname: me.nickname,
      avatarUrl: me.avatarUrl,
      phone: me.phone,
      buildingId: me.buildingId,
      teamLeaderId: me.teamLeaderId,
    });
  } catch (e) {
    toastApiError(e);
  }
}

function toggleAgree(): void {
  agreed.value = !agreed.value;
}

function openAgreement(): void {
  // 协议文本尚未由法务定稿（见《合规资质与协议清单》），先用弹窗摘要，避免放死链
  uni.showModal({
    title: '团长合作协议（摘要）',
    content:
      '1) 佣金按等级费率结算，由灵活用工平台代发代扣个税；\n' +
      '2) 见习团长 30 天内未促成订单自动取消资格；\n' +
      '3) 佣金以「实发份数」为基数计算；\n' +
      '4) 退出团长身份不影响已结算佣金。',
    showCancel: false,
    confirmText: '我知道了',
  });
}

async function submit(): Promise<void> {
  const buildingId = userStore.info?.buildingId;
  if (!buildingId) {
    uni.showToast({ title: '请先绑定办公楼', icon: 'none' });
    return;
  }

  submitting.value = true;
  try {
    // ⭐ M4-3：请求「团长申请确认」订阅授权（`leader_apply`）
    //
    // 位置刻意在**第一个 await 之前**：微信只允许在用户点击的**同步流程**里弹授权框，
    // 一旦先 await 了网络请求，手势窗口就关了（`fail can only be invoked by user
    // TAP gesture`）。模板清单由 `onLoad` 的 `preload()` 提前缓存好，故此处可同步调用。
    // 它**不阻塞**下面的申请 —— 授权失败照样申请成功（授权只影响「将来能不能收到通知」）。
    subscribe.requestFor(['leader_apply'], (results) => {
      console.log('[subscribe] leader_apply', results);
    });

    const res = await run(() =>
      applyLeader({
        buildingId,
        phone: phone.value.trim(),
        realName: realName.value.trim(),
        floor: floor.value.trim() || undefined,
        agreementVersion: AGREEMENT_VERSION,
      }),
    );

    // 身份立即生效：写 store 即写 `abox_is_leader`，底部导航随之变为 5 项
    leaderStore.setLeader({
      id: res.leader.id,
      realName: res.leader.realName,
      level: res.leader.level,
      commissionRate: res.leader.commissionRate,
      balance: res.leader.balance,
    });

    uni.showToast({ title: '已生效，团长入口已开启', icon: 'success', duration: 1600 });
    setTimeout(() => switchTab('/pages/mine/mine'), 900);
  } catch (e) {
    // 20007 已是团长 / 20004 手机号占用 / 10004 楼未开通 —— 均由服务端文案直达用户
    toastApiError(e);
  } finally {
    submitting.value = false;
  }
}

onLoad(() => {
  // 预加载订阅模板清单（**不在点击回调里拉** —— 见 `use-subscribe-message` 头注）
  void subscribe.preload();
  void refresh();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

.hero {
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;

  &__title {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__sub {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.section {
  margin-top: $space-5;

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }

  &__tag {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.card {
  padding: 0 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: $space-3 0;

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
  }
}

.form {
  padding: 0 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;
}

.field {
  padding: $space-3 0;
  border-bottom: 1px solid rgba(228, 216, 195, 0.5);

  &--last {
    border-bottom: none;
  }

  &__label {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__req {
    color: $c-warning;
  }

  &__input {
    margin-top: $space-2;
    font-size: $fs-body;
    color: $c-text;
  }

  &__placeholder {
    color: #c4b7a2;
  }
}

.rule {
  padding: $space-3 0;
  border-bottom: 1px solid rgba(228, 216, 195, 0.5);

  &:last-child {
    border-bottom: none;
  }

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__name {
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__rate {
    font-size: $fs-body;
    font-weight: 600;
    color: $c-gold;
  }

  &__cond {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.agree {
  display: flex;
  align-items: flex-start;

  &__box {
    flex: none;
    width: 36rpx;
    height: 36rpx;
    margin-top: 2rpx;
    line-height: 36rpx;
    text-align: center;
    background: $c-surface;
    border: 1px solid $c-border;
    border-radius: $radius-sm;

    &.is-checked {
      background: $c-gold;
      border-color: $c-gold;
    }
  }

  &__tick {
    font-size: 22rpx;
    color: #fffdf8;
  }

  &__text {
    flex: 1;
    margin-left: $space-2;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
  }

  &__link {
    color: $c-gold;
  }
}

.tip {
  margin-top: $space-2;
  padding: 0 $space-1;

  &__text {
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;

    &--warn {
      color: $c-warning;
    }
  }
}

.submit-bar {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  padding: $space-3 $space-4 calc(#{$space-3} + env(safe-area-inset-bottom));
  background: rgba(246, 240, 229, 0.96);
  border-top: 1px solid $c-border;
}

.btn {
  width: 100%;
  height: 88rpx;
  font-size: $fs-body;
  line-height: 88rpx;
  border-radius: $radius-pill;

  &--primary {
    color: #fffdf8;
    background: $c-text;
  }

  &--disabled {
    color: #fffdf8;
    background: #c4b7a2;
  }

  &--hover {
    opacity: 0.88;
  }
}
</style>
