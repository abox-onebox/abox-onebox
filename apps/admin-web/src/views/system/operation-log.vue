<template>
  <div class="page-container">
    <h2 class="page-container__title">操作日志</h2>
    <p class="page-container__meta">
      模块：M37-02 · 接口：D56 · 数据源 <code>ab_operation_log</code> （由
      <code>@OperationLog()</code> 声明的写操作自动落库，口令类字段已脱敏）
    </p>

    <el-form :inline="true" class="filters" @submit.prevent>
      <el-form-item label="操作人">
        <el-select v-model="query.operatorId" placeholder="全部" clearable style="width: 150px">
          <el-option
            v-for="op in operators"
            :key="op.id"
            :label="`${op.name}（${op.roleLabel}）`"
            :value="op.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="模块">
        <el-input
          v-model="query.module"
          placeholder="如 system / order"
          clearable
          style="width: 160px"
        >
        </el-input>
      </el-form-item>
      <el-form-item label="日期">
        <el-date-picker
          v-model="query.date"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="北京时间当天"
          clearable
          style="width: 170px"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="reload(1)">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="detail">
            <p class="detail__title">请求数据（已脱敏）</p>
            <pre class="detail__json">{{ pretty(row.requestData) }}</pre>
            <p class="detail__title">响应 / 错误</p>
            <pre class="detail__json">{{ pretty(row.responseData) }}</pre>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column label="时间" min-width="170">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作人" min-width="150">
        <template #default="{ row }">
          <span v-if="row.operatorName">
            {{ row.operatorName }}
            <el-tag size="small" type="info" effect="plain">{{ row.operatorRoleLabel }}</el-tag>
          </span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="module" label="模块" width="110" />
      <el-table-column prop="action" label="操作" min-width="140" />
      <el-table-column label="对象 ID" min-width="120">
        <template #default="{ row }">{{ displayOr(row.targetId) }}</template>
      </el-table-column>
      <el-table-column label="结果" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.failed ? 'danger' : 'success'">
            {{ row.failed ? '失败' : '成功' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="IP" min-width="130">
        <template #default="{ row }">{{ displayOr(row.requestIp) }}</template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无操作日志" />
      </template>
    </el-table>

    <el-pagination
      class="pager"
      background
      layout="total, prev, pager, next, sizes"
      :total="total"
      :current-page="query.page"
      :page-size="query.pageSize"
      :page-sizes="[10, 20, 50, 100]"
      @current-change="reload"
      @size-change="onSizeChange"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 系统管理 · 操作日志（D56）
 *
 * ⚠️ 日期过滤按**北京时间自然日**（服务端换算 `[d 00:00+08, d+1 00:00+08)`）——
 *    不要以为是 UTC 日，否则查「今天」会少 8 小时的数据。
 * ⚠️ 这里展示的 `requestData` 已由服务端拦截器脱敏（password/token 等置为
 *    `[redacted]`），前端**不需要也不应该**再处理一遍。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchOperationLogs } from '@/api/system';
import type { OperationLogRow } from '@/api/system';
import { ApiError } from '@/api/request';
import { displayOr, formatDateTime } from '@/utils/format';

const loading = ref(false);
const rows = ref<OperationLogRow[]>([]);
const total = ref(0);
const operators = ref<Array<{ id: number; name: string; role: string; roleLabel: string }>>([]);

const query = reactive({
  operatorId: undefined as number | undefined,
  module: '',
  date: '',
  page: 1,
  pageSize: 20,
});

async function reload(page?: number): Promise<void> {
  if (page) query.page = page;
  loading.value = true;
  try {
    const res = await fetchOperationLogs({
      operatorId: query.operatorId,
      module: query.module || undefined,
      date: query.date || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list;
    total.value = res.total;
    operators.value = res.operators ?? [];
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '操作日志加载失败');
  } finally {
    loading.value = false;
  }
}

function onSizeChange(size: number): void {
  query.pageSize = size;
  void reload(1);
}

function resetQuery(): void {
  query.operatorId = undefined;
  query.module = '';
  query.date = '';
  void reload(1);
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

onMounted(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-4;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.filters {
  margin-bottom: $space-2;
}

.pager {
  margin-top: $space-4;
  justify-content: flex-end;
}

.muted {
  color: $c-text-weak;
}

.detail {
  padding: $space-3 $space-4;

  &__title {
    margin: 0 0 $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__json {
    margin: 0 0 $space-3;
    padding: $space-2;
    max-height: 240px;
    overflow: auto;
    background: $c-bg;
    border: 1px solid $c-border;
    border-radius: $radius-sm;
    font-size: $fs-caption;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
  }
}
</style>
