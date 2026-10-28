<template>
  <view class="page">
    <!-- 标题区：协议名 + 版本 / 定稿日期（团长要能判断「我看到的是不是最新一版」） -->
    <view class="hd">
      <text class="hd__title">团长合作协议</text>
      <text class="hd__meta">
        版本 {{ LEADER_AGREEMENT_VERSION }} · 更新于 {{ LEADER_AGREEMENT_UPDATED_AT }}
      </text>
    </view>

    <!-- 要点摘要：与正文**同源**（真源 `LEADER_AGREEMENT_SUMMARY`），不在此另写一套 -->
    <view class="sum">
      <text class="sum__hd">要点摘要</text>
      <text v-for="(s, i) in LEADER_AGREEMENT_SUMMARY" :key="`s${i}`" class="sum__item">{{
        s
      }}</text>
      <text class="sum__note">以下为协议全文，摘要与全文一并构成签署内容。</text>
    </view>

    <!-- 正文：渲染块由真源全文**派生**（`LEADER_AGREEMENT_BLOCKS`），端上不解析 Markdown -->
    <view class="body">
      <template v-for="(b, bi) in rows" :key="`b${bi}`">
        <text v-if="b.kind === 'h1'" class="b-h1">{{ b.text }}</text>
        <text v-else-if="b.kind === 'h2'" class="b-h2">{{ b.text }}</text>
        <text v-else-if="b.kind === 'p'" class="b-p">{{ b.text }}</text>
        <text v-else-if="b.kind === 'quote'" class="b-q">{{ b.text }}</text>

        <view v-else-if="b.kind === 'li'" class="b-li">
          <text class="b-li__mark">{{ b.mark }}</text>
          <text class="b-li__text">{{ b.text }}</text>
        </view>

        <view v-else-if="b.kind === 'table'" class="b-tb">
          <view class="b-tb__row b-tb__row--head">
            <text v-for="(h, hi) in b.head" :key="`h${hi}`" class="b-tb__cell">{{ h }}</text>
          </view>
          <view v-for="(r, ri) in b.rows" :key="`r${ri}`" class="b-tb__row">
            <text v-for="(c, ci) in r" :key="`c${ci}`" class="b-tb__cell">{{ c }}</text>
          </view>
        </view>
      </template>
    </view>

    <!-- 联系方式：一律走客服页，**不在此硬编码微信号 / 电话**（换号只需运营改配置） -->
    <view class="foot">
      <text class="foot__text">如对本文有疑问，可通过客服与我们联系。</text>
      <button class="foot__btn" hover-class="foot__btn--hover" @tap="goSupport">联系客服</button>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 团长协议**全文**页（2026-10-28）
 *
 * ## 为什么要有这一页
 *
 * 此前端上只有 4 行摘要弹窗（`pages/leader-apply` 的 `openAgreement`），
 * 而团长点「同意」签的是**整份协议** —— 签署留痕（`agree_version` + `agreed_at`）能举证
 * 「他签过哪一版」，却举不出「那一版他有没有看到」。补齐全文页后，签署链路才完整。
 *
 * ## 数据来源（**零网络请求**，故免登录可读）
 *
 * | 展示项 | 来源 |
 * |--------|------|
 * | 正文 | `LEADER_AGREEMENT_BLOCKS` ← **派生自** `LEADER_AGREEMENT_FULL_TEXT`（`@abox/shared-types`） |
 * | 要点摘要 | `LEADER_AGREEMENT_SUMMARY`（同一真源） |
 * | 版本 / 定稿日期 | `LEADER_AGREEMENT_VERSION` / `LEADER_AGREEMENT_UPDATED_AT` |
 *
 * ⭐ **全文是 Markdown，端上 `<text>` 不解析 Markdown**，故正文在**编译期**就被
 *    `parseAgreementMarkdown()` 结构化成块（见 `packages/shared-types/src/utils/agreement-markdown.ts`）。
 *    ⚠️ 这是**派生**不是另写一份：改协议只改真源一处；块若少一段，
 *    `test/unit/leader-agreement-blocks.spec.ts` 的两条覆盖率判据会红（那边已配活性自证）。
 *
 * ⚠️ 本页**免登录可读** —— 协议必须在同意之前就能读到，不能挂在登录态后面。
 * ⚠️ 联系方式**不写进本页**：只给一个跳客服页的按钮（既有口径：端上不硬编码联系方式）。
 */
import { computed } from 'vue';
import {
  LEADER_AGREEMENT_BLOCKS,
  LEADER_AGREEMENT_SUMMARY,
  LEADER_AGREEMENT_UPDATED_AT,
  LEADER_AGREEMENT_VERSION,
} from '@abox/shared-types';

import { navigateTo } from '@/utils/router';

interface Row {
  kind: string;
  text: string;
  /** 列表项前缀（有序取序号，无序取圆点） */
  mark: string;
  head?: string[];
  rows?: string[][];
}

/**
 * 渲染行：唯一加工是**给有序列表编号**
 *
 * 模板里没法对「连续有序段」计数，故在此预处理：遇到非列表块就重置计数
 * （本协议每条 section 内都从 1 开始，与公示 md 一致）。
 */
const rows = computed<Row[]>(() => {
  let n = 0;
  return LEADER_AGREEMENT_BLOCKS.map((b) => {
    if (b.kind === 'li') {
      if (b.ordered) n += 1;
      else n = 0;
      return { kind: b.kind, text: b.text, mark: b.ordered ? `${n}.` : '·' };
    }
    n = 0;
    return {
      kind: b.kind,
      text: b.kind === 'table' ? '' : (b as { text: string }).text,
      mark: '',
      ...(b.kind === 'table' ? { head: b.head, rows: b.rows } : {}),
    };
  });
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

/* 摘要：次级面 + 左侧金棕竖线，与正文区分开（它是「要点」不是正文） */
.sum {
  margin-bottom: $space-4;
  padding: $space-3 $space-4;
  background: $c-surface-2;
  border-left: 4rpx solid $c-gold;
  border-radius: $radius-sm;

  &__hd {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-caption;
    font-weight: 600;
    color: $c-gold-fg;
  }

  &__item {
    display: block;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text;
  }

  &__note {
    display: block;
    margin-top: $space-2;
    font-size: $fs-micro;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.b-h1 {
  display: block;
  margin-bottom: $space-3;
  font-size: $fs-h2;
  font-weight: 600;
  color: $c-text;
}

.b-h2 {
  display: block;
  margin-top: $space-5;
  margin-bottom: $space-3;
  font-size: $fs-body;
  font-weight: 600;
  color: $c-text;
}

.b-p {
  display: block;
  margin-bottom: $space-3;
  font-size: $fs-body;
  line-height: 1.8;
  color: $c-text;
}

.b-q {
  display: block;
  margin-bottom: $space-2;
  padding-left: $space-2;
  font-size: $fs-caption;
  line-height: 1.8;
  color: $c-text-weak;
  border-left: 2rpx solid $c-border-strong;
}

.b-li {
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

/* 佣金费率表：等宽三列，表头一线下沉（端上无 <table>，用 flex 拼） */
.b-tb {
  margin: $space-3 0 $space-4;
  border: 1rpx solid $c-border;
  border-radius: $radius-sm;
  overflow: hidden;

  &__row {
    display: flex;
    border-bottom: 1rpx solid $c-border;

    &:last-child {
      border-bottom: none;
    }

    &--head {
      background: $c-surface-2;
    }
  }

  &__cell {
    flex: 1;
    padding: $space-2 $space-2;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text;
  }

  &__row--head &__cell {
    font-weight: 600;
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
