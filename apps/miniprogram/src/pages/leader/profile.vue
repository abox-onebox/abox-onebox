<template>
  <view class="page">
    <ab-loading v-if="loading && !profile" text="正在加载团长资料" />

    <ab-empty-state
      v-else-if="!profile"
      text="资料加载失败"
      hint="请稍后重试"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <!-- 头部 -->
      <view class="hero">
        <text class="hero__name">{{ profile.realName }}</text>
        <view class="hero__tags">
          <text class="hero__tag">{{ profile.levelLabel }}</text>
          <text class="hero__tag hero__tag--gold">
            {{ (Number(profile.commissionRate) * 100).toFixed(0) }}%
          </text>
        </view>
        <text class="hero__sub">
          {{ displayOr(profile.buildingName) }} · {{ displayOr(profile.floor, '未设楼层') }}
        </text>
      </view>

      <!-- 等级规则与晋级进度 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">佣金等级</text>
          <text class="card__sub">C2 · 双条件晋级</text>
        </view>

        <view v-for="lv in rules?.levels ?? []" :key="lv.key" class="lv">
          <view class="lv__left">
            <text class="lv__name" :class="{ 'is-mine': lv.key === profile.level }">
              {{ lv.name }}
            </text>
            <text class="lv__cond">{{ lv.condition }}</text>
          </view>
          <text class="lv__rate">{{ (lv.rate * 100).toFixed(0) }}%</text>
        </view>

        <view v-if="rules?.mine" class="progress">
          <text class="progress__text">
            本月 {{ rules.mine.monthOrders }} 单 · 已介绍转正 {{ rules.mine.invitedFormalCount }} 人
            <text v-if="rules.mine.nextLevel"> · 下一级 {{ nextLevelLabel }}</text>
            <text v-else> · 已是最高等级</text>
          </text>
          <text v-if="rules.expireRule" class="progress__rule">{{ rules.expireRule }}</text>
        </view>
      </view>

      <!-- 资料编辑 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">资料修改</text>
        </view>

        <view class="field">
          <text class="field__label">当前手机号</text>
          <text class="field__input">{{ maskPhone(profile.phone) }}</text>
        </view>

        <view class="field">
          <text class="field__label">新手机号</text>
          <input
            v-model="form.phone"
            class="field__input"
            type="number"
            maxlength="11"
            placeholder="不修改请留空"
            placeholder-class="field__ph"
          />
        </view>

        <view class="field">
          <text class="field__label">当前楼层</text>
          <text class="field__input">{{ displayOr(profile.floor, '未设置') }}</text>
        </view>

        <view class="field">
          <text class="field__label">新楼层</text>
          <input
            v-model="form.floor"
            class="field__input"
            type="text"
            maxlength="32"
            placeholder="不修改请留空，如 12F"
            placeholder-class="field__ph"
          />
        </view>

        <text class="card__note">
          办公楼变更需运营审核，本期不开放端上修改（传 buildingId 会被服务端拒绝）
        </text>

        <button class="btn" hover-class="btn--hover" @tap="saveProfile">保存资料</button>
      </view>

      <!-- 收款方式（L12 提现前置条件） -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">收款方式</text>
          <text class="card__badge">{{ profile.payoutBound ? '已绑定' : '未绑定' }}</text>
        </view>

        <view class="field">
          <text class="field__label">类型</text>
          <view class="picks">
            <view
              v-for="t in payoutTypes"
              :key="t.value"
              class="picks__item"
              :class="{ 'is-active': form.payoutType === t.value }"
              @tap="form.payoutType = t.value"
            >
              <text class="picks__label">{{ t.label }}</text>
            </view>
          </view>
        </view>

        <view class="field">
          <text class="field__label">账号</text>
          <input
            v-model="form.payoutAccount"
            class="field__input"
            type="text"
            maxlength="64"
            :placeholder="profile.payoutBound ? '重新录入完整账号' : '银行卡号 / 支付宝账号'"
            placeholder-class="field__ph"
          />
        </view>

        <view class="field">
          <text class="field__label">收款人</text>
          <input
            v-model="form.payoutName"
            class="field__input"
            type="text"
            maxlength="32"
            :placeholder="profile.payoutName || '与账号实名一致'"
            placeholder-class="field__ph"
          />
        </view>

        <text class="card__note">
          账号在服务端脱敏存储，回显为 6217****0123 形态；佣金经灵活用工平台代发代扣
        </text>

        <button class="btn" hover-class="btn--hover" @tap="savePayout">保存收款方式</button>
      </view>

      <!-- 协议 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">团长合作协议</text>
          <text class="card__sub">{{ displayOr(profile.agreeVersion, '未签署') }}</text>
        </view>
        <text class="card__note"> 签署时间：{{ formatDateTime(profile.agreedAt) }} </text>
        <button class="btn btn--ghost" hover-class="btn--hover" @tap="resign">重新签署 v1.1</button>
      </view>

      <!-- 联系客服（一期统一走客服微信，人工解决） -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">联系客服</text>
          <text class="card__sub">人工处理</text>
        </view>
        <text class="card__note">
          退出团长、余额与提现争议、代退进度等，都请添加客服微信由运营人工处理。
        </text>
        <button class="btn btn--ghost" hover-class="btn--hover" @tap="goSupport">
          查看客服微信号
        </button>
      </view>

      <!-- 退出 -->
      <view class="card card--danger">
        <view class="card__hd">
          <text class="card__title">退出团长身份</text>
        </view>
        <text class="card__note">
          退出后不再展示团长入口，历史佣金与订单记录仍保留，
          日后仍可重新提交申请（重新从见习等级开始）。
        </text>
        <text class="card__note">
          ⚠️ 退出前需先结清资金：可用余额与冻结额须为 ¥0.00，
          且不能有处理中的提现或待结算佣金。不满足时服务端会逐条告知原因。
        </text>

        <!-- 阻碍明细（服务端 20008 的 data.blockers，逐条引导） -->
        <view v-if="quitBlockers.length" class="blockers">
          <text class="blockers__title">暂不能退出：</text>
          <view v-for="b in quitBlockers" :key="b.code" class="blockers__item">
            <text class="blockers__dot">·</text>
            <text class="blockers__text">{{ b.text }}</text>
          </view>
          <text class="blockers__hint">
            请先在「提现」页结清余额并等待到账，或联系客服协助处理。
          </text>
        </view>

        <button
          class="btn btn--ghost btn--danger"
          hover-class="btn--hover"
          :disabled="quitting"
          @tap="confirmQuit"
        >
          {{ quitting ? '处理中…' : '退出团长身份' }}
        </button>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P20 · 团长资料（含退出团长身份）
 *
 * 数据来源：L14 资料 / L15 修改 / L16 等级规则 / L18 协议重签 / **L20 退出**。
 *
 * ⚠️ 手机号展示用 `maskPhone` 兜一层（§1.6）：即便服务端返回明文（本人数据），
 *    端上也不在「非导出场景」展示完整号，避免截图泄露。
 * ⚠️ L15 的 DTO 刻意**不含 `buildingId`**，且服务端 `forbidNonWhitelisted: true` ——
 *    只提交发生变化的字段，不要整表回传。
 * ⚠️ 收款方式 `payoutAccount` 服务端**落库前脱敏**，故回显值带 `****`，属预期；
 *    再次修改时需**完整重新录入**（脱敏值不能再作为账号提交）。
 *
 * 【L20 退出（2026-09-15 补）】语义 = **停职保留档案**：`status` 置 2、清空
 * `ab_user.team_leader_id`，但订单/佣金/推荐关系全留，日后可重新申请。
 *   · 服务端有**资金闸门**：余额/冻结未清零、有在途提现、有待结算佣金 → `20008`，
 *     明细在 `error.payload.blockers`，本页逐条展示（不吞掉后端解释）。
 *   · 幂等键**必传**：同一个「退出意图」复用同一个 key；成功后本页清 `isLeader`
 *     并回到底部 4 项的普通用户视图。
 *   · 失败后**沿用旧 key** 重试（服务端失败即释放占位键，同键可立即重试）。
 * ⚠️ 退出团长属人工可介入事项，本页同时提供「联系客服」入口（U17 · 客服微信号）。
 */
