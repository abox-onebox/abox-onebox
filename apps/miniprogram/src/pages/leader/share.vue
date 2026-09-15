<template>
  <view class="page">
    <ab-loading v-if="loading && !material" text="正在加载分享物料" />

    <ab-empty-state
      v-else-if="!material"
      text="分享物料加载失败"
      hint="请稍后重试"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <!-- 邀请码 -->
      <view class="card">
        <text class="card__title">我的邀请码</text>
        <text class="code">{{ material.inviteCode }}</text>
        <text class="card__desc">{{ material.desc }}</text>

        <view class="acts">
          <button class="acts__btn" hover-class="acts__btn--hover" @tap="copyCode">
            复制邀请码
          </button>
          <button class="acts__btn acts__btn--ghost" hover-class="acts__btn--hover" @tap="copyLink">
            复制分享链接
          </button>
        </view>
      </view>

      <!-- 小程序码 -->
      <view class="card card--center">
        <text class="card__title">小程序码</text>

        <view class="qr">
          <image v-if="qrImage" class="qr__img" :src="qrImage" mode="aspectFit" />
          <view v-else class="qr__ph">
            <text class="qr__ph-text">小程序码待接入</text>
            <text class="qr__ph-hint">{{ qrcode?.tips || '微信码能力接入后自动展示' }}</text>
          </view>
        </view>

        <text v-if="qrcode?.mock" class="qr__mock">
          当前为模拟态（scene = {{ qrcode.scene }}）：微信小程序码生成能力尚未接入，
          此处不展示占位图片，以免与真实码混淆
        </text>

        <button
          class="acts__btn acts__btn--ghost acts__btn--full"
          hover-class="acts__btn--hover"
          @tap="makeQrcode"
        >
          {{ qrcode ? '重新生成' : '生成小程序码' }}
        </button>
      </view>

      <!-- 分享文案 -->
      <view class="card">
        <text class="card__title">分享文案</text>
        <text class="copy__title">{{ material.title }}</text>
        <text class="copy__desc">{{ material.desc }}</text>
        <button
          class="acts__btn acts__btn--ghost acts__btn--full"
          hover-class="acts__btn--hover"
          @tap="copyCopy"
        >
          复制文案
        </button>
      </view>

      <!-- 我的推荐（L21 · 推荐裂变与晋级审计的可见面） -->
      <view class="card">
        <view class="inv__hd">
          <text class="card__title">我的推荐</text>
          <text class="inv__sum">
            共 {{ invites?.summary.totalCount ?? 0 }} 人 · 已转正
            {{ invites?.summary.formalCount ?? 0 }} 人
          </text>
        </view>

        <text class="inv__rule">
          晋级看两个条件：本月完成份数 + 已转正人数（须同时满足）。被邀请人升到「正式」及以上
          才算转正。
        </text>

        <view v-if="!inviteList.length" class="inv__empty">
          <text class="inv__empty-text">还没有邀请记录</text>
          <text class="inv__empty-hint">把邀请码或小程序码发给同楼同事即可开始</text>
        </view>

        <view v-for="it in inviteList" :key="it.id" class="inv">
          <view class="inv__left">
            <text class="inv__name">{{ it.nickname }}</text>
            <text class="inv__time"
              >{{ formatDateTime(it.bindAt) }} · {{ channelLabel(it.channel) }}</text
            >
          </view>
          <text class="inv__tag" :class="{ 'is-formal': it.isFormal }">
            {{ it.isFormal ? '已转正' : it.isLeader ? '见习中' : '未成为团长' }}
          </text>
        </view>

        <button
          v-if="invites?.hasMore"
          class="acts__btn acts__btn--ghost acts__btn--full"
          hover-class="acts__btn--hover"
          :disabled="loadingMore"
          @tap="loadMoreInvites"
        >
          {{ loadingMore ? '加载中…' : '加载更多' }}
        </button>
      </view>

      <text class="tips">{{ material.tips }}</text>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P19 · 分享中心
 *
 * 数据来源：L2 `GET /leader/share` + L3 `POST /leader/share/qrcode` + **L21 我的推荐**。
 *
 * ⚠️ 邀请码是**确定性生成**的（`LDR` + 4 位零填充团长 id），与 U6 的 `leaderCode`
 *    同一套规则 —— 邀请落地页 P10 用它反查团长，端上不要自行拼装。
 * ⚠️ 微信「小程序码生成」能力**尚未接入**：服务端如实返回 `mock: true` 且 `qrcodeUrl: null`。
 *    端上**必须展示占位说明**，不得伪造一张图或复用 Logo 冒充真码（否则联调会误判已打通）。
 * ⚠️ 推荐列表**只回昵称**（§1.6 无手机号）；转正与否以服务端 `isFormal` 为准，
 *    端上不得用「是否已成为团长」代替「是否已转正」（见习不算转正）。
 */
import { ref } from 'vue';
import { onShareAppMessage, onShow } from '@dcloudio/uni-app';

import { fetchMyInvites, fetchShareMaterial, generateLeaderQrcode } from '@/api/leader';
import type {
  LeaderInvitesResult,
  LeaderInviteItem,
  LeaderQrcodeData,
  LeaderShareMaterialData,
} from '@/api/leader';
import { toastApiError, useRequest } from '@/composables/use-request';
import { formatDateTime } from '@/utils/format';

