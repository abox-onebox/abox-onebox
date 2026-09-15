<template>
  <div class="page-container">
    <el-result icon="warning" :title="title" :sub-title="subTitle">
      <template #extra>
        <el-button v-if="landing" type="primary" @click="goLanding">回到可访问页面</el-button>
        <el-button @click="relogin">重新登录</el-button>
      </template>
    </el-result>
  </div>
</template>

<script setup lang="ts">
/**
 * 无权访问 / 无可访问菜单
 *
 * 两类来源（`?reason=`）：
 *   · `no-menu` —— 登录成功但该角色菜单为空（角色配错 / 账号被改过角色）
 *   · 其他      —— 访问了不在本角色菜单内的路径（路由守卫拦下，`?from=` 带原路径）
 *
 * ⚠️ 这里是**体验层**兜底。真正的越权访问即使绕过本页，服务端也会 403
 *    （`AdminGuard` + `@Roles()`），所以本页不承担安全职责。
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { usePermissionStore } from '@/stores/permission';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const perm = usePermissionStore();
const auth = useAuthStore();

const noMenu = computed(() => route.query.reason === 'no-menu');
const landing = computed(() => perm.landingPath);

const title = computed(() => (noMenu.value ? '当前账号没有可访问的菜单' : '无权访问该页面'));

const subTitle = computed(() => {
  if (noMenu.value) {
    return `账号「${auth.displayName || '—'}」的角色为「${auth.roleLabel || '未知'}」，暂未分配到任何菜单。请联系超级管理员调整角色。`;
  }
  const from = typeof route.query.from === 'string' ? route.query.from : '';
  return `${from ? `路径 ${from} ` : '该页面 '}不在当前角色的权限范围内。如需访问，请联系超级管理员调整角色或权限。`;
});

function goLanding(): void {
  void router.replace(landing.value);
}

async function relogin(): Promise<void> {
  await auth.logout();
  void router.replace('/login');
}
</script>
