<template>
  <text class="ab-status-badge" :class="`ab-status-badge--${tone}`">{{ text }}</text>
</template>

<script setup lang="ts">
/**
 * ab-status-badge —— 订单状态徽标
 *
 * ⚠️ 文案**不由本组件拼**：一律用服务端 `statusText`（三视角映射的唯一来源），
 *    本组件只负责「按状态着色」，避免端上自造文案与后台不一致。
 */
import { computed } from 'vue';
import { OrderStatus } from '@abox/shared-types';

type Tone = 'default' | 'info' | 'success' | 'warning' | 'muted';

/** 状态 → 色系（与《设计 token 规范》状态色对应） */
const TONE_BY_STATUS: Record<string, Tone> = {
  [OrderStatus.PENDING_PAY]: 'warning',
  [OrderStatus.PAID]: 'info',
  [OrderStatus.CUT_OFF]: 'info',
  [OrderStatus.COOKED]: 'info',
  [OrderStatus.DELIVERING]: 'info',
  [OrderStatus.DELIVERED]: 'success',
  [OrderStatus.COMPLETED]: 'success',
  [OrderStatus.CANCELLED]: 'muted',
  [OrderStatus.REFUND_APPLYING]: 'warning',
  [OrderStatus.REFUNDING]: 'warning',
  [OrderStatus.REFUNDED]: 'muted',
};

const props = withDefaults(
  defineProps<{
    /** 展示文案（取自服务端 `statusText`） */
    text: string;
    /** 主状态枚举值，用于自动着色 */
    status?: string;
    /** 显式指定色系（优先于 status 推导；null = 按 status 自动推导） */
    tone?: Tone | null;
  }>(),
  { status: '', tone: null },
);

const tone = computed<Tone>(() => props.tone ?? TONE_BY_STATUS[props.status] ?? 'default');
</script>

<style lang="scss" scoped>
.ab-status-badge {
  display: inline-block;
  padding: 2rpx $space-2;
  font-size: $fs-caption;
  line-height: 1.6;
  border-radius: $radius-sm;

  // 默认（未识别状态）
  &--default {
    color: $c-text-weak;
    background: rgba(154, 139, 114, 0.1);
  }

  &--info {
    color: $c-info;
    background: rgba(74, 111, 165, 0.1);
  }

  &--success {
    color: $c-success;
    background: rgba(91, 124, 58, 0.1);
  }

  &--warning {
    color: $c-warning;
    background: rgba(196, 69, 54, 0.1);
  }

  &--muted {
    color: $c-text-weak;
    background: rgba(154, 139, 114, 0.14);
  }
}
</style>