import { reactive, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { LEADER_LEVEL_META } from '@abox/shared-types';
import type { LeaderLevel } from '@abox/shared-types';

import {
  fetchLeaderProfile,
  fetchLevelRules,
  quitLeader,
  signAgreement,
  updateLeaderProfile,
} from '@/api/leader';
import type { LevelRulesResult, LeaderProfile, PayoutType, QuitBlocker } from '@/api/leader';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useLeaderStore } from '@/stores/leader';
import { displayOr, formatDateTime, maskPhone, uuid } from '@/utils/format';
import { navigateTo, switchTab } from '@/utils/router';

const payoutTypes: Array<{ label: string; value: PayoutType }> = [
  { label: '银行卡', value: 'bank' },
  { label: '支付宝', value: 'alipay' },
];

const { run, loading } = useRequest();
const leaderStore = useLeaderStore();

const profile = ref<LeaderProfile | null>(null);
const rules = ref<LevelRulesResult | null>(null);

const form = reactive({
  phone: '',
  floor: '',
  payoutType: 'bank' as PayoutType,
  payoutAccount: '',
  payoutName: '',
});

const nextLevelLabel = ref('');

/** L20 退出：提交中标记 + 服务端返回的阻碍明细 */
const quitting = ref(false);
const quitBlockers = ref<QuitBlocker[]>([]);

