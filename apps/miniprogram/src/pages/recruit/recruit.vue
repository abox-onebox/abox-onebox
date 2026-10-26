<template>
  <view class="page">
    <!-- ⭐ 版式基准 = 设计定稿 `_ABox一盒·成为团长招募页(集中版)/cards.html`（卡片版 · 22:34 轮定版保留）：
         安静页眉（不喊）→ 三张浮起卡（钱 / 事 / 人）→ 双 CTA（语义互斥）→ 推荐券说明。
         旧长版（渐变 Hero + 四档阶梯 + 严选厨房）按用户裁定弃用。 -->

    <!-- 页眉：安静地呈，不喊 -->
    <view class="head">
      <text class="head__eyebrow">ABox 一盒 · 团长招募</text>
      <view class="head__title">
        <text>好事做了，顺手带了</text>
        <text class="head__em">钱也赚了</text>
      </view>
      <view class="head__line" />
      <text class="head__meta">每天一次 · 不用费事 · 大家都省心</text>
    </view>

    <!-- 三张浮起卡 -->
    <view class="cards">
      <view class="card">
        <view class="card__hd">
          <text class="card__no">01</text>
          <text class="card__t">钱，明明白白</text>
        </view>
        <view class="card__rule" />
        <view class="card__list">
          <text class="card__li"
            >每单按售价提 <text class="hl">{{ rateMin }}% – {{ rateMax }}%</text></text
          >
          <text class="card__li">次日入账，<text class="b">能抵消费，也能提现</text></text>
          <text class="card__li">每月<text class="b">好几百</text>，饭钱就有了</text>
        </view>
      </view>

      <view class="card">
        <view class="card__hd">
          <text class="card__no">02</text>
          <text class="card__t">事，不添麻烦</text>
        </view>
        <view class="card__rule" />
        <view class="card__list">
          <text class="card__li">下班以后，<text class="b">转发个链接</text></text>
          <text class="card__li">同事点开，<text class="hl">就进你的团</text></text>
          <text class="card__li">午休时间，<text class="b">顺手带回来</text></text>
        </view>
      </view>

      <view class="card">
        <view class="card__hd">
          <text class="card__no">03</text>
          <text class="card__t">人，记你的好</text>
        </view>
        <view class="card__rule" />
        <view class="card__list">
          <text class="card__li">热心肠，<text class="b">有了名分</text></text>
          <text class="card__li">你的单，<text class="b">同事乐意跟</text></text>
          <text class="card__li">好人缘，<text class="b">一次次的加深</text></text>
        </view>
      </view>
    </view>

    <!-- CTA（一屏一义：两枚语义互斥按钮） -->
    <view class="cta">
      <button class="cta__btn" hover-class="cta__btn--hover" @tap="goApply">申请成为团长</button>
      <button class="cta__btn cta__btn--ghost" hover-class="cta__btn--hover" @tap="goInvite">
        介绍给合适的同事
      </button>
      <!-- 推荐奖励真源：invite.service markFormal() 转正钩子发 5 元/30 天券（文案与实现同源） -->
      <text class="cta__note"
        >自己暂时不当也行——介绍他成为团长，你领 <text class="b">5 元代金券</text></text
      >
    </view>

    <view class="foot">
      <text class="foot__text"
        >申请即代表同意《团长协议》。佣金按售价按单计提；介绍奖励为单层代金券，非分销抽成。</text
      >
    </view>

    <ab-bottom-bar active="recruit" />
  </view>
</template>

<script setup lang="ts">
/**
 * 招募页（卡片版 · 2026-10-24 按设计定稿重写，替换 10-23 长版）
 *
 * ## 版式基准
 * `_ABox一盒·成为团长招募页(集中版)/cards.html`（卡片版 · 22:34 轮定版保留）。
 * 结构：安静页眉 → 三张浮起卡（钱/事/人）→ 双 CTA → 推荐券说明 → 底部栏。
 *
 * ## 文案铁律（见项目 MEMORY · 招募页口径）
 * ① 收益一律中性语（"每单按售价提 X%"），量级按个人顺手算（每月好几百）；
 * ② 交付口径 = 轻（转发链接 / 顺手带回来），禁"逐层爬楼 / 苦力活"；
 * ③ CTA 一屏一义："申请成为团长"整页只出现一次，路径 A/B 语义互斥；
 * ④ 介绍奖励 = 单层代金券（真源 `invite.service.markFormal()` 发 5 元/30 天券），非分销。
 *
 * ## 数据单源
 * 佣金区间 {{ rateMin }}–{{ rateMax }}% 取自 `LEADER_LEVEL_META`（见习/首席），
 * 不写死——后端调档只改 shared-types，本页自动跟随。
 */
