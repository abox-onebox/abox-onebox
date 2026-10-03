<template>
  <view class="page">
    <ab-loading v-if="loading && !data" text="正在取出品方资质" />

    <template v-else-if="data">
      <!-- 说明卡（米金浅底 + 金棕描边 · 与溯源页同一种强调语言） -->
      <view class="note-card">
        <text class="abi abi-24 note-card__icon">{{ I.shield }}</text>
        <text class="note-card__text">{{ data.note }}</text>
      </view>

      <!-- 溯源入口（资质墙不取代溯源，只是把「去哪儿找这家店」换成「这家店有什么证」） -->
      <view class="entry" @tap="goTraceability">
        <text class="entry__text">今日这盒 · 溯源</text>
        <text class="abi abi-16 entry__chev">{{ I.chev }}</text>
      </view>

      <view v-if="data.serving.length" class="group">
        <text class="group__title">正在供应</text>
        <view
          v-for="s in data.serving"
          :key="s.id"
          class="row"
          hover-class="row--hover"
          @tap="goDetail(s.id)"
        >
          <view class="row__main">
            <view class="row__hd">
              <text class="row__name">{{ s.name }}</text>
              <text v-if="s.category" class="row__cat">{{ s.category }}</text>
            </view>
            <text v-if="verifiedText(s.qualifications)" class="row__verified">
              {{ verifiedText(s.qualifications) }}
            </text>
            <text v-if="s.licenseExpireAt" class="row__expire">
              证照有效期至 {{ s.licenseExpireAt }}
            </text>
          </view>
          <text class="abi abi-16 row__chev">{{ I.chev }}</text>
        </view>
      </view>

      <!-- 暂未供应：只列名字与品类，不带资质（过期证照不该摆上资质墙） -->
      <view v-if="data.inactive.length" class="group">
        <text class="group__title">暂未供应</text>
        <view
          v-for="s in data.inactive"
          :key="s.id"
          class="row row--off"
          hover-class="row--hover"
          @tap="goDetail(s.id)"
        >
          <view class="row__main">
            <view class="row__hd">
              <text class="row__name">{{ s.name }}</text>
              <text v-if="s.category" class="row__cat">{{ s.category }}</text>
            </view>
            <text class="row__expire">当前未在供应名单中</text>
          </view>
          <text class="abi abi-16 row__chev">{{ I.chev }}</text>
        </view>
      </view>

      <text class="page__ft">
        证照编号可至国家企业信用信息公示系统核对；资质到期前我们会要求出品方换证。
      </text>
    </template>

    <ab-empty-state
      v-else
      text="暂未取出品方资质"
      hint="请稍后重试"
      illustration="store"
      action-text="重新加载"
      @action="load"
    />

    <ab-bottom-bar active="traceability" />
  </view>
</template>

<script setup lang="ts">
/**
 * 供应商资质墙 · 列表（2026-10-03 新增 · 原型 P38 的替代形态）
 *
 * ## 为什么是这一页
 * 原 P38 溯源页用「跳去美团 / 京东 / 淘宝的店铺页」来回答「这家店靠不靠谱」。
 * 2026-10-03 逐字复核《微信小程序平台运营规范》后确认那条路不成立：
 *   · **5.10 互推行为** —— 不得对其他 APP 推荐、推广或提供协助便利（处理 = **下架**）；
 *   · **5.20 诱导下载行为** —— 逐字含「利用剪切板能力达到诱导跳转 / 下载 APP 目的」；
 *   · **5.15.4 / 5.16** —— 滥用剪切板 → 封禁剪切板能力直至封号。
 * ⇒ 本页**不得出现任何第三方平台的名称 / 标识 / 链接 / 可跳转物 / 可复制内容**，
 *   信任证据全部由自持证照承载。这是本页存在的唯一理由，改版时勿把跳转加回来。
 *
 * ## 数据
 * `GET /traceability/suppliers`（**免登录只读**）。分组由服务端按
 * 「合作中 ∧ 资质已通过 ∧ 证照未过期」判据给出，端上**不重算** ——
 * 判据若两端各写一份，迟早出现「这家在出餐、资质墙却查不到」的静默矛盾。
 *
 * ## ⚠️ 不提供复制
 * 页面里的证照编号**刻意不可复制**（没有复制按钮、不调 `setClipboardData`）：
 * 主动往剪贴板写内容正是 5.15.4 / 5.20 盯的形态，而用户拿编号去核对本来也不需要复制。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type {
  SupplierQualificationListResult,
  TraceabilityQualification,
} from '@abox/shared-types';
import { TRACEABILITY_QUALIFICATION_LABEL } from '@abox/shared-types';

import { fetchSupplierQualifications } from '@/api/traceability';
import { toastApiError, useRequest } from '@/composables/use-request';
import { navigateTo } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const { run, loading } = useRequest();
const data = ref<SupplierQualificationListResult | null>(null);

/** 核验行；**无在册资质时不编造**（返回 null ⇒ 该行不渲染） */
function verifiedText(qualifications: TraceabilityQualification[]): string | null {
  if (!qualifications.length) return null;
  return `已核验 · ${qualifications.map((q) => TRACEABILITY_QUALIFICATION_LABEL[q]).join(' · ')}`;
}

function goDetail(id: number): void {
  navigateTo(`/pages/supplier/detail?id=${id}`);
}

function goTraceability(): void {
  navigateTo('/pages/traceability/traceability');
}

async function load(): Promise<void> {
  try {
    data.value = await run(() => fetchSupplierQualifications());
  } catch (e) {
    toastApiError(e);
  }
}

onShow(() => {
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  // 固定底栏高度 + 安全区（见 ab-bottom-bar 头注：使用该组件的页面必须留出）
  padding-bottom: 200rpx;
  box-sizing: border-box;

  &__ft {
    display: block;
    margin: $space-4 $space-4 0;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
    text-align: center;
  }
}

.note-card {
  display: flex;
  align-items: flex-start;
  margin: $space-3 $space-4 0;
  padding: $space-4;
  background: linear-gradient(135deg, $c-trace-card-from, $c-trace-card-to);
  border: 1px solid $c-gold;
  border-radius: $radius-lg;

  &__icon {
    flex: none;
    line-height: 1;
  }

  &__text {
    flex: 1;
    margin-left: $space-2;
    font-size: $fs-caption;
    line-height: 1.85;
    color: $c-text;
  }
}

.entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: $space-3 $space-4 0;
  padding: $space-3 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;

  &__text {
    font-size: $fs-body;
    color: $c-text;
  }

  &__chev {
    color: $c-text-weak;
  }
}

.group {
  margin-top: $space-4;

  &__title {
    display: block;
    margin: 0 $space-4 $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.row {
  display: flex;
  align-items: center;
  margin: 0 $space-4 $space-2;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &--hover {
    background: $c-surface-3;
  }

  // 暂未供应：降透明度 + 虚线边，明确「不在供」
  &.row--off {
    opacity: 0.7;
    border-style: dashed;
  }

  &__main {
    flex: 1;
    min-width: 0;
  }

  &__hd {
    display: flex;
    align-items: center;
  }

  &__name {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__cat {
    margin-left: $space-2;
    padding: 2rpx $space-1;
    font-size: $fs-caption;
    color: #ffffff;
    background: $c-gold;
    border-radius: $radius-sm;
  }

  &__verified {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-ok-fg;
  }

  &__expire {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__chev {
    flex: none;
    color: $c-text-weak;
  }
}
</style>
