<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP19（v4.10.0）：
         渐变大卡（分享给同事 + 链接 + 复制）→ 2 种分享方式 → 当前等级奖励
         （实装另保留：邀请码 / 小程序码 / 分享文案 / 我的推荐 —— 原型未画但都是已实装能力） -->

    <ab-loading v-if="loading && !material" text="正在加载分享物料" />

    <ab-empty-state
      v-else-if="!material"
      text="分享物料加载失败"
      hint="请稍后重试"
      illustration="warn-tri"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <!-- ① 渐变大卡 -->
      <view class="hero">
        <text class="abi abi-deco-40 hero__icon">{{ I.share }}</text>
        <text class="hero__title">分享给同事</text>
        <!-- ⚠️ 原文案是「顺手赚点零花钱」—— 属收益诱导表述（提审红线）。
             改中性：只讲场景便利，不承诺收益。 -->
        <text class="hero__sub">每天顺路帮同事带餐，省一趟跑腿</text>

        <view class="hero__link">
          <text class="hero__link-text">{{ shareLink }}</text>
        </view>

        <button class="hero__btn" hover-class="hero__btn--hover" @tap="copyLink">复制链接</button>
      </view>

      <!-- ② 2 种分享方式 -->
      <view class="card">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.share }}</text> 2 种分享方式</text
        >

        <view class="way" hover-class="way--hover" @tap="shareToWechat">
          <text class="abi abi-24 way__icon">{{ I.message }}</text>
          <view class="way__body">
            <text class="way__title">分享到微信群</text>
            <text class="way__sub">带邀请码，同事点开即绑定到你这栋楼</text>
          </view>
          <text class="way__arrow"
            ><text class="abi abi-16">{{ I.chev }}</text></text
          >
        </view>

        <view class="way" hover-class="way--hover" @tap="makeQrcode">
          <text class="abi abi-24 way__icon">{{ I.image }}</text>
          <view class="way__body">
            <text class="way__title">生成二维码海报</text>
            <text class="way__sub">保存相册后可贴群里 / 打在楼下</text>
          </view>
          <text class="way__arrow"
            ><text class="abi abi-16">{{ I.chev }}</text></text
          >
        </view>
      </view>

      <!-- ③ 当前等级奖励 -->
      <view class="card">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.gift }}</text> 当前等级奖励</text
        >

        <view class="reward">
          <text class="reward__level">{{ levelLabel }}团长</text>
          <text class="reward__rate">{{ ratePercent }}%</text>
          <!-- ⚠️ 原文案是「订单分佣（同事每订 1 单 = X% 进账）」——「分佣」「进账」
               都是收益诱导表述（提审红线）。改为中性陈述比例，不写成「每单赚多少」。 -->
          <text class="reward__desc">订单佣金比例 {{ ratePercent }}%（按实发份数计）</text>
        </view>

        <view class="rule">
          <text class="rule__text">
            <text class="abi abi-16">{{ I.info }}</text> 佣金按<text class="rule__strong"
              >实发份数</text
            >计佣：同事取餐确认后才计佣， 次日自动入账到你的余额。
          </text>
        </view>

        <!-- ⚠️ 原按钮名「推荐新团长」：既踩「发展下线」的表述红线，又与**实际行为不符**
             —— 它调的是 shareToWechat()，做的事是复制「拼饭群」邀请文案发给同事，
             与「招新团长」无关。改为与行为一致、且无发展人员含义的说法。 -->
        <button class="btn btn--gold" hover-class="btn--hover" @tap="shareToWechat">
          <text class="abi abi-20">{{ I.share }}</text> 邀请同事拼饭
        </button>
      </view>

      <!-- ④ 邀请码（原型未画，保留：线下口头传播的最短路径） -->
      <view class="card">
        <text class="card__title">我的邀请码</text>
        <text class="code">{{ material.inviteCode }}</text>
        <text class="card__desc">{{ material.desc }}</text>

        <view class="pair">
          <button class="btn btn--ghost" hover-class="btn--hover" @tap="copyCode">
            复制邀请码
          </button>
          <button class="btn btn--ghost" hover-class="btn--hover" @tap="copyCopy">复制文案</button>
        </view>
      </view>

      <!-- ⑤ 小程序码 -->
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
          此处不展示占位图片，以免与真实码混淆。
        </text>

        <button class="btn btn--ghost btn--block" hover-class="btn--hover" @tap="makeQrcode">
          {{ qrcode ? '重新生成' : '生成小程序码' }}
        </button>
      </view>

      <!-- ⑥ 我的推荐（L21） -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">我的推荐</text>
          <text class="card__count">
            共 {{ invites?.summary.totalCount ?? 0 }} 人 · 已转正
            {{ invites?.summary.formalCount ?? 0 }} 人
          </text>
        </view>

        <text class="inv__rule">
          晋级看两个条件：本月完成份数 +
          已转正人数（须同时满足）。被邀请人升到「正式」及以上才算转正。
        </text>

        <view v-if="!inviteList.length" class="inv__empty">
          <text class="inv__empty-text">还没有邀请记录</text>
          <text class="inv__empty-hint">把邀请码或小程序码发给同楼同事即可开始</text>
        </view>

        <view v-for="it in inviteList" :key="it.id" class="inv">
          <view class="inv__left">
            <text class="inv__name">{{ it.nickname }}</text>
            <text class="inv__time">
              {{ formatDateTime(it.bindAt) }} · {{ channelLabel(it.channel) }}
            </text>
          </view>
          <text class="inv__tag" :class="{ 'is-formal': it.isFormal }">
            {{ it.isFormal ? '已转正' : it.isLeader ? '见习中' : '未成为团长' }}
          </text>
        </view>

        <button
          v-if="invites?.hasMore"
          class="btn btn--ghost btn--block"
          hover-class="btn--hover"
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
 * ⭐ 版式基准 = prototype/index.html renderP19（v4.10.0）
 *
 * 数据来源：L2 `GET /leader/share` + L3 `POST /leader/share/qrcode` + L21 我的推荐。
 *
 * ⚠️ 邀请码是**确定性生成**的（`LDR` + 4 位零填充团长 id），与 U6 的 `leaderCode`
 *    同一套规则 —— 邀请落地页 P10 用它反查团长，端上不要自行拼装。
 * ⚠️ 微信「小程序码生成」能力**尚未接入**：服务端如实返回 `mock: true` 且 `qrcodeUrl: null`。
 *    端上**必须展示占位说明**，不得伪造一张图或复用 Logo 冒充真码（否则联调会误判已打通）。
 * ⚠️ 推荐列表**只回昵称**（§1.6 无手机号）；转正与否以服务端 `isFormal` 为准，
 *    端上不得用「是否已成为团长」代替「是否已转正」（见习不算转正）。
 * ⚠️ 原型大卡里的链接形如 `https://abox.com/leader/liming?b=guomao-3-A`，那是演示域名。
 *    实装显示**小程序内的真实跳转串**（`pages/index/index?leaderCode=LDRxxxx`）——
 *    我们没有 web 分享域名，编一个 https 链接会让团长复制出去打不开。
 */