/** 当前「退出意图」的幂等键：失败重试沿用，成功后作废 */
let quitKey = '';

async function reload(): Promise<void> {
  try {
    const [p, r] = await Promise.all([
      run(() => fetchLeaderProfile()),
      run(() => fetchLevelRules()),
    ]);
    profile.value = p;
    rules.value = r;
    form.payoutType = p.payoutType ?? 'bank';
    nextLevelLabel.value = r.mine.nextLevel
      ? (LEADER_LEVEL_META[r.mine.nextLevel as LeaderLevel]?.label ?? r.mine.nextLevel)
      : '';
  } catch (e) {
    toastApiError(e, '团长资料加载失败');
  }
}

/** 只提交填写了的字段（避免用空值覆盖服务端已有资料） */
async function saveProfile(): Promise<void> {
  const payload: { phone?: string; floor?: string } = {};
  if (form.phone.trim()) payload.phone = form.phone.trim();
  if (form.floor.trim()) payload.floor = form.floor.trim();

  if (!payload.phone && !payload.floor) {
    uni.showToast({ title: '请先填写要修改的内容', icon: 'none' });
    return;
  }
  if (payload.phone && !/^1[3-9]\d{9}$/.test(payload.phone)) {
    uni.showToast({ title: '手机号格式不正确', icon: 'none' });
    return;
  }

  try {
    profile.value = await run(() => updateLeaderProfile(payload));
    form.phone = '';
    form.floor = '';
    uni.showToast({ title: '已保存', icon: 'none' });
  } catch (e) {
    toastApiError(e, '保存失败');
  }
}

async function savePayout(): Promise<void> {
  const account = form.payoutAccount.trim();
  const name = form.payoutName.trim();
  if (!account || account.length < 4) {
    uni.showToast({ title: '请填写完整收款账号', icon: 'none' });
    return;
  }

  try {
    profile.value = await run(() =>
      updateLeaderProfile({
        payoutType: form.payoutType,
        payoutAccount: account,
        payoutName: name || undefined,
      }),
    );
    form.payoutAccount = '';
    form.payoutName = '';
    uni.showToast({ title: '收款方式已保存', icon: 'none' });
  } catch (e) {
    toastApiError(e, '保存失败');
  }
}

async function resign(): Promise<void> {
  try {
    await run(() => signAgreement('v1.1'));
    await reload();
    uni.showToast({ title: '已签署 v1.1', icon: 'none' });
  } catch (e) {
    toastApiError(e, '签署失败');
  }
}

/** 去客服页（U17 · 客服微信号）—— 退出/资金争议的人工通道 */
function goSupport(): void {
  navigateTo('/pages/support/contact');
}

/**
 * L20 · 退出团长身份（二次确认 → 提交 → 清本地身份回到 4 项视图）
 *
 * 错误分支全部按「服务端说了算」处理：
 *   · `20008` → 取 `payload.blockers` 逐条展示（退出阻碍，本页就地引导）
 *   · 其余    → 走统一 toast
 */
function confirmQuit(): void {
  quitBlockers.value = [];
  uni.showModal({
    title: '确认退出团长身份？',
    content:
      '退出后底部将不再展示团长入口，你需要先在「提现」页结清全部余额。历史订单与佣金记录会保留。',
    confirmText: '确认退出',
    confirmColor: '#C44536',
    success: (res) => {
      if (res.confirm) void doQuit();
    },
  });
}

