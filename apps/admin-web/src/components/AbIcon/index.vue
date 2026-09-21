<template>
  <i class="abi" :class="`abi-${size}`" :aria-label="label || undefined">{{ char }}</i>
</template>

<script setup lang="ts">
/**
 * 图标组件（运营后台）
 *
 * 与端上 `ab-icon` 引用**同一份字形**（同一个 base64 woff2）与**同一张码位表**
 * （`@abox/shared-utils` 的 `ABOX_ICON_CODEPOINTS`）。
 *
 * ## 为什么它在后台是必修项
 *
 * 后台**此前是全文字界面**：`@element-plus/icons-vue` 声明了依赖但全仓 0 引用，
 * 且 `ADMIN_NAV` 结构里没有 `icon` 字段 ⇒ 菜单、按钮、状态全靠读字。
 * 39 个入口、8 个分组的平铺侧边栏在没有任何视觉锚点时，找一页要**逐行读标题** ——
 * 这是「步骤多、来回跳」的一个真实成因，不是美化问题。
 *
 * S7-1 起 `ADMIN_NAV` / `SUPPLIER_NAV` 的每个条目都带 `icon` 字段，
 * 侧边栏（`layouts/default-layout.vue`）按 16px 行内档渲染。
 * ⚠️ 字段必填且必须是 `ABOX_ICON_NAMES` 之一；写错名的表现是**位置空白、不报错**，
 *    故由 `scripts/check-nav-consistency.mjs` 第 ⑥ 条做同源校验。
 */
import { computed } from 'vue';

import { ABOX_ICON_CODEPOINTS, type AboxIconName } from '@abox/shared-utils';

const props = withDefaults(
  defineProps<{
    /** 语义名（见 `ABOX_ICON_NAMES`，共 82 个） */
    name: AboxIconName;
    /** 16 行内 / 20 按钮内 / 24 独立 */
    size?: 16 | 20 | 24;
    /** 无障碍标签（独立语义图标必填；纯装饰可留空并由 aria-hidden 处理） */
    label?: string;
  }>(),
  { size: 20, label: '' },
);

const char = computed(() => String.fromCodePoint(ABOX_ICON_CODEPOINTS[props.name]));
</script>

<!-- ⚠️ 同端上：刻意没有 <style> 块 —— `.abi` 与 @font-face 由 `styles/index.scss` 全局引入一次，
     避免 base64 被复制进每个使用它的组件。 -->
