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
        <text class="hero__sub">每天顺路帮同事带物，省一趟跑腿</text>

        <!-- ⭐ 原「复制链接」删掉：复制的是 `pages/leader-invite/...?leaderCode=` 这种
             小程序内部路径串，粘到微信聊天只是不可点击的纯文本，同事打不开。
             改为微信原生卡片转发（open-type=share），与主流做法一致。 -->
        <text class="hero__tip">转发小程序卡片给同事，点开即绑定到你这栋楼</text>
        <button class="hero__btn" open-type="share" hover-class="hero__btn--hover">
          转发卡片给同事
        </button>
      </view>

      <!-- ② 2 种分享方式 -->
      <view class="card">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.share }}</text> 2 种分享方式</text
        >

        <!-- ⭐ 卡片转发：open-type="share" 拉起微信转发面板，走 onShareAppMessage
             （标题/邀请码 path 已配好）。改为卡片而非复制文本——复制文本发出去是链接，
             与团长"分享给同事应是卡片"的预期不符。 -->
        <button class="way way--share" open-type="share" hover-class="way--hover">
          <text class="abi abi-24 way__icon">{{ I.message }}</text>
          <view class="way__body">
            <text class="way__title">转发卡片到微信群</text>
            <text class="way__sub">带邀请码，同事点开即绑定到你这栋楼</text>
          </view>
          <text class="way__arrow"
            ><text class="abi abi-16">{{ I.chev }}</text></text
          >
        </button>

        <view
          v-if="material && !material.mock"
          class="way"
          hover-class="way--hover"
          @tap="makePoster"
        >
          <text class="abi abi-24 way__icon">{{ I.image }}</text>
          <view class="way__body">
            <text class="way__title">生成二维码海报</text>
            <text class="way__sub">保存相册后可贴群里 / 发到朋友圈</text>
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
          <text class="reward__desc">订单佣金比例 {{ ratePercent }}%（按实发件数计）</text>
        </view>

        <view class="rule">
          <text class="rule__text">
            <text class="abi abi-16">{{ I.info }}</text> 佣金按<text class="rule__strong"
              >实发件数</text
            >计佣：同事取货确认后才计佣， 次日自动入账到你的余额。
          </text>
        </view>

        <!-- ⚠️ 原按钮名「推荐新团长」：既踩「发展下线」的表述红线，又与**实际行为不符**。
             改为「邀请同事拼团」+ 卡片转发（open-type=share），与行为一致、无发展人员含义。 -->
        <button class="btn btn--gold" open-type="share" hover-class="btn--hover">
          <text class="abi abi-20">{{ I.share }}</text> 转发卡片邀请同事
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

      <!-- ⑤ 小程序码（能力未接入时整块隐藏，不暴露未完成态文案） -->
      <view v-if="qrcode && !qrcode.mock" class="card card--center">
        <text class="card__title">小程序码</text>

        <view class="qr">
          <image v-if="qrImage" class="qr__img" :src="qrImage" mode="aspectFit" />
          <view v-else class="qr__ph">
            <text class="qr__ph-text">分享小程序码</text>
            <text class="qr__ph-hint">{{ qrcode?.tips || '可先复制邀请码或链接分享给同事' }}</text>
          </view>
        </view>

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
          晋级看两个条件：本月完成件数 +
          已转正人数（须同时满足）。被邀请人升到「正式」及以上才算转正。
        </text>

        <view v-if="!inviteList.length" class="inv__empty">
          <text class="inv__empty-text">还没有邀请记录</text>
          <text class="inv__empty-hint">把邀请码或小程序码发给同楼同事即可开始</text>
        </view>

        <view v-for="it in inviteList" :key="it.id" class="inv">
          <view class="inv__left">
            <!-- 昵称常为空（微信不返回），优先显示对方下单时填的取餐人称呼 -->
            <text class="inv__name">{{ displayOr(it.recipientName, it.nickname) }}</text>
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

    <!-- 海报画布（离屏合成；尺寸 750×1100，绘制后导出图片保存相册） -->
    <canvas id="posterCanvas" canvas-id="posterCanvas" class="poster-canvas" />
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
 * ✅ 小程序码 2026-11-20 已接入真微信 wxacode.getUnlimited：服务端返回真 `qrcodeUrl`
 *    且 `mock=false`。端上「生成二维码海报」调 L3 拿码图 → canvas 合成海报 → 保存相册。
 *    mock 模式（本地联调）下入口与卡片按 `:mock` 隐藏，不暴露未完成态。
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
import { displayOr, formatDateTime } from '@/utils/format';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';
import { C_BG, C_GOLD_BD, C_TEXT, C_TEXT_WEAK } from '@/constants/runtime-colors';

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
  } catch (e) {
    toastApiError(e, '生成小程序码失败');
  }
}

/**
 * 码图 base64 → 本地临时路径。
 * ⭐ 不下载网络 URL：当前小程序只配了 request 合法域名、未配 downloadFile 白名单，
 *    直接 downloadFile 会在真机失败。改用 FileSystemManager 写本地文件，不受域名约束。
 */
function writeQrcodeLocal(base64: string): string {
  // 与 leader/orders.vue 导出 CSV 同一范式：可选链取 env/fs，避免个别端无此能力时崩溃
  const uniLike = uni as unknown as {
    env?: { USER_DATA_PATH?: string };
    getFileSystemManager?: () => { writeFileSync: (p: string, d: string, e?: string) => void };
  };
  const dir = uniLike.env?.USER_DATA_PATH;
  const fs = uniLike.getFileSystemManager?.();
  if (!dir || !fs) throw new Error('当前环境不支持本地文件写入');
  const path = `${dir}/abox-qrcode-${Date.now()}.png`;
  fs.writeFileSync(path, base64, 'base64');
  return path;
}

