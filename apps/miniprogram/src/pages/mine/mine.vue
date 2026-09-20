<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP8（v4.10.0）：
         头像卡（昵称 + 跟随团长 + 余额/累计订单）→（团长身份横幅 或 申请引导）→
         （团长三入口）→ 常用菜单 -->

    <!-- 身份卡 -->
    <view class="profile">
      <view class="profile__avatar">
        <text class="profile__avatar-text">{{ initials }}</text>
      </view>
      <text class="profile__name">{{ nickname }}</text>
      <text class="profile__follow">{{ followText }}</text>

      <view class="stats">
        <view class="stats__item" hover-class="stats__item--hover" @tap="goBalance">
          <text class="stats__num stats__num--gold">{{ fenToYuanText(balanceFen) }}</text>
          <text class="stats__label">账户余额</text>
        </view>
        <view class="stats__item" hover-class="stats__item--hover" @tap="goOrders">
          <text class="stats__num">{{ orderCountText }}</text>
          <text class="stats__label">累计订单</text>
        </view>
      </view>
    </view>

    <!-- 团长身份横幅（L10 叠加身份：仅 isLeader=true 显示） -->
    <view
      v-if="leaderStore.isLeader"
      class="leader-card"
      hover-class="leader-card--hover"
      @tap="goWorkbench"
    >
      <view class="leader-card__hd">
        <view class="leader-card__crown">
          <text class="leader-card__crown-text">👑</text>
        </view>
        <view class="leader-card__main">
          <view class="leader-card__title-row">
            <text class="leader-card__title">我是团长</text>
            <text class="leader-card__level">{{ leaderStore.levelLabel }}</text>
          </view>
          <text class="leader-card__sub">{{ leaderSubText }}</text>
        </view>
        <text class="leader-card__chip">进入工作台 ›</text>
      </view>

      <view class="leader-card__grid">
        <view class="leader-card__cell">
          <text class="leader-card__cell-num">{{ monthCommissionText }}</text>
          <text class="leader-card__cell-label">本月佣金</text>
        </view>
        <view class="leader-card__cell">
          <text class="leader-card__cell-num">{{ pendingDeliverText }}</text>
          <text class="leader-card__cell-label">待分发</text>
        </view>
        <view class="leader-card__cell">
          <text class="leader-card__cell-num">{{ ratePercent }}</text>
          <text class="leader-card__cell-label">当前分佣</text>
        </view>
      </view>
    </view>

    <!-- 非团长：申请引导（C3 提交即生效） -->
    <view v-else class="apply" hover-class="apply--hover" @tap="goApply">
      <text class="apply__icon">👑</text>
      <view class="apply__main">
        <text class="apply__title">我也想成为团长</text>
        <text class="apply__sub">每天顺路帮忙带餐，8% - 12% 阶梯佣金</text>
      </view>
      <text class="apply__arrow">›</text>
    </view>

    <!-- 团长专属入口 -->
    <view v-if="leaderStore.isLeader" class="menu">
      <view class="menu__item" hover-class="menu__item--hover" @tap="goCommission">
        <text class="menu__label">💰 佣金中心（佣金余额 {{ fenToYuanText(balanceFen) }}）</text>
        <text class="menu__arrow">›</text>
      </view>
      <view class="menu__item" hover-class="menu__item--hover" @tap="goShare">
        <text class="menu__label">📤 分享中心 · 推广拉单</text>
        <text class="menu__arrow">›</text>
      </view>
      <view class="menu__item" hover-class="menu__item--hover" @tap="goLeaderProfile">
        <text class="menu__label">🏢 团长资料 · 绑定办公楼</text>
        <text class="menu__arrow">›</text>
      </view>
    </view>

    <!-- 常用 -->
    <view class="menu">
      <view class="menu__item" hover-class="menu__item--hover" @tap="goOrders">
        <text class="menu__label">📋 我的订单</text>
        <text class="menu__arrow">›</text>
      </view>
      <view class="menu__item" hover-class="menu__item--hover" @tap="goBalance">
        <text class="menu__label">💰 余额明细</text>
        <text class="menu__arrow">›</text>
      </view>
      <view class="menu__item" hover-class="menu__item--hover" @tap="tapSwitchLeader">
        <text class="menu__label">🏠 切换团长（绑定办公楼）</text>
        <text class="menu__arrow">›</text>
      </view>
      <view class="menu__item" hover-class="menu__item--hover" @tap="goSupport">
        <text class="menu__label">📞 客服微信号</text>
        <text class="menu__arrow">›</text>
      </view>
      <view class="menu__item" hover-class="menu__item--hover" @tap="showSettings">
        <text class="menu__label">⚙️ 设置</text>
        <text class="menu__arrow">›</text>
      </view>
    </view>

    <!-- 口径提示（沿用既有文案，只做归纳） -->
    <view class="tip">
      <text class="tip__text">
        C3：办公楼通过团长邀请链接绑定；App 不读取定位，也不索取手机号与地址（L9）。 退款 / 提现 /
        退出团长等需人工介入的事项，请添加客服微信处理。
      </text>
    </view>

    <!-- 联调（开发期保留：清空登录态用于验证「首次进入」链路） -->
    <view class="dev">
      <text class="dev__row" hover-class="dev__row--hover" @tap="clearLocal">清空本地登录态</text>
      <text class="dev__hint">
        本小程序为静默授权：清空后下次进入会自动重新登录同一账号（联调期固定 code）。
      </text>
    </view>

    <ab-bottom-bar active="mine" />
  </view>