async function doQuit(): Promise<void> {
  if (quitting.value) return;
  if (!quitKey) quitKey = uuid(); // 失败沿用同一 key；服务端失败会释放占位键，可立即重试

  quitting.value = true;
  try {
    await run(() => quitLeader({ reason: '用户端主动退出' }, quitKey));
    quitKey = ''; // 成功即作废，避免下一次操作被回放成同一结果
    leaderStore.clear(); // isLeader=false → 底栏重渲染回 4 项
    uni.showToast({ title: '已退出团长身份', icon: 'none', duration: 2000 });
    setTimeout(() => switchTab('/pages/index/index'), 900);
  } catch (e) {
    if (e instanceof ApiError && e.code === 20008) {
      const payload = e.payload as { blockers?: QuitBlocker[] } | null;
      quitBlockers.value = payload?.blockers ?? [];
      uni.showToast({ title: '暂不能退出，请先看下方原因', icon: 'none', duration: 2400 });
      return;
    }
    toastApiError(e, '退出失败，请稍后重试');
  } finally {
    quitting.value = false;
  }
}

onShow(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 120rpx;
  box-sizing: border-box;
}

.hero {
  padding: $space-3 $space-1 $space-5;

  &__name {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__tags {
    margin-top: $space-3;
  }

  &__tag {
    display: inline-block;
    margin-right: $space-2;
    padding: 2rpx $space-2;
    font-size: $fs-caption;
    color: $c-text;
    background: rgba(201, 168, 118, 0.2);
    border-radius: $radius-sm;

    &--gold {
      color: $c-gold;
      background: rgba(201, 168, 118, 0.14);
    }
  }

  &__sub {
    display: block;
    margin-top: $space-3;
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

  &--danger {
    border-color: rgba(196, 69, 54, 0.3);
  }

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__sub {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__badge {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__note {
    display: block;
    margin-bottom: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.lv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: $space-2 0;
  border-bottom: 1px solid rgba(228, 216, 195, 0.5);

  &:last-of-type {
    border-bottom: none;
  }

  &__left {
    flex: 1;
  }

  &__name {
    display: block;
    font-size: $fs-caption;
    color: $c-text;

    &.is-mine {
      font-weight: 600;
      color: $c-gold;
    }
  }

  &__cond {
    display: block;
    margin-top: 2rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__rate {
    flex: none;
    margin-left: $space-3;
    font-size: $fs-body;
    color: $c-text;
  }
}

.progress {
  margin-top: $space-3;
  padding-top: $space-3;
  border-top: 1px solid rgba(228, 216, 195, 0.6);

  &__text {
    display: block;
    font-size: $fs-caption;
    color: $c-text;
  }

  &__rule {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.field {
  display: flex;
  align-items: center;
  padding: $space-3 0;
  border-bottom: 1px solid rgba(228, 216, 195, 0.5);

  &:last-of-type {
    border-bottom: none;
  }

  &__label {
    flex: none;
    width: 140rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__input {
    flex: 1;
    height: 60rpx;
    font-size: $fs-caption;
    color: $c-text;
  }

  &__ph {
    color: $c-text-weak;
  }
}

.picks {
  display: flex;
  gap: $space-2;

  &__item {
    padding: $space-1 $space-3;
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

.btn {
  width: 100%;
  height: 80rpx;
  margin-top: $space-2;
  font-size: $fs-caption;
  line-height: 80rpx;
  color: $c-surface;
  background: $c-text;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--ghost {
    color: $c-text;
    background: transparent;
    border: 1px solid $c-border;
  }

  /* 退出这类破坏性动作：描边用暖红，与「保存」等常规按钮区分 */
  &--danger {
    color: $c-warning;
    border-color: rgba(196, 69, 54, 0.4);
  }

  &--hover {
    opacity: 0.85;
  }
}

.blockers {
  margin-bottom: $space-3;
  padding: $space-3;
  background: rgba(196, 69, 54, 0.06);
  border: 1px solid rgba(196, 69, 54, 0.2);
  border-radius: $radius-sm;

  &__title {
    display: block;
    font-size: $fs-caption;
    font-weight: 600;
    color: $c-warning;
  }

  &__item {
    display: flex;
    margin-top: $space-2;
  }

  &__dot {
    flex: none;
    margin-right: $space-2;
    font-size: $fs-caption;
    color: $c-warning;
  }

  &__text {
    flex: 1;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text;
  }

  &__hint {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}
</style>
