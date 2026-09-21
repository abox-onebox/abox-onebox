<template>
  <view class="page">
    <ab-loading v-if="loading && !contact" text="正在加载客服信息" />

    <ab-empty-state
      v-else-if="!contact"
      text="客服信息加载失败"
      hint="请稍后重试"
      illustration="warn-tri"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <view class="hero">
        <text class="hero__title">联系客服</text>
        <text class="hero__sub">人工处理 · 添加客服微信即可</text>
      </view>

      <!-- 客服微信号（本页唯一的核心动作） -->
      <view class="card card--center">
        <text class="card__label">客服微信号</text>
        <text class="wxid">{{ contact.wechatId }}</text>

        <button class="btn" hover-class="btn--hover" @tap="copyWechat">复制微信号</button>
        <text class="hint"> 打开微信 → 点右上角「+」→ 添加朋友 → 粘贴搜索，即可添加客服 </text>

        <view v-if="contact.wechatQrcodeUrl" class="qr">
          <image class="qr__img" :src="contact.wechatQrcodeUrl" mode="aspectFit" />
          <text class="qr__hint">也可长按识别二维码添加</text>
        </view>
      </view>

      <!-- 服务时间与提示 -->
      <view class="card">
        <view class="row">
          <text class="row__k">服务时间</text>
          <text class="row__v">{{ contact.hours }}</text>
        </view>
        <view v-if="contact.phone" class="row">
          <text class="row__k">客服电话</text>
          <text class="row__v">{{ contact.phone }}</text>
        </view>
        <text class="note">{{ contact.tips }}</text>
      </view>

      <!-- 常见问题：都指向同一条人工通道，避免用户四处找入口 -->
      <view class="card">
        <text class="card__label">这些问题请找客服</text>
        <view v-for="item in faqs" :key="item" class="faq">
          <text class="faq__dot">·</text>
          <text class="faq__text">{{ item }}</text>
        </view>
      </view>

      <text class="foot">
        我们是人工客服：添加后请直接说明遇到的问题（附上订单号或截图），
        会尽快为你处理，不需要重复发送。
      </text>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * 联系客服（U17 · 客服微信号）
 *
 * ⚠️ 本页**不占用产品页面清单的 P 编号**（P1–P20 为小程序页面、P21+ 属供应商/后台 Web），
 *    它是「联系运营」类入口的**统一落地页**：一期不做在线客服，一律引导加客服微信人工处理。
 *
 * 数据来源：U17 `GET /me/support`。
 *
 * 【口径（2026-09-15 定）】一期**不做在线客服**，所有需要人工介入的事项
 * （退出团长、余额争议、提现异常、发票与协议）统一收敛到本页 ——
 * 用户手动添加客服微信，由运营**人工解决**。
 *
 * ⚠️ 微信号 / 电话 / 服务时间 / 提示文案**全部由服务端下发**（`ab_config.service.*`）；
 *    端上不硬编码任何联系方式，换号只需运营改配置。
 * ⚠️ `contact.wechatQrcodeUrl` 为空时**整块隐藏**（不占位、不伪造二维码图）。
 * ⚠️ 本页登录即可访问，**不要求团长身份** —— 已退出团长的用户同样需要这条通道。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchSupportContact } from '@/api/support';
import type { SupportContact } from '@/api/support';
import { toastApiError, useRequest } from '@/composables/use-request';

/** 常见问题清单（文案端上固定；答案统一为「加客服微信」） */
const faqs = [
  '退出团长身份（需先结清余额与在途提现）',
  '佣金提现异常 / 到账金额不符',
  '截单后的退款与代退进度',
  '发票、团长合作协议与资质相关',
];

const { run, loading } = useRequest();
const contact = ref<SupportContact | null>(null);

async function reload(): Promise<void> {
  try {
    contact.value = await run(() => fetchSupportContact());
  } catch (e) {
    toastApiError(e, '客服信息加载失败');
  }
}

function copyWechat(): void {
  if (!contact.value) return;
  uni.setClipboardData({
    data: contact.value.wechatId,
    success: () => {
      uni.showToast({ title: '微信号已复制，去微信添加', icon: 'none', duration: 2200 });
    },
  });
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

  &__title {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
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

  &--center {
    text-align: center;
  }

  &__label {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.wxid {
  display: block;
  margin: $space-3 0 $space-4;
  font-size: $fs-display;
  font-weight: 600;
  letter-spacing: 2rpx;
  color: $c-gold-fg;
  word-break: break-all;
}

.hint {
  display: block;
  margin-top: $space-3;
  font-size: $fs-caption;
  line-height: 1.7;
  color: $c-text-weak;
}

.qr {
  margin-top: $space-4;
  padding-top: $space-4;
  border-top: 1px solid rgba(228, 216, 195, 0.6);

  &__img {
    width: 320rpx;
    height: 320rpx;
    background: $c-bg;
    border-radius: $radius-sm;
  }

  &__hint {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.row {
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

.note {
  display: block;
  margin-top: $space-3;
  padding-top: $space-3;
  font-size: $fs-caption;
  line-height: 1.7;
  color: $c-text-weak;
  border-top: 1px solid rgba(228, 216, 195, 0.6);
}

.faq {
  display: flex;
  margin-top: $space-2;

  &__dot {
    flex: none;
    margin-right: $space-2;
    font-size: $fs-caption;
    color: $c-gold-fg;
  }

  &__text {
    flex: 1;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text;
  }
}

.foot {
  display: block;
  padding: 0 $space-1;
  font-size: $fs-caption;
  line-height: 1.8;
  color: $c-text-weak;
}

.btn {
  width: 100%;
  height: 80rpx;
  font-size: $fs-caption;
  line-height: 80rpx;
  color: $c-surface;
  background: $c-text;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.85;
  }
}
</style>
