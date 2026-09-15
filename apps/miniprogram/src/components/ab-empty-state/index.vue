<template>
  <view class="ab-empty-state">
    <text class="ab-empty-state__text">{{ text }}</text>
    <text v-if="hint" class="ab-empty-state__hint">{{ hint }}</text>
    <button
      v-if="actionText"
      class="ab-empty-state__action"
      hover-class="ab-empty-state__action--hover"
      @tap="emit('action')"
    >
      {{ actionText }}
    </button>
  </view>
</template>

<script setup lang="ts">
/** ab-empty-state —— 空状态（列表无数据、未绑定楼群、已截单等） */
withDefaults(
  defineProps<{
    /** 主文案 */
    text: string;
    /** 次级说明 */
    hint?: string;
    /** 操作按钮文案（不传则不渲染按钮） */
    actionText?: string;
  }>(),
  { hint: '', actionText: '' },
);

const emit = defineEmits<{ action: [] }>();
</script>

<style lang="scss" scoped>
.ab-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 120rpx $space-5;

  &__text {
    font-size: $fs-body;
    color: $c-text;
  }

  &__hint {
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
    text-align: center;
  }

  &__action {
    margin-top: $space-5;
    padding: 0 $space-5;
    height: 72rpx;
    font-size: $fs-body;
    line-height: 72rpx;
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
