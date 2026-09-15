<template>
  <view class="sup-card">
    <text class="sup-card__name">{{ name }}</text>
    <text class="sup-card__dish">今日出品：{{ dish }}</text>
    <text class="sup-card__badge">资质三重核验</text>
  </view>
</template>

<script setup lang="ts">
/** C8 · 今日这盒 · 出品方卡片（只展示本餐涉及的出品方，不展示合作/备选状态） */
defineProps<{ name: string; dish: string }>();
</script>

<style lang="scss" scoped>
.sup-card {
  padding: $space-3;
  background: $c-surface;
  border-radius: $radius-md;
  border: 1px solid $c-border;

  &__name {
    font-size: $fs-h2;
    color: $c-text;
  }

  &__dish {
    display: block;
    margin-top: $space-1;
    font-size: $fs-body;
    color: $c-text-weak;
  }

  &__badge {
    display: inline-block;
    margin-top: $space-2;
    padding: 2px 8px;
    font-size: $fs-caption;
    color: $c-success;
    border: 1px solid $c-success;
    border-radius: $radius-sm;
  }
}
</style>
