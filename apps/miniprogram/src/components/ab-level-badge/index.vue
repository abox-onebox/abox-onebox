<template>
  <text class="ab-level" :class="`ab-level--${level}`">{{ label }}</text>
</template>

<script setup lang="ts">
/**
 * ab-level-badge —— 等级徽标（团长等级：见习 / 正式 / 金牌 / 首席）
 *
 * 规格来源 =《设计系统 v2.1》§八「组件规格 · 等级徽标」：
 *    描边款（见习 / 正式）+ 实底款（金牌 / 首席）；白色文字 on 实底。
 *    **不用彩色文字** —— 缺陷③：等级四色当文字全不达标
 *    （见习 4.41 / 正式 2.21 / 金牌 1.75 / 首席 3.10），故改为「色块 + 文字标签」。
 *
 * ⚠️ 描边款**必须自带底色**（= 卡片面），不能做成「透明底 + 描边」：
 *    实测（`_tmp/icons/s6-contrast.py`）`$c-gold-deep #936f3a` 作文字
 *      · on 卡片面 #fffdf8 → 4.51（**余量仅 0.01**）
 *      · on 金棕浅底 #fbf4e6 → 4.19（不达标）
 *      · on 米色底   #f6f0e5 → 4.05（不达标）
 *    ⇒ 透明底的徽标一旦落在页面米色底上就不达标，故底色固定为卡片面。
 *
 * 文案唯一真源 = `LEADER_LEVEL_META`（@abox/shared-types），本组件不自造文案。
 */
import { computed } from 'vue';

import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';

const props = withDefaults(
  defineProps<{
    /** 等级枚举值（trainee / formal / gold / chief） */
    level: LeaderLevel;
    /** 文案覆盖（默认取 `LEADER_LEVEL_META` 的 label —— 文案唯一来源） */
    text?: string;
  }>(),
  { text: '' },
);

const label = computed(() => props.text || LEADER_LEVEL_META[props.level]?.label || '');
</script>

<style lang="scss" scoped>
.ab-level {
  display: inline-block;
  padding: 2rpx $space-2;
  // 与状态 chip 同档（22rpx = 11px）
  font-size: $fs-micro;
  line-height: 1.6;
  border-radius: $radius-pill;
  border: 2rpx solid transparent;

  // ---- 描边款：见习 / 正式（底色固定 = 卡片面，理由见组件头注）----
  &--trainee {
    color: $c-level-trainee;
    background: $c-surface;
    border-color: $c-border-strong;
  }

  &--formal {
    color: $c-level-formal;
    background: $c-surface;
    border-color: $c-level-formal;
  }

  // ---- 实底款：金牌 / 首席（色块 + 白字）----
  &--gold {
    color: $c-surface;
    background: $c-level-gold;
  }

  &--chief {
    color: $c-surface;
    background: $c-level-chief;
  }
}
</style>
