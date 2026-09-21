<template>
  <text class="ab-status-badge" :class="`ab-status-badge--${tone}`">{{ text }}</text>
</template>

<script setup lang="ts">
/**
 * ab-status-badge —— 状态 chip（订单态 / 审批态 / 状态标签）
 *
 * ⚠️ 文案**不由本组件拼**：一律用服务端 `statusText`（三视角映射的唯一来源），
 *    本组件只负责「按状态着色」，避免端上自造文案与后台不一致。
 *
 * 规格来源 =《设计系统 v2.1》§八「组件规格 · 状态 chip」：
 *    色调底 + 文字加强档 · 描边 1px · 圆角 pill · 字号 11px · 不用彩色文字裸奔。
 *    对比度实测（`_tmp/icons/s6-contrast.py`，正例全绿）：
 *    成功 4.63 / 警告 4.65 / 信息 4.51 / 中性 4.60（均 on 各自色调底，阈值 4.5）。
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
  // 规格 §八：字号 11px（= 22rpx）
  font-size: $fs-micro;
  line-height: 1.6;
  // 规格 §八：圆角 pill
  border-radius: $radius-pill;
  // 规格 §八：描边 1px（= 2rpx）
  border: 2rpx solid transparent;

  // ⚠️ 底色一律用**色调底 token**，文字一律用**加强档**（`*-fg`）。
  //    状态原色（$c-success / $c-warning / $c-info）**只用于图标与描边** ——
  //    原色当文字压色调底不达标（成功 4.33 / 警告 4.42，见《设计系统》§五）。
  //    历史上这里用的是 rgba() 手写值，其中两处 rgb 分量正好等于**旧次文字色**
  //    `#9A8B72`（= 缺陷① 已判 2.93 的那个值）—— 已随 S6 一并清掉。

  &--default {
    color: $c-text-weak;
    background: $c-mut-bg;
    border-color: $c-mut-bd;
  }

  &--info {
    color: $c-info-fg;
    background: $c-info-bg;
    border-color: $c-info-bd;
  }

  &--success {
    color: $c-ok-fg;
    background: $c-ok-bg;
    border-color: $c-ok-bd;
  }

  &--warning {
    color: $c-warn-fg;
    background: $c-warn-bg;
    border-color: $c-warn-bd;
  }

  &--muted {
    color: $c-text-weak;
    background: $c-surface-2;
    border-color: $c-border;
  }
}
</style>
