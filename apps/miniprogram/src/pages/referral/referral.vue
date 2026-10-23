<template>
  <view class="page">
    <!-- Hero（轻量口径，与招募页一致：不写"爬楼/苦力"） -->
    <view class="hero">
      <text class="hero__kicker">ABox 一盒 · 推荐中心</text>
      <text class="hero__title">把链接发给合适的同事</text>
      <text class="hero__sub"
        >同事经你的专属链接申请成为团长、并转正后，你将获得推荐奖励（代金券或团长等级晋升）。顺手的事，多一份回馈。</text
      >
    </view>

    <!-- 专属码 + 落地链接（U-B3） -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">你的专属推荐</text>
        <text class="section__tag">非团长也能推荐</text>
      </view>

      <view class="code-card">
        <view class="code-row">
          <text class="code-row__label">推荐码</text>
          <text class="code-row__value">{{ referralCode || '—' }}</text>
        </view>
        <view class="code-row code-row--last">
          <text class="code-row__label">落地链接</text>
          <text class="code-row__value code-row__value--link">{{ referralLink || '—' }}</text>
        </view>
        <button class="copy-btn" hover-class="copy-btn--hover" @tap="copyLink">
          复制链接发给同事
        </button>
      </view>

      <view class="rule">
        <text class="rule__text"
          >朋友通过此链接申请成为团长 → 他转正（正式及以上）后 →
          你获得推荐奖励。奖励类型按你的身份自动判定：普通用户得代金券，在职团长计等级晋升（首席团长得代金券）。</text
        >
      </view>
    </view>

    <!-- 我的推荐列表（与 L21 同形：昵称 + 状态） -->
    <view v-if="!loading && list.length" class="section">
      <view class="section__hd">
        <text class="section__title">我推荐的人</text>
        <text class="section__tag">共 {{ totalCount }} 人 · 已转正 {{ formalCount }} 人</text>
      </view>

      <view class="list">
        <view v-for="item in list" :key="item.id" class="item">
          <view class="item__main">
            <text class="item__name">{{ item.nickname }}</text>
            <text class="item__sub">
              {{ item.isLeader ? '已申请团长' : '尚未申请' }} · 绑定 {{ formatBind(item.bindAt) }}
            </text>
          </view>
          <text class="item__status" :class="statusClass(item)">{{ statusText(item) }}</text>
        </view>
      </view>
    </view>

    <!-- 空态 -->
    <view v-else-if="!loading && !list.length" class="empty">
      <text class="empty__text">还没有人通过你的链接申请。把上面的链接发到同事群试试。</text>
    </view>

    <!-- 加载中 -->
    <view v-else-if="loading" class="empty">
      <text class="empty__text">加载中…</text>
    </view>

    <view class="foot">
      <text class="foot__text"
        >推荐奖励为单层（不抽其下线）。奖励归属以申请时携带的推荐码为准，绑定后不可变更。</text
      >
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 推荐中心（U-B3 · 2026-10-23 补）
 *
 * ## 定位
 * 面向**任意登录用户**（含非团长）：展示自己的 USR 推荐码 + 落地链接，
 * 并列出「我推荐且已申请 / 已转正」的人。这是「非团长可推荐」在端上的唯一落点。
 *
 * ## 与团长「分享中心 / 我的推荐」的区别
 *   · 团长侧 `pages/leader/share` + `pages/leader/.../invites` 面向**在职团长**，
 *     记录 `inviter_leader_id` 维度的裂变（驱动晋级），挂 `LeaderGuard`；
 *   · 本页面向**普通用户**（也可被已是团长的人访问，但展示的是 `inviter_user_id` 维度），
 *     记录非团长推荐的裂变，不挂 LeaderGuard。
 *
 * ## 口径
 *   · 端点 `GET /me/referral` 由 `useRequest().run` 包一层——未登录会自动静默登录；
 *   · 列表出参与 L21 `LeaderInvitesResult` 同形（只回昵称，不回手机号，§1.6）。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchReferral, type LeaderInviteItem } from '@/api/leader';
import { toastApiError, useRequest } from '@/composables/use-request';

const { run } = useRequest();

