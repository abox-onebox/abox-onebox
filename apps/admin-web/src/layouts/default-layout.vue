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
        <span class="ab-layout__crumb">{{ $route.meta.title || $route.name }}</span>
        <span class="ab-layout__user">运营账号</span>
      </el-header>
      <el-main class="ab-layout__main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ADMIN_NAV, SUPPLIER_NAV } from '@/constants';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
// role=supplier 只渲染供应商菜单（P21–P26）
const navGroups = computed(() => (auth.role === 'supplier' ? [{ group: '商家', items: SUPPLIER_NAV }] : ADMIN_NAV));
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

  &__main {
    background: $c-bg;
  }
}
</style>
