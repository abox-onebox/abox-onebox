<template>
  <view class="ab-loading" :class="{ 'ab-loading--inline': inline }">
    <view class="ab-loading__spinner" />
    <text v-if="text" class="ab-loading__text">{{ text }}</text>
  </view>
</template>

<script setup lang="ts">
/**
 * ab-loading —— 加载态
 *
 * 与 `uni.showLoading` 的分工：整屏阻塞用 `uni.showLoading`（请求层已支持），
 * 页面内的**局部**加载（列表首屏、详情骨架）用本组件，避免遮罩打断浏览。
 */
withDefaults(
  defineProps<{
    text?: string;
    /** 行内模式（不撑满高度，嵌在卡片/列表里用） */
    inline?: boolean;
  }>(),
  { text: '加载中', inline: false },
);
</script>

<style lang="scss" scoped>
.ab-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 120rpx 0;

  &--inline {
    padding: $space-4 0;
    flex-direction: row;
  }

  &__spinner {
    width: 40rpx;
    height: 40rpx;
    border: 4rpx solid $c-border;
    border-top-color: $c-gold;
    border-radius: 50%;
    animation: ab-loading-spin 0.8s linear infinite;
  }

  &__text {
    margin-top: $space-3;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &--inline &__text {
    margin-top: 0;
    margin-left: $space-2;
  }
}

@keyframes ab-loading-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