import { computed, ref } from 'vue';
import { onShareAppMessage, onShow } from '@dcloudio/uni-app';
import { LEADER_LEVEL_META } from '@abox/shared-types';

import { fetchMyInvites, fetchShareMaterial, generateLeaderQrcode } from '@/api/leader';
import type {
  LeaderInvitesResult,
  LeaderInviteItem,
  LeaderQrcodeData,
  LeaderShareMaterialData,
} from '@/api/leader';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useLeaderStore } from '@/stores/leader';
import { formatDateTime } from '@/utils/format';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const { run, loading } = useRequest();
const leaderStore = useLeaderStore();

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

const levelLabel = computed(() =>
  leaderStore.info ? LEADER_LEVEL_META[leaderStore.info.level]?.label : '见习',
);
const ratePercent = computed(() => {
  const r = Number(leaderStore.info?.commissionRate ?? 0);
  return r ? (r * 100).toFixed(0) : '--';
});

/** 真实跳转串（见头注：不编造 https 域名） */
const shareLink = computed(() => {
  const m = material.value;
  return m ? `${m.path}?${m.shareQuery}` : '';
});

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

/**
 * 「分享到微信群」：小程序内会拉起转发面板（见 `onShareAppMessage`）；
 * H5 / 其它端没有转发能力 → 退化为「复制分享文案」，并如实说明，避免点了没反应。
 */
function shareToWechat(): void {
  const m = material.value;
  if (!m) return;
  uni.setClipboardData({ data: `${m.title}\n${m.desc}\n${shareLink.value}` });
  uni.showToast({
    title: '文案已复制，去微信群粘贴发送',
    icon: 'none',
    duration: 2400,
  });
}

function copyCode(): void {
  if (!material.value) return;
  uni.setClipboardData({ data: material.value.inviteCode });
}

