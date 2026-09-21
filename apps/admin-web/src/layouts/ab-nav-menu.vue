<template>
  <!--
    后台侧边导航（**单一实现，桌面与移动共用**）

    ⚠️ 抽成组件而不是在 `default-layout.vue` 里写两遍：
    桌面侧栏与移动抽屉若各写一份菜单，就会产生**两份表述** ——
    以后加一个入口只改一处，另一处静默少一项，而没有任何门禁能发现
    （菜单本身有 `nav:consistency` 门禁，但它校验的是 `constants/index.ts` 这份**真源**，
     不是模板里渲染了几遍）。
  -->
  <el-menu :default-active="$route.path" router class="ab-nav" @select="emit('select')">
    <template v-for="group in groups" :key="group.group">
      <el-menu-item-group :title="group.group">
        <el-menu-item v-for="it in group.items" :key="it.path" :index="it.path">
          <AbIcon class="ab-nav__ico" :name="it.icon" :size="16" />
          <span class="ab-nav__label">{{ it.title }}</span>
        </el-menu-item>
      </el-menu-item-group>
    </template>
  </el-menu>
</template>

<script setup lang="ts">
import type { NavGroup } from '@/stores/permission';

defineProps<{ groups: NavGroup[] }>();
const emit = defineEmits<{ select: [] }>();
</script>

<style lang="scss" scoped>
.ab-nav {
  border-right: none;

  /**
   * ⚠️ 加图标后必须把菜单项改成 flex。
   *
   * Element 的 `.el-menu-item` 靠 `line-height: 56px` 做垂直居中，
   * 行内塞一个图标字形（<i class="abi">）会让基线错位 —— 图标比文字高，
   * 行盒被撑开，文字反而下坠。flex + center 是一次性解决。
   */
  :deep(.el-menu-item) {
    display: flex;
    align-items: center;
    gap: $space-2;
  }

  /* 选中项：图标跟随菜单文字色（Element 的 --el-menu-active-color） */
  :deep(.el-menu-item.is-active .ab-nav__ico) {
    color: inherit;
  }
}

/**
 * 菜单图标（16px 行内档 · 见规格 §五 三档锁）
 *
 * 未选中用次级色而非继承文字色：图标与文字同深会让 39 个入口的侧边栏
 * 变成一片同权重的噪点，失去视觉锚点的作用。`$c-text-weak` 在面底上
 * 5.04:1，功能性图形要求 3:1，余量充足。
 */
.ab-nav__ico {
  flex: none;
  font-size: 16px;
  color: $c-text-weak;
}
</style>
