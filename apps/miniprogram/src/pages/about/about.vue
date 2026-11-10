<template>
  <view class="page">
    <view class="hd">
      <text class="hd__title">关于 ABox 一盒</text>
      <text class="hd__sub">{{ operator }}</text>
      <text class="hd__desc">办公楼预定制团体组合 · 由团长送到工位</text>
    </view>

    <view v-if="loading && !block" class="state">
      <text class="state__text">正在读取公示信息…</text>
    </view>

    <template v-else-if="block">
      <view class="card">
        <text class="card__title">经营者信息</text>
        <text class="card__hint">依据 124 号令第二十条持续公示</text>

        <view class="row">
          <text class="row__k">经营者名称</text>
          <text class="row__v">{{ text(block.filing.subjectName) }}</text>
        </view>
        <view class="row">
          <text class="row__k">经营场所地址</text>
          <text class="row__v">{{ text(block.filing.businessAddress) }}</text>
        </view>
        <view class="row">
          <text class="row__k">统一社会信用代码</text>
          <text class="row__v">{{ text(block.filing.creditCode) }}</text>
        </view>
        <view class="row">
          <text class="row__k">经营范围</text>
          <text class="row__v">{{ text(block.filing.businessScope) }}</text>
        </view>
        <view class="row">
          <text class="row__k">备案编号</text>
          <text class="row__v" :class="{ 'row__v--pending': !block.filing.filingNo }">
            {{ block.filing.filingNo || '待补录' }}
          </text>
        </view>
        <view class="row">
          <text class="row__k">备案日期</text>
          <text class="row__v">{{ text(block.filing.filingDate) }}</text>
        </view>
      </view>

      <view class="card">
        <text class="card__title">预包装食品标签信息</text>
        <text class="card__hint">销售页面须展示以下字段，具体值以盒内单品实物标签为准</text>
        <view class="tags">
          <text v-for="field in block.labelFields" :key="field" class="tags__item">{{
            field
          }}</text>
        </view>
      </view>

      <view class="note">
        <text class="note__text">{{ block.note }}</text>
      </view>
    </template>

    <view v-else class="state">
      <text class="state__text">公示信息暂时无法读取，请稍后重试</text>
      <button class="state__btn" hover-class="state__btn--hover" @tap="load">重新加载</button>
    </view>

    <view class="foot">
      <text class="foot__text">如需查验营业执照原件或有其他疑问，可通过客服与我们联系。</text>
      <button class="foot__btn" hover-class="foot__btn--hover" @tap="goSupport">联系客服</button>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 关于我们 + 124 号令资质与标签公示（原生页）
 *
 * ## 为什么放在这里
 * 用户 2026-11-10 裁定：入口走「我的 → 关于我们」，**首页一个像素都不动**。
 * 本页同时承接原「设置 → 关于 ABox 一盒」弹窗的两行介绍，信息不丢。
 *
 * ## 数据来源（端上零硬编码）
 * `GET /ai-cs/compliance/124`（`@Public()` 免登录）→ 后台「系统配置 · 124 号令合规公示」。
 * 备案编号目前尚未补录，后端下发空串 ⇒ 页面显示「待补录」，**不伪造编号**；
 * 补录后运营在后台填值即可生效，无需重新发版。
 *
 * ## 为什么不用 useRequest
 * `useRequest.run()` 会先 `ensureLogin()`。本接口是公开只读的合规公示，
 * 未登录 / 登录态异常时也必须能展示（监管查的是页面有没有内容，不是登录态）。
 * ⇒ 直接走 api 层，自己管 loading / 错误态，不触发 `ensureLogin()`。
 *
 * ⚠️ 调用点**必须**显式写 `{ keepAuthState: true }`：`mp:no-bare-call` 静态闸门
 *    只认页面调用点括号里的 flag，看不见 `api/` 定义层（P1-16：裸调拿旧 token
 *    会清掉重登刚写进去的新 token）。定义层同时兜底，两处都挂，不怕漏传。
 *
 * ⚠️ 备案编号等字段一律以后端为准。若经营定性从「仅销售预包装食品」改为
 *    「热食类制售」，需同步改后端公示字段与提审类目，本页不应自行猜测证照类型。
 */
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { AGREEMENT_OPERATOR } from '@/constants/agreements';
import { fetchCompliance124 } from '@/api/compliance';
import type { ComplianceBlock } from '@/api/compliance';
import { navigateTo } from '@/utils/router';

const operator = AGREEMENT_OPERATOR;
const block = ref<ComplianceBlock | null>(null);
const loading = ref(false);

/** 空值显示占位，绝不伪造工商信息 */
function text(value: string): string {
  return value && value.trim() ? value : '—';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    block.value = await fetchCompliance124({ keepAuthState: true });
  } catch {
    block.value = null;
  } finally {
    loading.value = false;
  }
}

function goSupport(): void {
  navigateTo('/pages/support/contact');
}

onLoad(() => {
  void load();
});
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

  &__sub {
    display: block;
    margin-top: $space-2;
    font-size: $fs-body;
    color: $c-text-weak;
  }

  &__desc {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.card {
  background: $c-surface;
  border: 1rpx solid $c-border;
  border-radius: $radius-md;
  padding: $space-3;
  margin-bottom: $space-3;

  &__title {
    display: block;
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }

  &__hint {
    display: block;
    margin-top: $space-1;
    margin-bottom: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: $space-2 0;
  border-bottom: 1rpx solid $c-border;

  &:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  &__k {
    flex: 0 0 220rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__v {
    flex: 1;
    text-align: right;
    font-size: $fs-caption;
    color: $c-text;
    word-break: break-all;

    &--pending {
      color: $c-warn-fg;
    }
  }
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: $space-1;

  &__item {
    font-size: $fs-caption;
    color: $c-text-weak;
    background: $c-surface-2;
    border: 1rpx solid $c-border;
    border-radius: $radius-pill;
    padding: 6rpx 16rpx;
  }
}

.note {
  padding: $space-2 $space-1;

  &__text {
    font-size: $fs-caption;
    color: $c-text-weak;
    line-height: 1.6;
  }
}

.state {
  padding: $space-4 $space-2;
  text-align: center;

  &__text {
    display: block;
    font-size: $fs-body;
    color: $c-text-weak;
  }

  &__btn {
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text;
    background: $c-surface;
    border: 1rpx solid $c-border-strong;
    border-radius: $radius-sm;
  }

  &__btn--hover {
    background: $c-surface-2;
  }
}

.foot {
  margin-top: $space-4;
  padding-top: $space-3;
  border-top: 1rpx solid $c-border;

  &__text {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
    line-height: 1.6;
  }

  &__btn {
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text;
    background: $c-surface;
    border: 1rpx solid $c-border-strong;
    border-radius: $radius-sm;
  }

  &__btn--hover {
    background: $c-surface-2;
  }
}
</style>
