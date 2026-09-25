<template>
  <view class="page">
    <!-- 标题区：协议名 + 版本 / 更新日期（审核会看「页面是否已上线、是否标版本」） -->
    <view class="hd">
      <text class="hd__title">{{ doc.title }}</text>
      <text class="hd__meta">版本 {{ doc.version }} · 更新于 {{ doc.updatedAt }}</text>
    </view>

    <!-- 草案提示条：由 AGREEMENT_DRAFT 驱动，法务定稿置 false 后自动消失 -->
    <view v-if="AGREEMENT_DRAFT" class="draft">
      <text class="draft__text">
        本文为草案，尚在法务审定中；如与最终版本不一致，以最终版本为准。
      </text>
    </view>

    <!-- 正文 -->
    <view class="body">
      <text v-for="(p, pi) in doc.preamble" :key="`p${pi}`" class="body__p">{{ p }}</text>

      <view v-for="(sec, si) in doc.sections" :key="`s${si}`" class="sec">
        <text class="sec__heading">{{ sec.heading }}</text>

        <text v-for="(p, pi) in sec.paragraphs || []" :key="`sp${pi}`" class="body__p">
          {{ p }}
        </text>

        <view v-for="(item, ii) in sec.items || []" :key="`si${ii}`" class="item">
          <text class="item__mark">{{ sec.ordered ? `${ii + 1}.` : '·' }}</text>
          <text class="item__text">{{ item }}</text>
        </view>
      </view>
    </view>

    <!-- 联系方式：一律走客服页，**不在此硬编码微信号 / 电话**（换号只需运营改配置） -->
    <view class="foot">
      <text class="foot__text"
        >如对本文有疑问，可在「我的 → 设置 →
        账号注销」自助注销账号；其他查询、更正等权利可通过客服与我们联系。</text
      >
      <button class="foot__btn" hover-class="foot__btn--hover" @tap="goSupport">联系客服</button>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 协议阅读页（用户协议 / 隐私政策）
 *
 * ## 为什么是原生页而不是 web-view
 *
 * ⚠️ 本页**刻意不用 `<web-view>`**：web-view 需要「业务域名」白名单 + 域名 ICP 备案 + HTTPS +
 *    域名根目录校验文件，而域名正是当前 M5 的外部阻塞项 —— 走 web-view 等于把**提审**绑在一个
 *    还没到位的外部条件上，且审核期域名不通会直接不通过。协议正文是静态文本，原生渲染零依赖。
 *    （原目录名 `pages/webview/` 是本页从脚手架占位页继承来的，M5-18 已改名 `pages/agreement/`。）
 *
 * ## 数据来源
 *
 * | 展示项 | 来源 |
 * |--------|------|
 * | 正文 / 版本 / 更新日期 / 草案标志 | `@/constants/agreements`（**唯一真源**，端上零网络请求） |
 * | 路由参数 `type` | `user` \| `privacy`；非法值回退 `user`（`toAgreementType`） |
 *
 * ⚠️ 本页**免登录可读** —— 协议必须在用户同意之前就能读到，不能挂在登录态后面。
 * ⚠️ 联系方式**不写进正文、也不写进本页**：只给一个跳客服页的按钮（既有口径：端上不硬编码联系方式）。
 */
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import {
  AGREEMENT_DOCS,
  AGREEMENT_DRAFT,
  toAgreementType,
  type AgreementDoc,
} from '@/constants/agreements';
import { navigateTo, pageQuery } from '@/utils/router';

const doc = ref<AgreementDoc>(AGREEMENT_DOCS.user);

onLoad((options) => {
  const type = toAgreementType(pageQuery(options as Record<string, unknown>, 'type'));
  doc.value = AGREEMENT_DOCS[type];
  uni.setNavigationBarTitle({ title: doc.value.title });
});

function goSupport(): void {
  navigateTo('/pages/support/contact');
}
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 120rpx;
  box-sizing: border-box;
}

.hd {
  padding: $space-3 $space-1 $space-4;

  &__title {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__meta {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.draft {
  margin-bottom: $space-4;
  padding: $space-3 $space-4;
  background: $c-surface;
  border-left: 4rpx solid $c-warning;
  border-radius: $radius-sm;

  &__text {
    display: block;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-warn-fg;
  }
}

.body {
  &__p {
    display: block;
    margin-bottom: $space-3;
    font-size: $fs-body;
    line-height: 1.8;
    color: $c-text;
  }
}

.sec {
  margin-top: $space-5;

  &__heading {
    display: block;
    margin-bottom: $space-3;
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }
}

.item {
  display: flex;
  margin-bottom: $space-2;

  &__mark {
    flex: none;
    width: 36rpx;
    font-size: $fs-body;
    line-height: 1.8;
    color: $c-gold-fg;
  }

  &__text {
    flex: 1;
    font-size: $fs-body;
    line-height: 1.8;
    color: $c-text;
  }
}

.foot {
  margin-top: $space-5;
  padding-top: $space-4;
  border-top: 1px solid $c-border;

  &__text {
    display: block;
    margin-bottom: $space-3;
    font-size: $fs-caption;
    line-height: 1.8;
    color: $c-text-weak;
  }

  &__btn {
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
}
</style>
