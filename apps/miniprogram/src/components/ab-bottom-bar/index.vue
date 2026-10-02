<template>
  <view class="ab-bottom-bar">
    <view
      v-for="item in items"
      :key="item.key"
      class="ab-bottom-bar__item"
      :class="{ 'is-active': item.key === active }"
      @tap="go(item)"
    >
      <!-- ⚠️ 图标必须由 text 元素承载：微信 text 组件内只支持 text 嵌套，
           写成 ab-icon 自定义组件会被渲染层静默丢弃（表现为「图标没了」且无任何报错）。 -->
      <text class="abi abi-24 ab-bottom-bar__icon">{{ I[item.icon] }}</text>
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
 * ⚠️ 使用了本组件的页面必须给内容加 `padding-bottom`（五个主 tab 页一律 200rpx），
 *    否则列表最后一项会被固定底栏盖住。底栏本体约 134rpx（含 48rpx 图标），
 *    外加 `env(safe-area-inset-bottom)` 安全区。
 *
 * ⚠️ 图标是 v1.1 设计稿补的（`_ABox一盒用户端全量页面稿v1.1.html` 屏 01 说明：
 *    「底部 tab 补图标：原本是纯文字」）。此前本组件**从未**有过图标 —— 不是回归，
 *    是「设计已定、代码未落」的缺口（三个提交 `0e9552e`/`f9b970b`/`1506dce` 均无图标）。
 */
import { computed } from 'vue';

// ⚠️ 图标字形一律取自真源 `ABOX_ICON_CHARS`（Tabler 子集），不得手写 PUA 码位。
//    写错名的表现是**位置空白、不报错**，只能靠 `icons:lock` 门禁拦。
//
// ⚠️ 为什么 script 段只存**名字**不存字形（`I.home`）：`icons:lock` 判据 ② 要求
//    「script 段内 `I.xxx` 出现 0 次」—— 脚本里承载不了档位 class，字形一旦在
//    脚本里落地，三档校验就对它失效。故这里存 `AboxIconName`，由模板 `I[item.icon]` 取值。
import { ABOX_ICON_CHARS as I, type AboxIconName } from '@abox/shared-utils';

import { useLeaderStore } from '@/stores/leader';
import { switchTab } from '@/utils/router';

export type TabKey = 'index' | 'traceability' | 'leader' | 'orders' | 'mine';

interface TabItem {
  key: TabKey;
  label: string;
  path: string;
  /** 图标语义名（真源 82 名之一） */
  icon: AboxIconName;
}

const props = defineProps<{
  /** 当前高亮的 tab */
  active: TabKey;
}>();

const leaderStore = useLeaderStore();

const items = computed<TabItem[]>(() => {
  const base: TabItem[] = [
    { key: 'index', label: '首页', path: '/pages/index/index', icon: 'home' },
    // ⚠️ label = 「供应商」而非「溯源」：与原型 P38 的底部项一致（`prototype/index.html`
    //    第 1919 行 `{id:'P38', ico:'🏪', n:'供应商'}`）。「溯源」是这一页的**动作**，
    //    「供应商」才是用户想找的**东西** —— 用户不合口味时的念头是「找那家店」，
    //    不是「做溯源」（该页原本叫「溯源」但落点是占位页，M5-14 一并修正）。
    //    页面标题仍为「今日这盒 · 溯源」，页内则完整交代溯源信息。
    {
      key: 'traceability',
      label: '供应商',
      path: '/pages/traceability/traceability',
      icon: 'store',
    },
  ];

  // L10 · 团长入口仅对团长可见（插入在「订单」之前）
  if (leaderStore.isLeader) {
    // 皇冠与「我的」页团长卡同一枚，语义一致（见 mine.vue 的 leader-card）
    base.push({ key: 'leader', label: '团长', path: '/pages/leader/workbench', icon: 'crown' });
  }

  base.push({
    key: 'orders',
    label: '订单',
    path: '/pages/order-list/order-list',
    icon: 'receipt',
  });
  // ⚠️ 「我的」用 `users` 而非 `user`：设计稿画的是 `#i-user`（单人），但真源 82 名
  //    子集里**只有 `users`（多人）、没有 `user`**。为不重新生成字体子集，
  //    这里取真源已有的 `users` —— 属「设计稿与真源对齐」的取舍，不是漏画。
  base.push({ key: 'mine', label: '我的', path: '/pages/mine/mine', icon: 'users' });
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
    display: flex;
    flex-direction: column;
    align-items: center;
    // 上 28 + 图标 48 + 间隙 4 + 文字 34 + 下 20 ≈ 134rpx（含图标前是 114rpx）
    padding: $space-3 0 $space-2;
    text-align: center;
  }

  // 尺寸走 `.abi-24`（功能族「独立」档 = 48rpx），这里只管颜色；
  // ⚠️ 不要在组件里另写 font-size，否则三档锁名存实亡。
  &__icon {
    margin-bottom: 4rpx;
    color: $c-text-weak;
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__item.is-active &__icon,
  &__item.is-active &__label {
    color: $c-text;
  }

  &__item.is-active &__label {
    font-weight: 600;
  }

  // 选中态：底部金棕短线（叠加在图标/文字换主色之上，作二次强调）
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