/**
 * 生成并保存邀请海报：米色底 + 品牌标题 + 卖点 + 小程序码 + 邀请码。
 * 用 2d 旧接口（canvas-id）以兼容基础库；字号/配色沿用品牌规范。
 */
async function makePoster(): Promise<void> {
  if (!material.value) return;
  try {
    uni.showLoading({ title: '生成海报中…', mask: true });

    // 1. 确保拿到真码（复用已生成的码，否则重新取）
    let code = qrcode.value;
    if (!code) {
      code = await run(() => generateLeaderQrcode(430));
      qrcode.value = code;
      qrImage.value = code.qrcodeUrl ?? '';
    }
    if (!code.qrcodeBase64) throw new Error('小程序码暂不可用');
    const localQr = writeQrcodeLocal(code.qrcodeBase64);

    // 2. 离屏绘制（750×1100 设计稿坐标）
    const ctx = uni.createCanvasContext('posterCanvas');
    ctx.setFillStyle(C_BG);
    ctx.fillRect(0, 0, 750, 1100);

    ctx.setTextAlign('center');
    ctx.setFillStyle(C_TEXT);
    ctx.setFontSize(56);
    ctx.fillText('ABox 一盒', 375, 150);

    ctx.setFillStyle(C_TEXT_WEAK);
    ctx.setFontSize(30);
    ctx.fillText('次日送到工位 · ¥25.80 / 份', 375, 215);

    ctx.setStrokeStyle(C_GOLD_BD);
    ctx.setLineWidth(2);
    ctx.beginPath();
    ctx.moveTo(180, 260);
    ctx.lineTo(570, 260);
    ctx.stroke();

    // 码图居中（430→显示 380×380 留白）
    ctx.drawImage(localQr, 185, 310, 380, 380);

    ctx.setFillStyle(C_TEXT);
    ctx.setFontSize(28);
    ctx.fillText('长按识别 · 加入本楼团', 375, 740);

    ctx.setFillStyle(C_TEXT_WEAK);
    ctx.setFontSize(24);
    ctx.fillText(`邀请码 ${material.value.inviteCode}`, 375, 800);

    await new Promise<void>((resolve) => {
      ctx.draw(false, () => resolve());
    });

    // 3. 导出图片 → 保存相册
    const exportRes = await new Promise<{ tempFilePath: string }>((resolve, reject) => {
      uni.canvasToTempFilePath({
        canvasId: 'posterCanvas',
        success: resolve,
        fail: () => reject(new Error('海报导出失败')),
      });
    });

    const saveRes = await new Promise<void>((resolve, reject) => {
      uni.saveImageToPhotosAlbum({
        filePath: exportRes.tempFilePath,
        success: () => resolve(),
        fail: () => reject(new Error('SAVE_DENIED')),
      });
    });
    void saveRes;
    uni.showToast({ title: '海报已保存到相册', icon: 'success' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'SAVE_DENIED') {
      uni.showModal({
        title: '需要相册权限',
        content: '请在设置里允许保存到相册，才能把海报发出去。',
        confirmText: '去设置',
        success: (r) => {
          if (r.confirm) uni.openSetting();
        },
      });
    } else {
      toastApiError(e, '生成海报失败');
    }
  } finally {
    uni.hideLoading();
  }
}

function copyCode(): void {
  if (!material.value) return;
  uni.setClipboardData({ data: material.value.inviteCode });
}

function copyCopy(): void {
  if (!material.value) return;
  uni.setClipboardData({ data: `${material.value.title}\n${material.value.desc}` });
}

/**
 * 转发给好友 / 群：带上邀请码，落地页自动归属团长（C3 推荐关系）
 *
 * ⭐ imageUrl 用代码包内封面图（微信官方支持「代码包文件路径」，5:4 比例）：
 *    不设时微信默认截当前页（一串按钮列表），卡片又丑又单薄。
 *    图放 `src/static/share-cover.jpg`（uni 全量复制 static → 产物 /static/share-cover.jpg），
 *    专门生成、裁 5:4、无品牌字/水印、161KB，契合预包装食品定性。
 *    ⚠️ 不用网络 URL：避免依赖上传接口/域名，且提审无外部图片加载风险。
 */
const SHARE_COVER = '/static/share-cover.jpg';

onShareAppMessage(() => ({
  title: material.value?.title ?? 'ABox 一盒 · 本日精选 ¥25.80',
  path: material.value
    ? `${material.value.path}?${material.value.shareQuery}`
    : '/pages/index/index',
  imageUrl: SHARE_COVER,
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

  &__tip {
    margin-top: $space-4;
    font-size: $fs-caption;
    line-height: 1.6;
    opacity: 0.95;
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

  // open-type=share 必须是 button：清掉微信 button 默认边框/背景/圆角，
  // 让它和原来的 view 行外观一致（否则会出现一层灰色按钮底）。
  &--share {
    width: 100%;
    background: transparent;
    border: none; // 清微信 button 默认边框
    border-bottom: 1px dashed $c-border-strong; // 补回基础 .way 的分隔线（border:none 会清掉它）
    border-radius: 0;
    line-height: normal;
    font-size: inherit;
    text-align: left;

    &::after {
      border: none;
    }
  }

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

// 离屏海报画布：必须在渲染树内且非零尺寸，不能用 display:none（否则 canvas 绘制为空）
.poster-canvas {
  position: fixed;
  left: -9999rpx;
  top: 0;
  width: 750rpx;
  height: 1100rpx;
}
</style>