</template>

<script setup lang="ts">
/**
 * P8 · 个人中心
 *
 * ⭐ 版式基准 = prototype/index.html renderP8（v4.10.0）
 *
 * ## 数据来源（全部服务端，端上不自造）
 *
 * | 展示项 | 来源 |
 * |--------|------|
 * | 昵称 / 跟随团长 / 办公楼 | A2 `GET /auth/me`（`leaderName` / `buildingName` · M5-10 新增派生字段） |
 * | 账户余额 | **U13** `GET /me/balance` |
 * | 累计订单 | U9 `GET /orders` 的 `total`（`pageSize:1` 只取总数） |
 * | 本月佣金 / 本月份数 | L10 `GET /leader/commissions?range=month` |
 * | 待分发 | L1 `GET /leader/workbench`（今日份数 − 已确认分发份数） |
 * | 当前分佣 | A2 `leader.commissionRate`（等级快照） |
 *
 * ⚠️ **账户余额 = 佣金余额**（同一个 `ab_balance`）：用户与团长共用同一身份，
 *    佣金既能提现也能抵餐费。故横幅里的「佣金余额」与头像卡的「账户余额」
 *    用的是**同一个数**、同一次请求 —— 写成两个来源必然分叉（#69 的形状）。
 *
 * ⚠️ 团长的三处附加数据（L10 / L1）**全部 best-effort**：任一失败只把对应
 *    数字显示成 `—`，不影响本页其余内容，也不弹多个 toast。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';

import { fetchMe } from '@/api/auth';
import type { MeResult } from '@/api/auth';
import { fetchOrders } from '@/api/order';
import { fetchMyBalance } from '@/api/user';
import { fetchCommissions } from '@/api/leader-finance';
import { fetchWorkbench } from '@/api/leader';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useLeaderStore } from '@/stores/leader';
import { fenToYuanText } from '@/utils/format';
import { useUserStore } from '@/stores/user';
import { clearAuthStorage } from '@/utils/storage';
import { navigateTo, switchTab } from '@/utils/router';
import { AGREEMENT_OPERATOR } from '@/constants/agreements';

const { run } = useRequest();
const userStore = useUserStore();
const leaderStore = useLeaderStore();

const me = ref<MeResult | null>(null);
const balanceFen = ref(0);
/** `null` = 还没取到（显示 — 而不是 0，「0 单」和「不知道」是两回事） */
const orderTotal = ref<number | null>(null);
const monthCommissionFen = ref<number | null>(null);
const monthQuantity = ref<number | null>(null);
const pendingDeliverQty = ref<number | null>(null);

