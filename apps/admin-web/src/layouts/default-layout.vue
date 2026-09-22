<template>
  <el-container class="ab-layout" :class="{ 'is-narrow': narrow }">
    <!-- 桌面：常驻侧栏 -->
    <el-aside v-if="!narrow" width="216px" class="ab-layout__aside">
      <div class="ab-layout__brand">ABox 一盒</div>
      <AbNavMenu :groups="navGroups" />
    </el-aside>

    <!-- 窄屏（S8）：侧栏改抽屉。⚠️ 只影响**外壳**，不改任何视图的桌面布局 -->
    <el-drawer
      v-if="narrow"
      v-model="menuOpen"
      direction="ltr"
      size="248px"
      :with-header="false"
      class="ab-layout__drawer"
    >
      <div class="ab-layout__brand">ABox 一盒</div>
      <AbNavMenu :groups="navGroups" @select="menuOpen = false" />
    </el-drawer>

    <el-container>
      <el-header class="ab-layout__header">
        <!-- ⚠️ 标签必须是**静态的「打开菜单」**：这个按钮只负责**打开** —— 抽屉展开时它被
             遮罩盖住、根本点不到，所以写「收起菜单」是在描述一个用户做不到的动作（读屏
             用户会被误导）。关闭走遮罩点击 / Esc，由 el-drawer 自己处理。 -->
        <el-button
          v-if="narrow"
          text
          class="ab-layout__burger"
          aria-label="打开菜单"
          @click="menuOpen = true"
        >
          <AbIcon name="menu" :size="24" />
        </el-button>
        <span class="ab-layout__crumb">{{ pageTitle }}</span>
        <span class="ab-layout__user">
          <el-tag size="small" type="info" effect="plain">{{ auth.roleLabel || '—' }}</el-tag>
          <span v-if="!narrow" class="ab-layout__name">{{ auth.displayName || '—' }}</span>
          <el-button link type="primary" @click="onLogout">退出登录</el-button>
        </span>
      </el-header>
      <el-main class="ab-layout__main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
/**
 * 后台主壳（运营 + 供应商共用）
 *
 * ⚠️ **菜单来源是服务端下发的 `account.menus`**（经 permission store 与前端
 *    NAV 取交集），本页不做任何 role → 菜单的硬编码判断。
 *    供应商账号登录后自然只剩「商家」一组，无需在此 if/else。
 *
 * 面包屑标题按「当前 path → NAV 反查」得到，避免 39 个视图各写一份 meta.title
 * （两份清单必然漂移）。
 *
 * ## S8：窄屏外壳（关键路径）
 *
 * 只把**外壳**做成响应式（侧栏 → 抽屉），视图层**只改两条关键路径**，
 * 其余 40 余个视图在窄屏下保持桌面布局（可横向滚动）—— 这是本批**明确不做**全站响应式的落点。
 * 断点值取自 `useNarrow()`（唯一真源），此处不写第二份数字。
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';

import { useAuthStore } from '@/stores/auth';
import { usePermissionStore } from '@/stores/permission';
import { useNarrow } from '@/composables/use-narrow';
// 导航菜单抽成子组件：桌面侧栏与窄屏抽屉**共用同一实现**（避免两份菜单标记）。
// ⚠️ 它在 `layouts/` 下，`unplugin-vue-components` 的 `dirs` 只扫 `src/components` ⇒ 必须显式 import。
import AbNavMenu from './ab-nav-menu.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const perm = usePermissionStore();
const { narrow } = useNarrow();

/** 窄屏抽屉开关（仅窄屏渲染抽屉，见模板 `v-if="narrow"`） */
const menuOpen = ref(false);

/**
 * ⚠️ 抽屉是 `v-if` 渲染的：`narrow` 变 false 时抽屉组件被卸载，但 **`menuOpen` 不会跟着复位**
 *    （`ref` 活在 setup 里，不随子组件卸载）。不手动复位的话，回到窄屏时抽屉会以**上一轮的
 *    展开态**直接弹出来 —— 用户看到一个自己从没点开过的抽屉。
 */
watch(narrow, (isNarrow) => {
  if (!isNarrow) menuOpen.value = false;
});

const navGroups = computed(() => perm.navGroups);

const pageTitle = computed(() => {
  const hit = navGroups.value.flatMap((g) => g.items).find((i) => i.path === route.path);
  return hit
    ? `${hit.title}${hit.page !== '—' ? ` · ${hit.page}` : ''}`
    : (route.meta.title ?? String(route.name ?? ''));
});

async function onLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm('确认退出当前后台账号？', '退出登录', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return; // 用户取消
  }
  await auth.logout();
  void router.replace('/login');
}
</script>

<style lang="scss" scoped>
.ab-layout {
  height: 100vh;

  &__aside {
    background: $c-surface;
    border-right: 1px solid $c-border;
  }

  &__brand {
    height: 56px;
    display: flex;
    align-items: center;
    padding: 0 $space-4;
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
    border-bottom: 1px solid $c-border;
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: $c-surface;
    border-bottom: 1px solid $c-border;
  }

  /**
   * 窄屏汉堡（24px 独立档 · 规格 §五 三档锁）
   * 44px 触摸目标：可点区域小于 44px 时，单手操作会频繁点空（WCAG 2.5.8 建议 24px 起，
   * 移动端实践取 44px）。用 padding 撑开而不是放大字形 —— 字形仍守 24px 档。
   */
  &__burger {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin-left: -$space-2;
    padding: 0;
    color: $c-text;
  }

  &__crumb {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: $fs-body;
    color: $c-text;
  }

  &__user {
    display: flex;
    align-items: center;
    gap: $space-2;
  }

  &__name {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__main {
    background: $c-bg;
  }
}

/**
 * 窄屏外壳微调 —— 只调**容器与留白**，不动视图内部（视图按「关键路径」各自适配）。
 *
 * ⚠️ 这里**故意不写 `@media`**：断点的唯一真源是 `use-narrow.ts` 的 `NARROW_MAX`，
 *    由它把 `is-narrow` 挂到根容器上。写媒体查询就成了**第二份断点表述** ——
 *    两者错开半像素时，没有任何门禁能发现。
 */
.ab-layout.is-narrow {
  .ab-layout__header {
    padding: 0 $space-3;
  }

  .ab-layout__brand {
    padding: 0 $space-3;
  }

  .ab-layout__user {
    gap: $space-1;
  }
}

/* 抽屉内菜单去边距，与桌面侧栏视觉一致 */
.ab-layout__drawer :deep(.el-drawer__body) {
  padding: 0;
  overflow-x: hidden;
}
</style>
