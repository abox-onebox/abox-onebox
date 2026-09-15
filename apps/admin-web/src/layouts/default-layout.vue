<template>
  <el-container class="ab-layout">
    <el-aside width="216px" class="ab-layout__aside">
      <div class="ab-layout__brand">ABox 一盒</div>
      <el-menu :default-active="$route.path" router class="ab-layout__menu">
        <template v-for="group in navGroups" :key="group.group">
          <el-menu-item-group :title="group.group">
            <el-menu-item v-for="it in group.items" :key="it.path" :index="it.path">
              {{ it.title }}
            </el-menu-item>
          </el-menu-item-group>
        </template>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="ab-layout__header">
        <span class="ab-layout__crumb">{{ pageTitle }}</span>
        <span class="ab-layout__user">
          <el-tag size="small" type="info" effect="plain">{{ auth.roleLabel || '—' }}</el-tag>
          <span class="ab-layout__name">{{ auth.displayName || '—' }}</span>
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
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';

import { useAuthStore } from '@/stores/auth';
import { usePermissionStore } from '@/stores/permission';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const perm = usePermissionStore();

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

  &__menu {
    border-right: none;
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: $c-surface;
    border-bottom: 1px solid $c-border;
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
</style>