/**
 * ⭐ M5-15 修复（**身份不一致第二条**）：**服务端快照优先**。
 *
 * 原写法 `userStore.info?.nickname || me.value?.nickname` 让**本地缓存**排在前面，
 * 而本地缓存是上一次登录时写下的（`abox_user`），可能已经过期：
 *   · 退出团长 / 后台改过昵称 → 服务端已变、本地还是旧值；
 *   · 换身份重新登录（`?devCode=`）→ 上一帧渲染的仍是上一个人的缓存。
 * `me` 是本次 A2（`GET /auth/me`）的**刚刚取回**的结果，权威性更高。
 * 本地缓存只在 A2 未返回（首帧 / 请求失败）时兜底。
 */
const nickname = computed(() => me.value?.nickname || userStore.info?.nickname || '微信用户');
const initials = computed(() => nickname.value.slice(0, 1));

/** 「跟随团长：李明 · 国贸三期 A 座」（任一缺失就退化成已有信息，不显示 null） */
const followText = computed(() => {
  const leader = me.value?.leaderName;
  const building = me.value?.buildingName;
  if (leader && building) return `跟随团长：${leader} · ${building}`;
  if (building) return `所属办公楼：${building}`;
  if (leader) return `跟随团长：${leader}`;
  return '未绑定办公楼';
});

const orderCountText = computed(() => (orderTotal.value === null ? '—' : String(orderTotal.value)));

const leaderSubText = computed(() => {
  const building = me.value?.buildingName ?? '未绑定办公楼';
  const qty = monthQuantity.value;
  return `${building} · 本月已促成 ${qty === null ? '—' : qty} 份`;
});

const monthCommissionText = computed(() =>
  monthCommissionFen.value === null ? '—' : fenToYuanText(monthCommissionFen.value),
);

const pendingDeliverText = computed(() =>
  pendingDeliverQty.value === null ? '—' : `${pendingDeliverQty.value} 份`,
);

const levelMeta = computed(() => LEADER_LEVEL_META[leaderStore.info?.level ?? LeaderLevel.TRAINEE]);

const ratePercent = computed(() => {
  const rate = leaderStore.info?.commissionRate
    ? Number(leaderStore.info.commissionRate)
    : levelMeta.value.rate;
  return `${(rate * 100).toFixed(0)}%`;
});

/** 头像卡 + 身份（A2），并刷新本地双身份 */
async function loadProfile(): Promise<void> {
  try {
    const res = await run(() => fetchMe());
    me.value = res;
    userStore.setLogin(userStore.token, {
      id: res.id,
      nickname: res.nickname,
      avatarUrl: res.avatarUrl,
      phone: res.phone,
      buildingId: res.buildingId,
      teamLeaderId: res.teamLeaderId,
    });
    if (res.isLeader && res.leader) {
      leaderStore.setLeader({
        id: res.leader.id,
        realName: res.leaderName,
        level: res.leader.level,
        commissionRate: res.leader.commissionRate,
        balance: res.leader.balance,
        balanceFen: res.leader.balanceFen,
        frozenFen: res.leader.frozenFen,
      });
    }
  } catch (e) {
    toastApiError(e);
  }
}

/** U13 余额（用户与团长同一账户） */
async function loadBalance(): Promise<void> {
  try {
    const res = await fetchMyBalance();
    balanceFen.value = res.balanceFen;
  } catch {
    // 静默：余额取不到时显示 0 会让用户以为钱没了，故失败保留上一值
  }
}

/** 累计订单数（只取 total） */
async function loadOrderTotal(): Promise<void> {
  try {
    const res = await fetchOrders({ page: 1, pageSize: 1 });
    orderTotal.value = res.total;
  } catch {
    orderTotal.value = null;
  }
}

/** 团长专属：本月佣金与份数（L10） */
async function loadMonthCommission(): Promise<void> {
  if (!leaderStore.isLeader) return;
  try {
    const res = await fetchCommissions({ range: 'month', page: 1, pageSize: 1 });
    monthCommissionFen.value = res.summary.netFen;
    monthQuantity.value = res.summary.quantity;
  } catch {
    monthCommissionFen.value = null;
    monthQuantity.value = null;
  }
}

/**
 * 团长专属：今日待分发份数（L1）
 *
 * ⚠️ 口径是**相减**不是取字段：`quantity` 是今日份数、`completedQuantity` 是
 *    已确认分发份数，两者之差才是「待分发」。服务端没有直接给这个数，故在此派生
 *    ——若哪天服务端直接下发，应改用服务端的值（派生值不落库，但也不该在端上重算）。
 */
