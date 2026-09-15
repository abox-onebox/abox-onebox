<template>
  <view class="page">
    <view class="page__hd">
      <text class="page__title">P20 · 团长资料（含退出团长身份）</text>
      <text class="page__module">PRD 模块 M15-01/02/03</text>
    </view>
    <view class="page__bd">
      <text class="page__hint">脚手架占位页 · 业务实现见《目录结构 v2.0》§十 映射表</text>
    </view>
  </view>
</template>

<script setup lang="ts">
// P20 · 团长资料（含退出团长身份）
// 代码落点：src/pages/leader/profile.vue
/** TODO: 开发阶段实现（勿在未同步 docs/ 的情况下改口径） */
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4;
  box-sizing: border-box;

  &__hd {
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__module {
    margin-left: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__hint {
    font-size: $fs-body;
    color: $c-text-weak;
  }
}
</style>
