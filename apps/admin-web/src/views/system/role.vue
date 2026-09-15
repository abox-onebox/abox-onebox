<template>
  <div class="page-container">
    <h2 class="page-container__title">角色权限</h2>
    <p class="page-container__meta">
      模块：M37 · 接口：D54 角色矩阵（只读）/ D55 权限调整（一期不支持）
    </p>

    <el-alert type="info" :closable="false" show-icon class="note">
      <template #title>一期口径</template>
      <p class="note__text">{{ note }}</p>
    </el-alert>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column label="角色" width="140">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ row.label }}</el-tag>
          <div class="code">{{ row.role }}</div>
        </template>
      </el-table-column>
      <el-table-column label="菜单数" width="100">
        <template #default="{ row }">
          <span v-if="row.menuCount < 0">全部</span>
          <span v-else>{{ row.menuCount }}</span>
        </template>
      </el-table-column>
      <el-table-column label="可见菜单（menu key = 前端路由 path）" min-width="420">
        <template #default="{ row }">
          <template v-if="row.menuCount < 0">
            <el-tag size="small" type="warning" effect="plain">* 全量通配</el-tag>
          </template>
          <template v-else>
            <el-tag
              v-for="m in row.menus"
              :key="m"
              size="small"
              type="info"
              effect="plain"
              class="menu-tag"
            >
              {{ m }}
            </el-tag>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.isSystem ? 'info' : 'success'" effect="plain">
            {{ row.isSystem ? '系统内置' : '自定义' }}
          </el-tag>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无角色数据" />
      </template>
    </el-table>
  </div>
</template>

<script setup lang="ts">
/**
 * 系统管理 · 角色与权限（D54 / D55）
 *
 * ⚠️ **一期不提供在线改权限**（D55 有意抛 10001）。角色 → 菜单映射定义在
 *    服务端代码 `api-server/src/common/constants/admin-role.ts`，
 *    改权限的正确路径是「账号管理 → 修改某账号的角色」。
 *    本页只做**可视化对照**，让运营能看到每个角色到底能进哪些页面。
 *
 * ⚠️ 因此这里**没有**「保存」按钮 —— 不留一个点了报错的假按钮。
 */
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchAdminRoles } from '@/api/system';
import type { AdminRoleRow } from '@/api/system';
import { ApiError } from '@/api/request';

const loading = ref(false);
const rows = ref<AdminRoleRow[]>([]);
const note = ref('');

onMounted(async () => {
  loading.value = true;
  try {
    const res = await fetchAdminRoles();
    rows.value = res.list;
    note.value = res.note;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '角色矩阵加载失败');
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-4;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.note {
  margin-bottom: $space-4;

  &__text {
    margin: 0;
    line-height: 1.7;
  }
}

.code {
  margin-top: 2px;
  font-size: $fs-caption;
  color: $c-text-weak;
}

.menu-tag {
  margin: 0 $space-1 $space-1 0;
}
</style>