function copyLink(): void {
  if (!shareLink.value) return;
  uni.setClipboardData({ data: shareLink.value });
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

// ---- ① 渐变大卡 ----
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 44rpx $space-4;
  background: linear-gradient(135deg, $c-gold, $c-gold-deep);
  border-radius: 36rpx;
  color: #ffffff;
  text-align: center;
  box-shadow: 0 10rpx 28rpx rgba(110, 84, 53, 0.18);

  &__icon {
    line-height: 1;
  }

  &__title {
    margin-top: $space-2;
    font-size: 38rpx;
    font-weight: bold;
  }

  &__sub {
    margin-top: $space-1;
    font-size: $fs-caption;
    opacity: 0.95;
  }

  &__link {
    width: 100%;
    margin-top: $space-4;
    padding: $space-2 $space-3;
    background: rgba(255, 255, 255, 0.2);
    border-radius: $radius-md;
  }

  &__link-text {
    font-size: 22rpx;
    line-height: 1.6;
    word-break: break-all;
  }

  &__btn {
    width: 60%;
    height: 72rpx;
    margin-top: $space-4;
    line-height: 72rpx;
    color: $c-text;
    font-size: $fs-body;
    font-weight: bold;
    background: rgba(255, 255, 255, 0.95);
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

// ---- 通用卡片 ----
.card {
  margin-top: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &--center {
    text-align: center;
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

  &__count {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__desc {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

// ---- ② 分享方式 ----
.way {
  display: flex;
  align-items: center;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

  &:last-child {
    border-bottom: none;
  }

  &--hover {
    opacity: 0.82;
  }

  &__icon {
    flex: none;
  }

  &__body {
    flex: 1;
    min-width: 0;
    margin-left: $space-3;
  }

  &__title {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__sub {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__arrow {
    flex: none;
    color: $c-text-weak;
  }
}

// ---- ③ 等级奖励 ----
.reward {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-2 0;

  &__level {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__rate {
    margin: $space-2 0;
    font-size: 72rpx;
    font-weight: bold;
    color: $c-gold-fg;
  }

  &__desc {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.rule {
  margin-top: $space-2;
  padding: $space-2 $space-3;
  background: $c-surface-3;
  border-radius: $radius-sm;

  &__text {
    font-size: 22rpx;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &__strong {
    font-weight: bold;
    color: $c-text;
  }
}

.code {
  display: block;
  margin: $space-2 0;
  font-size: 48rpx;
  font-weight: bold;
  letter-spacing: 4rpx;
  color: $c-gold-fg;
  text-align: center;
}

.qr {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 320rpx;
  margin: $space-2 0;
  padding: $space-3;
  background: $c-bg;
  border-radius: $radius-md;

  &__img {
    width: 320rpx;
    height: 320rpx;
  }

  &__ph {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  &__ph-text {
    font-size: $fs-body;
    color: $c-text-weak;
  }

  &__ph-hint {
    margin-top: $space-1;
    font-size: 22rpx;
    line-height: 1.6;
    color: $c-text-weak;
    text-align: center;
  }

  &__mock {
    display: block;
    font-size: 22rpx;
    line-height: 1.7;
    color: $c-text-weak;
    text-align: left;
  }
}

// ---- 推荐列表 ----
.inv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

  &:last-of-type {
    border-bottom: none;
  }

  &__rule {
    display: block;
    margin-bottom: $space-2;
    font-size: 22rpx;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &__empty {
    padding: $space-4 0;
    text-align: center;
  }

  &__empty-text {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__empty-hint {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__left {
    flex: 1;
    min-width: 0;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__time {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__tag {
    flex: none;
    margin-left: $space-3;
    padding: 4rpx $space-2;
    font-size: 22rpx;
    color: $c-text-weak;
    background: $c-bg;
    border-radius: $radius-sm;

    &.is-formal {
      color: $c-ok-fg;
      background: rgba(91, 124, 58, 0.12);
    }
  }
}

// ---- 按钮 ----
.pair {
  display: flex;
  margin-top: $space-2;
}

.btn {
  flex: 1;
  height: 72rpx;
  line-height: 72rpx;
  font-size: $fs-caption;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.88;
  }

  &--block {
    display: block;
    margin-top: $space-3;
  }

  &--gold {
    color: #ffffff;
    font-weight: bold;
    background: linear-gradient(135deg, $c-gold, $c-gold-deep);
    border: none;
  }

  &--ghost {
    color: $c-text;
    background: $c-surface;
    border: 1px solid $c-border;

    & + & {
      margin-left: $space-2;
    }
  }
}

.tips {
  display: block;
  margin-top: $space-3;
  font-size: 22rpx;
  line-height: 1.7;
  color: $c-text-weak;
  text-align: center;
}
</style>