async function loadPendingDeliver(): Promise<void> {
  if (!leaderStore.isLeader) return;
  try {
    const res = await fetchWorkbench();
    pendingDeliverQty.value = Math.max(0, res.today.quantity - res.today.completedQuantity);
  } catch {
    pendingDeliverQty.value = null;
  }
}

function goOrders(): void {
  switchTab('/pages/order-list/order-list');
}

function goBalance(): void {
  navigateTo('/pages/balance-detail/balance-detail');
}

function goApply(): void {
  navigateTo('/pages/leader-apply/leader-apply');
}

function goWorkbench(): void {
  navigateTo('/pages/leader/workbench');
}

function goCommission(): void {
  navigateTo('/pages/leader/commission');
}

function goShare(): void {
  navigateTo('/pages/leader/share');
}

function goLeaderProfile(): void {
  navigateTo('/pages/leader/profile');
}

function goSupport(): void {
  navigateTo('/pages/support/contact');
}

/** MVP 无「切换办公楼/团长」能力（进入方式 = 邀请链接绑定），如实告知 */
function tapSwitchLeader(): void {
  uni.showToast({ title: '更换楼栋请通过该楼团长邀请链接进入', icon: 'none', duration: 2400 });
}

/**
 * 设置（原型 P8 `showSettings` 弹窗）
 *
 * ⚠️ 原型里「设置」是**含可点条目的弹窗**，而 `uni.showModal` 只有两个按钮、装不下条目
 *    ⇒ 改用 `uni.showActionSheet` 承载同样四条（不在 S6 组件规格之前新增弹出层组件）。
 *
 * ⭐ **M5-18：用户协议 / 隐私政策从此可点** —— 走**原生页**
 *    `pages/agreement/agreement?type=user|privacy`，正文唯一真源在 `@/constants/agreements`。
 *    在此之前这两条**刻意不给可点入口**（正文没落地，点开就是假页面）；正文落地后该约束解除。
 *    一期**不设** `GET /me/agreements` 端点（见《接口规范》§1.8）。
 */
const SETTINGS_ACTIONS = ['平台客服微信号', '用户协议', '隐私政策', '关于 ABox 一盒'];

function showSettings(): void {
  uni.showActionSheet({
    itemList: SETTINGS_ACTIONS,
    success: ({ tapIndex }) => {
      if (tapIndex === 0) goSupport();
      else if (tapIndex === 1) goAgreement('user');
      else if (tapIndex === 2) goAgreement('privacy');
      else if (tapIndex === 3) showAbout();
    },
  });
}

/** 协议页（原生）。`type` 非法时由 `toAgreementType` 回退，端上不会白屏 */
function goAgreement(type: 'user' | 'privacy'): void {
  navigateTo(`/pages/agreement/agreement?type=${type}`);
}

/**
 * 关于
 * ⚠️ **不显示 App 版本号**：此前手写的 `v1.0.0` 与 `manifest.json` 的 `versionName: 0.1.0`
 *    **互相矛盾**（手写数字漂移）。端上取不到唯一真源时先不显示，不再制造第二处真相。
 */
function showAbout(): void {
  uni.showModal({
    title: '关于 ABox 一盒',
    content: `${AGREEMENT_OPERATOR}\n办公楼预定制团餐 · 一饭四菜自提`,
    showCancel: false,
    confirmText: '知道了',
  });
}

function clearLocal(): void {
  clearAuthStorage();
  userStore.clear();
  leaderStore.clear();
  uni.showToast({ title: '已清空，下次进入自动重新登录', icon: 'none', duration: 2200 });
}