import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';
import { navigateTo } from '@/utils/router';

const rateMin = Math.round(LEADER_LEVEL_META[LeaderLevel.TRAINEE].rate * 100);
const rateMax = Math.round(LEADER_LEVEL_META[LeaderLevel.CHIEF].rate * 100);

function goApply(): void {
  navigateTo('/pages/leader-apply/leader-apply');
}

function goInvite(): void {
  navigateTo('/pages/referral/referral');
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: 0 $space-4 200rpx;
  box-sizing: border-box;
}

// ---- 页眉：安静地呈，不喊 ----
.head {
  padding: 88rpx $space-2 16rpx;
  text-align: center;

  &__eyebrow {
    font-size: $fs-micro;
    letter-spacing: 6rpx;
    color: $c-gold-fg;
  }

  &__title {
    margin-top: 32rpx;
    font-size: 52rpx;
    font-weight: bold;
    letter-spacing: 4rpx;
    line-height: 1.5;
    color: $c-text;
  }

  &__em {
    display: block;
    margin-top: 12rpx;
    color: $c-gold-deep;
  }

  &__line {
    margin: 28rpx auto 0;
    width: 72rpx;
    height: 4rpx;
    background: $c-gold;
    border-radius: 4rpx;
  }

  &__meta {
    display: block;
    margin-top: 32rpx;
    font-size: $fs-caption;
    letter-spacing: 4rpx;
    color: $c-text-weak;
  }
}

// ---- 三张浮起卡 ----
.cards {
  margin-top: $space-4;
  display: flex;
  flex-direction: column;
  gap: 28rpx;
}

.card {
  padding: 40rpx 40rpx 36rpx;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;
  box-shadow:
    0 2rpx 4rpx rgba(110, 84, 53, 0.05),
    0 8rpx 28rpx rgba(110, 84, 53, 0.08);

  &__hd {
    display: flex;
    align-items: baseline;
    gap: 20rpx;
  }

  &__no {
    font-size: 26rpx;
    font-weight: bold;
    letter-spacing: 2rpx;
    color: $c-gold-fg;
  }

  &__t {
    font-size: 32rpx;
    font-weight: bold;
    letter-spacing: 4rpx;
    color: $c-text;
  }

  &__rule {
    margin-top: 28rpx;
    height: 1px;
    background: $c-border;
  }

  &__list {
    margin-top: 28rpx;
    display: flex;
    flex-direction: column;
    gap: 18rpx;
  }

  &__li {
    font-size: $fs-body;
    line-height: 1.5;
    letter-spacing: 1rpx;
    color: $c-text-weak;
  }

  // 列表内强调：b=正文棕加重 / hl=金棕高亮（定稿口径）
  .b {
    color: $c-text;
    font-weight: bold;
  }

  .hl {
    color: $c-gold-fg;
    font-weight: bold;
  }
}

// ---- CTA（两枚互斥按钮）----
.cta {
  margin-top: $space-5;

  &__btn {
    width: 100%;
    height: 96rpx;
    line-height: 96rpx;
    text-align: center;
    font-size: $fs-body;
    font-weight: bold;
    letter-spacing: 4rpx;
    color: $c-surface;
    background: $c-text;
    border: none;
    border-radius: $radius-pill;
    box-shadow:
      0 2rpx 4rpx rgba(110, 84, 53, 0.05),
      0 8rpx 28rpx rgba(110, 84, 53, 0.08);

    &::after {
      border: none;
    }

    &--ghost {
      margin-top: 24rpx;
      color: $c-gold-fg;
      background: transparent;
      border: 1px solid $c-gold;
      box-shadow: none;
    }

    &--hover {
      filter: brightness(1.06);
    }
  }

  &__note {
    display: block;
    margin-top: 24rpx;
    text-align: center;
    font-size: $fs-caption;
    line-height: 1.8;
    color: $c-text-weak;

    .b {
      color: $c-gold-fg;
      font-weight: bold;
    }
  }
}

// ---- 合规脚注 ----
.foot {
  margin-top: $space-4;
  padding: 0 $space-2;

  &__text {
    font-size: $fs-caption;
    line-height: 1.8;
    color: $c-text-weak;
  }
}
</style>
