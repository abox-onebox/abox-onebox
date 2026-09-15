<template>
  <view class="ab-countdown" :class="{ 'ab-countdown--expired': isExpired }">
    <text class="ab-countdown__label">{{ isExpired ? expiredLabel : label }}</text>
    <text class="ab-countdown__value">{{ isExpired ? expiredText : text }}</text>
  </view>
</template>

<script setup lang="ts">
/**
 * ab-countdown —— 截单倒计时展示（纯展示，计时逻辑在 `composables/use-countdown`）
 *
 * ⚠️ 拆开的原因：`useCountdown` 起表需要服务端剩余秒数，属页面职责；
 *    本组件只做呈现，便于在首页、下单确认页、订单详情页复用同一视觉。
 */
import { computed } from 'vue';

import { formatCountdown } from '@/utils/format';

const props = withDefaults(
  defineProps<{
    /** 剩余秒数（0 = 已截单） */
    remainSec?: number;
    /** 倒计时前的说明文案 */
    label?: string;
    /** 已截单时的替代标题 */
    expiredLabel?: string;
    /** 已截单时的替代文案 */
    expiredText?: string;
  }>(),
  {
    remainSec: 0,
    label: '距截单',
    expiredLabel: '本场已截单',
    expiredText: '下一场 14:00 开团',
  },
);

const isExpired = computed(() => props.remainSec <= 0);
const text = computed(() => formatCountdown(props.remainSec));
</script>

<style lang="scss" scoped>
.ab-countdown {
  display: flex;
  align-items: baseline;
  padding: $space-2 $space-3;
  background: rgba(201, 168, 118, 0.12);
  border-radius: $radius-md;

  &__label {
    margin-right: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-gold;
    // 等宽数字，避免每秒跳动导致宽度抖动
    font-variant-numeric: tabular-nums;
  }

  &--expired {
    background: rgba(154, 139, 114, 0.12);
  }

  &--expired &__value {
    color: $c-text-weak;
    font-size: $fs-body;
  }
}
</style>