onShow(() => {
  // ⚠️ 必须**先等 loadProfile 完成**再发其余取数，不能五个并发：
  // loadMonthCommission / loadPendingDeliver 以 `leaderStore.isLeader` 为闸门，
  // 而这个标志位正是 loadProfile 在回调里置位的 —— 并发时冷启动必然早退，
  // 「本月佣金 / 待分发」永远显示「—」（横幅是响应式的，随后又出现，更显得自相矛盾）。
  // loadProfile 自身经过请求层的 ensureToken，等它也顺带保证后续调用已有 token。
  void (async () => {
    await loadProfile();
    loadBalance();
    loadOrderTotal();
    loadMonthCommission();
    loadPendingDeliver();
  })();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-3 $space-4 200rpx;
  box-sizing: border-box;
}

// ---- 身份卡（居中） ----
.profile {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-5 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: 0 2rpx 8rpx rgba(110, 84, 53, 0.06);

  &__avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 128rpx;
    height: 128rpx;
    background: #efe5d0;
    border-radius: 50%;
  }

  &__avatar-text {
    font-size: 64rpx;
    color: $c-text;
  }

  &__name {
    margin-top: $space-3;
    font-size: $fs-h1;
    font-weight: bold;
    color: $c-text;
  }

  &__follow {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.stats {
  display: flex;
  margin-top: $space-4;

  &__item {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0 $space-5;

    &--hover {
      opacity: 0.8;
    }
  }

  &__num {
    font-size: 40rpx;
    font-weight: bold;
    color: $c-text;

    &--gold {
      color: #b8892f;
    }
  }

  &__label {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 团长身份横幅 ----
.leader-card {
  margin-top: $space-3;
  padding: $space-4;
  background: linear-gradient(135deg, $c-text, #b8892f);
  border-radius: $radius-lg;
  color: #ffffff;
  box-shadow: 0 8rpx 24rpx rgba(110, 84, 53, 0.22);

  &--hover {
    opacity: 0.92;
  }

  &__hd {
    display: flex;
    align-items: center;
    gap: $space-3;
  }

  &__crown {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100rpx;
    height: 100rpx;
    background: rgba(255, 255, 255, 0.18);
    border-radius: 50%;
  }

  &__crown-text {
    font-size: 52rpx;
    line-height: 1;
  }

  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  &__title-row {
    display: flex;
    align-items: center;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: bold;
  }

  &__level {
    margin-left: $space-2;
    padding: 0 $space-2;
    font-size: 20rpx;
    background: rgba(255, 255, 255, 0.2);
    border-radius: $radius-sm;
  }

  &__sub {
    margin-top: $space-1;
    font-size: $fs-caption;
    opacity: 0.92;
  }

  &__chip {
    flex: none;
    padding: 4rpx $space-2;
    font-size: $fs-caption;
    background: rgba(255, 255, 255, 0.2);
    border-radius: $radius-sm;
  }

  &__grid {
    display: flex;
    gap: $space-2;
    margin-top: $space-4;
  }

  &__cell {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: $space-3 0;
    background: rgba(255, 255, 255, 0.15);
    border-radius: $radius-sm;
  }

  &__cell-num {
    font-size: $fs-h2;
    font-weight: bold;
  }

  &__cell-label {
    margin-top: 2rpx;
    font-size: 20rpx;
    opacity: 0.88;
  }
}

// ---- 非团长申请引导 ----
.apply {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-top: $space-3;
  padding: $space-4;
  background: linear-gradient(135deg, #fff6e0, #ffeed5);
  border: 1px dashed $c-gold;
  border-radius: $radius-lg;

  &--hover {
    opacity: 0.9;
  }

  &__icon {
    font-size: 56rpx;
    line-height: 1;
  }

  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  &__title {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__sub {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__arrow {
    font-size: $fs-h1;
    color: $c-text-weak;
  }
}

// ---- 菜单列表 ----
.menu {
  margin-top: $space-3;
  padding: 0 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  overflow: hidden;

  &__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: $space-4 0;
    border-bottom: 1px solid rgba(228, 216, 195, 0.6);

    &:last-child {
      border-bottom: none;
    }

    &--hover {
      opacity: 0.85;
    }
  }

  &__label {
    font-size: $fs-body;
    color: $c-text;
  }

  &__arrow {
    font-size: $fs-h1;
    color: $c-text-weak;
  }
}

.tip {
  margin-top: $space-3;
  padding: 0 $space-1;

  &__text {
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

// ---- 联调区（开发期保留） ----
.dev {
  margin-top: $space-4;
  padding: 0 $space-1;

  &__row {
    display: block;
    font-size: $fs-caption;
    color: $c-warning;

    &--hover {
      opacity: 0.8;
    }
  }

  &__hint {
    display: block;
    margin-top: $space-1;
    font-size: 20rpx;
    line-height: 1.7;
    color: $c-text-weak;
  }
}
</style>