const referralCode = ref('');
const referralLink = ref('');
const list = ref<LeaderInviteItem[]>([]);
const totalCount = ref(0);
const formalCount = ref(0);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    // ⚠️ run() 内部已 `ensureLogin()`：未登录用户点进本页会先静默登录，再拉数据。
    const res = await run(() => fetchReferral());
    referralCode.value = res.referralCode;
    referralLink.value = res.referralLink;
    list.value = res.list.list;
    // 汇总取服务端**全量**统计（不受分页影响），与 L21 同一约定
    totalCount.value = res.list.summary.totalCount;
    formalCount.value = res.list.summary.formalCount;
  } catch (e) {
    toastApiError(e);
  } finally {
    loading.value = false;
  }
}

function copyLink(): void {
  if (!referralLink.value) return;
  uni.setClipboardData({
    data: referralLink.value,
    success: () => uni.showToast({ title: '链接已复制', icon: 'success' }),
    fail: () => uni.showToast({ title: '复制失败，请手动长按', icon: 'none' }),
  });
}

function formatBind(iso: string): string {
  if (!iso) return '—';
  // ISO 形如 2026-10-23T08:30:00.000Z（UTC）；取日期部分即可（端上只展示绑定日）
  return iso.slice(0, 10);
}

function statusText(item: LeaderInviteItem): string {
  if (item.isFormal) return '已转正';
  if (item.isLeader) return '已申请·见习';
  return '未申请';
}

function statusClass(item: LeaderInviteItem): string {
  if (item.isFormal) return 'item__status--done';
  if (item.isLeader) return 'item__status--pending';
  return 'item__status--idle';
}

onShow(() => {
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

// ---- Hero ----
.hero {
  padding: $space-5 $space-4;
  background: linear-gradient(150deg, $c-text 0%, $c-gold-deep 100%);
  border-radius: $radius-lg;
  color: $c-surface;

  &__kicker {
    display: block;
    font-size: $fs-caption;
    letter-spacing: 3rpx;
    opacity: 0.85;
  }

  &__title {
    display: block;
    margin-top: $space-2;
    font-size: $fs-h1;
    font-weight: bold;
    line-height: 1.4;
    letter-spacing: 1rpx;
  }

  &__sub {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.9;
    opacity: 0.95;
  }
}

// ---- 章节通用 ----
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
    font-weight: bold;
    color: $c-text;
    border-left: 4rpx solid $c-gold-deep;
    padding-left: $space-2;
  }

  &__tag {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 推荐码卡片 ----
.code-card {
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;
}

.code-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-2 0;
  border-bottom: 1px dashed $c-border-strong;

  &--last {
    border-bottom: none;
  }

  &__label {
    flex: none;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    flex: 1;
    margin-left: $space-3;
    text-align: right;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;

    &--link {
      font-size: $fs-caption;
      font-weight: normal;
      color: $c-text-weak;
      word-break: break-all;
    }
  }
}

.copy-btn {
  width: 100%;
  height: 84rpx;
  margin-top: $space-3;
  font-size: $fs-body;
  font-weight: bold;
  line-height: 84rpx;
  color: $c-surface;
  background: linear-gradient(135deg, $c-text 0%, $c-gold-deep 100%);
  border: none;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    filter: brightness(1.06);
  }
}

.rule {
  margin-top: $space-2;
  padding: $space-2 $space-3;
  font-size: $fs-caption;
  line-height: 1.85;
  color: $c-text-weak;
  background: $c-gold-bg;
  border-radius: $radius-sm;
}

// ---- 推荐列表 ----
.list {
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;
  overflow: hidden;
}

.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 $space-4;
  border-bottom: 1px dashed $c-border-strong;

  &:last-child {
    border-bottom: none;
  }

  &__main {
    flex: 1;
    min-width: 0;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__sub {
    display: block;
    margin-top: 2rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__status {
    flex: none;
    margin-left: $space-2;
    padding: 4rpx 16rpx;
    font-size: $fs-caption;
    border-radius: 999rpx;

    &--done {
      color: $c-surface;
      background: $c-gold-fg;
    }

    &--pending {
      color: $c-text;
      background: $c-gold-bg;
    }

    &--idle {
      color: $c-text-weak;
      background: $c-surface-2;
    }
  }
}

// ---- 空态 / 加载 ----
.empty {
  margin-top: $space-4;
  padding: $space-4;
  text-align: center;
  background: $c-surface;
  border: 1px dashed $c-border;
  border-radius: $radius-md;

  &__text {
    font-size: $fs-caption;
    line-height: 1.8;
    color: $c-text-weak;
  }
}

.foot {
  margin-top: $space-3;
  padding: 0 $space-2;

  &__text {
    font-size: $fs-caption;
    line-height: 1.8;
    color: $c-text-weak;
  }
}
</style>
