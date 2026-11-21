<template>
  <div class="page-container">
    <h2 class="page-container__title">下载中心</h2>
    <p class="page-container__meta">
      大批量导出在这里生成、留档、下载 —— 点导出后不用守着页面等，去列表页看任务状态即可。
    </p>

    <el-card shadow="never" class="card">
      <template #header>
        <div class="card__head">
          <span class="card__title">导出任务</span>
          <span class="card__meta"> 只显示最近 100 条 · 有进行中任务时每 5 秒自动刷新 </span>
          <el-button :loading="loading" @click="reload">刷新</el-button>
        </div>
      </template>

      <el-alert v-if="loadError" type="warning" :closable="false" show-icon :title="loadError" />

      <el-table v-loading="loading" :data="rows" border stripe>
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="detail">
              <p class="detail__title">提交时的筛选条件</p>
              <pre class="detail__json">{{ pretty(row.filterJson) }}</pre>
              <p v-if="row.error" class="detail__error">失败原因：{{ row.error }}</p>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="taskNo" label="任务号" min-width="160" />
        <el-table-column prop="label" label="导出内容" min-width="130" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{
              statusText(row.status)
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="行数" width="90">
          <template #default="{ row }">{{ row.rowCount }}</template>
        </el-table-column>
        <el-table-column label="提交人" min-width="120">
          <template #default="{ row }">{{
            row.createdName || `后台 #${row.createdBy ?? '—'}`
          }}</template>
        </el-table-column>
        <el-table-column label="提交时间" min-width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'done'"
              link
              type="primary"
              :loading="acting === row.id"
              @click="download(row as ExportTaskRow)"
            >
              下载
            </el-button>
            <el-button
              v-else-if="row.status === 'failed'"
              link
              type="warning"
              :loading="acting === row.id"
              @click="retry(row as ExportTaskRow)"
            >
              重试
            </el-button>
            <span v-else class="muted">生成中…</span>
          </template>
        </el-table-column>
        <template #empty><el-empty description="还没有导出任务" /></template>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 系统管理 · 下载中心（2026-11-21）
 *
 * 为什么单独一页：导出从「点一下就下载」变成「提交作业 → 队列生成 → 取件」之后，
 * 必须有一个地方能看到作业状态与失败原因，否则一次静默失败就变成「我明明点了导出」。
 *
 * ⚠️ 本页只展示与取件，不拼 CSV：产物是服务端按统一列定义生成的，
 * 端上再拼一遍就会出现「下载中心与旧导出列不一样」的第二份口径。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import {
  fetchExportTasks,
  fetchExportDownload,
  retryExportTask,
  type ExportTaskRow,
  type ExportTaskStatus,
} from '@/api/export';
import { ApiError } from '@/api/request';
import { formatDateTime } from '@/utils/format';

const loading = ref(false);
const loadError = ref('');
const rows = ref<ExportTaskRow[]>([]);
const acting = ref<number | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function reload(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    rows.value = await fetchExportTasks();
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '导出任务加载失败';
  } finally {
    loading.value = false;
  }
}

function statusText(s: ExportTaskStatus): string {
  return { pending: '排队中', running: '生成中', done: '已完成', failed: '失败' }[s] ?? s;
}

type TagType = 'info' | 'warning' | 'success' | 'danger';

function statusType(s: ExportTaskStatus): TagType {
  return (
    (
      { pending: 'info', running: 'warning', done: 'success', failed: 'danger' } as Record<
        ExportTaskStatus,
        TagType
      >
    )[s] ?? 'info'
  );
}

function pretty(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  try {
    return JSON.stringify(JSON.parse(String(value)), null, 2);
  } catch {
    return String(value);
  }
}

async function download(row: ExportTaskRow): Promise<void> {
  acting.value = row.id;
  try {
    const r = await fetchExportDownload(row.id);
    // 产物是 StorageProvider 的公开 URL；新窗口打开，浏览器按 text/csv 触发下载
    window.open(r.url, '_blank', 'noopener');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '取下载链接失败');
  } finally {
    acting.value = null;
  }
}

async function retry(row: ExportTaskRow): Promise<void> {
  acting.value = row.id;
  try {
    await retryExportTask(row.id);
    ElMessage.success('已重新排队，稍后刷新看结果');
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '重试失败');
  } finally {
    acting.value = null;
  }
}

onMounted(() => {
  void reload();
  timer = setInterval(() => {
    if (rows.value.some((r) => r.status === 'pending' || r.status === 'running')) void reload();
  }, 5000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-4;
  color: $c-text-weak;
  font-size: $fs-caption;
}
.card {
  border-color: $c-border;

  &__head {
    display: flex;
    align-items: center;
    gap: $space-2;
  }

  &__title {
    font-weight: 600;
  }

  &__meta {
    flex: 1;
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}
.detail {
  padding: $space-2 $space-4;

  &__title {
    margin: 0 0 $space-1;
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__json {
    margin: 0;
    padding: $space-2;
    max-height: 200px;
    overflow: auto;
    border: 1px solid $c-border;
    border-radius: $radius-sm;
    background: $c-bg;
    font-size: $fs-caption;
    white-space: pre-wrap;
    word-break: break-all;
  }

  &__error {
    margin: $space-2 0 0;
    color: $c-warn-fg;
    font-size: $fs-caption;
  }
}
.muted {
  color: $c-text-weak;
}
</style>