const { run, loading } = useRequest();

const material = ref<LeaderShareMaterialData | null>(null);
const qrcode = ref<LeaderQrcodeData | null>(null);

/** L21 我的推荐（分页累积） */
const invites = ref<LeaderInvitesResult | null>(null);
const inviteList = ref<LeaderInviteItem[]>([]);
const loadingMore = ref(false);

/** 服务端未接入微信能力时为 null —— 用 v-if 守住，绝不给 image 传假 URL */
const qrImage = ref('');

const CHANNEL_LABEL: Record<string, string> = {
  link: '链接邀请',
  qrcode: '小程序码',
  poster: '海报',
  self: '自荐',
};

function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel;
}

async function reload(): Promise<void> {
  try {
    material.value = await run(() => fetchShareMaterial());
  } catch (e) {
    toastApiError(e, '分享物料加载失败');
  }
  await loadInvites(1);
}

/** 拉第 1 页（reload）或追加下一页（加载更多） */
async function loadInvites(page: number): Promise<void> {
  loadingMore.value = true;
  try {
    const res = await run(() => fetchMyInvites(page, 20));
    invites.value = res;
    inviteList.value = page === 1 ? res.list : [...inviteList.value, ...res.list];
  } catch {
    if (page === 1) {
      invites.value = null;
      inviteList.value = [];
    }
  } finally {
    loadingMore.value = false;
  }
}

function loadMoreInvites(): void {
  if (!invites.value) return;
  void loadInvites(invites.value.page + 1);
}

async function makeQrcode(): Promise<void> {
  try {
    const res = await run(() => generateLeaderQrcode(430));
    qrcode.value = res;
    qrImage.value = res.qrcodeUrl ?? '';
    if (!res.qrcodeUrl) {
      uni.showToast({ title: '微信码能力未接入，已展示占位说明', icon: 'none', duration: 2400 });
    }
  } catch (e) {
    toastApiError(e, '生成小程序码失败');
  }
}

function copyCode(): void {
  if (!material.value) return;
  uni.setClipboardData({ data: material.value.inviteCode });
}

function copyLink(): void {
  if (!material.value) return;
  const { path, shareQuery } = material.value;
  uni.setClipboardData({ data: `${path}?${shareQuery}` });
}

function copyCopy(): void {
  if (!material.value) return;
  uni.setClipboardData({ data: `${material.value.title}\n${material.value.desc}` });
}

/** 转发给好友 / 群：带上邀请码，落地页自动归属团长（C3 推荐关系） */
onShareAppMessage(() => ({
  title: material.value?.title ?? 'ABox 一盒 · 一饭四菜 ¥25.80',
  path: material.value
    ? `${material.value.path}?${material.value.shareQuery}`
    : '/pages/index/index',
}));

onShow(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4;
  box-sizing: border-box;
}

.card {
  margin-bottom: $space-4;
  padding: $space-5 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &--center {
    text-align: center;
  }

  &__title {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__desc {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.code {
  display: block;
  margin-top: $space-3;
  font-size: $fs-display;
  font-weight: 600;
  letter-spacing: 4rpx;
  color: $c-text;
}

.acts {
  display: flex;
  gap: $space-3;
  margin-top: $space-4;

  &__btn {
    flex: 1;
    height: 76rpx;
    font-size: $fs-caption;
    line-height: 76rpx;
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

    &--full {
      width: 100%;
      margin-top: $space-4;
    }

    &--hover {
      opacity: 0.85;
    }
  }
}

.qr {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 360rpx;
  height: 360rpx;
  margin: $space-4 auto 0;
  background: rgba(228, 216, 195, 0.25);
  border: 1px dashed $c-border;
  border-radius: $radius-md;

  &__img {
    width: 100%;
    height: 100%;
  }

  &__ph {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0 $space-4;
  }

  &__ph-text {
    font-size: $fs-body;
    color: $c-text-weak;
  }

  &__ph-hint {
    margin-top: $space-2;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
    text-align: center;
  }

  &__mock {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-warning;
    text-align: left;
  }
}

.copy {
  &__title {
    display: block;
    margin-top: $space-3;
    font-size: $fs-body;
    color: $c-text;
  }

  &__desc {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.tips {
  display: block;
  font-size: $fs-caption;
  line-height: 1.7;
  color: $c-text-weak;
}

/* ---- L21 我的推荐 ---- */
.inv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px solid rgba(228, 216, 195, 0.5);

  &:last-of-type {
    border-bottom: none;
  }

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__sum {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__rule {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &__left {
    flex: 1;
    min-width: 0;
  }

  &__name {
    display: block;
    font-size: $fs-caption;
    color: $c-text;
  }

  &__time {
    display: block;
    margin-top: 2rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__tag {
    flex: none;
    margin-left: $space-3;
    padding: 2rpx $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
    background: rgba(228, 216, 195, 0.4);
    border-radius: $radius-sm;

    &.is-formal {
      color: $c-success;
      background: rgba(91, 124, 58, 0.12);
    }
  }

  &__empty {
    padding: $space-4 0;
    text-align: center;
  }

  &__empty-text {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__empty-hint {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}
</style>
