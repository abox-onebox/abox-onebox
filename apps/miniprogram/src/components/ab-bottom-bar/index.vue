<template>
  <view class="ab-bottom-bar">
    <view
      v-for="item in items"
      :key="item.key"
      class="ab-bottom-bar__item"
      :class="{ 'is-active': item.key === active }"
      @tap="go(item)"
    >
      <text class="ab-bottom-bar__label">{{ item.label }}</text>
    </view>
    <!-- 安全区占位（iPhone 底部横条） -->
    <view class="ab-bottom-bar__safe" />
  </view>
</template>

<script setup lang="ts">
/**
 * ab-bottom-bar —— 自定义底部导航
 *
 * ⚠️ 本小程序**不用原生 tabBar**：团长是叠加身份，底部项数需随 `isLeader` 动态变化
 *    （普通 4 项 / 团长 5 项），原生 tabBar 无法条件渲染。
 *    因此所有「主 tab 页」都按普通页面注册，由本组件用 `reLaunch` 切栈。
 *
 * ⚠️ 使用了本组件的页面必须给内容加 `padding-bottom`（约 160rpx），
 *    否则列表最后一项会被固定底栏盖住。
 */
import { computed } from 'vue';

import { useLeaderStore } from '@/stores/leader';
import { switchTab } from '@/utils/router';

export type TabKey = 'index' | 'traceability' | 'leader' | 'orders' | 'mine';

interface TabItem {
  key: TabKey;
  label: string;
  path: string;
}

const props = defineProps<{
  /** 当前高亮的 tab */
  active: TabKey;
}>();

const leaderStore = useLeaderStore();

const items = computed<TabItem[]>(() => {
  const base: TabItem[] = [
    { key: 'index', label: '首页', path: '/pages/index/index' },
    // ⚠️ label = 「供应商」而非「溯源」：与原型 P38 的底部项一致（`prototype/index.html`
    //    第 1919 行 `{id:'P38', ico:'🏪', n:'供应商'}`）。「溯源」是这一页的**动作**，
    //    「供应商」才是用户想找的**东西** —— 用户不合口味时的念头是「找那家店」，
    //    不是「做溯源」（该页原本叫「溯源」但落点是占位页，M5-14 一并修正）。
    //    页面标题仍为「今日这盒 · 溯源」，页内则完整交代溯源信息。
    { key: 'traceability', label: '供应商', path: '/pages/traceability/traceability' },
  ];

  // L10 · 团长入口仅对团长可见（插入在「订单」之前）
  if (leaderStore.isLeader) {
    base.push({ key: 'leader', label: '团长', path: '/pages/leader/workbench' });
  }

  base.push({ key: 'orders', label: '订单', path: '/pages/order-list/order-list' });
  base.push({ key: 'mine', label: '我的', path: '/pages/mine/mine' });
  return base;
});

function go(item: TabItem): void {
  if (item.key === props.active) return;
  switchTab(item.path);
}
</script>

<style lang="scss" scoped>
.ab-bottom-bar {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-around;
  flex-wrap: wrap;
  background: $c-surface;
  border-top: 1px solid $c-border;

  &__item {
    position: relative;
    flex: 1;
    padding: $space-4 0;
    text-align: center;
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__item.is-active &__label {
    color: $c-text;
    font-weight: 600;
  }

  // 选中态：金棕短线（比图标更克制，贴合极简调性）
  &__item.is-active::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 50%;
    width: 40rpx;
    height: 4rpx;
    margin-left: -20rpx;
    background: $c-gold;
    border-radius: $radius-pill;
  }

  &__safe {
    flex: none;
    width: 100%;
    height: env(safe-area-inset-bottom);
  }
}
</style>
