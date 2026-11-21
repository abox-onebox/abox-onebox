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
          :shortcuts="dateShortcuts"
          clearable
          style="width: 170px"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="reload(1)">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
        <el-button type="success" :loading="exporting" @click="exportCsv">
          <AbIcon name="download" size="16" />
          导出 CSV
        </el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="detail">
            <!-- 大众后台惯例：先看「谁把什么从什么改成什么」，再看原始报文 -->
            <template v-if="changeRows(row).length">
              <p class="detail__title">变更明细（旧值 → 新值）</p>
              <table class="diff">
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>变更前</th>
                    <th></th>
                    <th>变更后</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="c in changeRows(row)"
                    :key="c.field"
                    :class="{ 'is-same': c.before === c.after }"
                  >
                    <td class="diff__field">{{ c.label }}</td>
                    <td class="diff__value">{{ c.before }}</td>
                    <td class="diff__arrow">→</td>
                    <td class="diff__value">{{ c.after }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
            <p v-else class="detail__empty">
              该操作未记录字段级变更快照（只写入了操作者上下文），下方原始报文仍完整可查。
            </p>
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
      <!-- B3 · 知识助手自报操作人（X-KB-Operator） -->
      <el-table-column label="KB 操作人" min-width="140">
        <template #default="{ row }">
          <span v-if="row.kbOperator" class="kb">{{ row.kbOperator }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <!-- B3 · 自然语言指令（X-KB-NL） -->
      <el-table-column label="自然语言意图" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ row.kbNlIntent || '—' }}</template>
      </el-table-column>
      <!-- B3 · 操作块 JSON（X-KB-OpBlock 原文） -->
      <el-table-column label="操作块" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.kbOpBlock !== null && row.kbOpBlock !== undefined" class="mono">
            {{ blockPreview(row.kbOpBlock) }}
          </span>
          <span v-else class="muted">—</span>
        </template>
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
import { createExportTask } from '@/api/export';
import type { OperationLogRow } from '@/api/system';
import { ApiError } from '@/api/request';
import { displayOr, formatDateTime } from '@/utils/format';

const loading = ref(false);
const exporting = ref(false);
const rows = ref<OperationLogRow[]>([]);
const total = ref(0);
const operators = ref<Array<{ id: number; name: string; role: string; roleLabel: string }>>([]);

/** 单日筛选快捷段：按运营浏览器本地自然日（与日常口径一致） */
const dateShortcuts = [
  { text: '今天', value: () => new Date() },
  {
    text: '昨天',
    value: () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d;
    },
  },
];

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

interface DiffRow {
  field: string;
  label: string;
  before: string;
  after: string;
}

/** 常见字段中文名；未命中的字段原样显示键名（不臆造译名） */
const FIELD_LABELS: Record<string, string> = {
  status: '状态',
  realName: '姓名',
  level: '等级',
  commissionRate: '佣金率',
  buildingId: '楼栋',
  buildingGroupId: '楼群',
  quantity: '份数',
  mealDate: '交付日',
  amount: '金额',
};

function diffValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * 把日志快照折成「旧值 → 新值」行。
 *
 * 快照形态由写侧决定，当前工程存在两种真实结构（见 operation-log.interceptor.ts
 * 与 order/delivery/team-leader 等业务写点）：
 *   ① {before: {...}, after: {...}} —— 字段级前后值；
 *   ② {fromStatus, toStatus, ...} —— 仅状态流转。
 * 其余（如 {operator, role, at} 或导出计数）不是变更，不伪造 diff，端上显式说明。
 */
function changeRows(row: unknown): DiffRow[] {
  // Element Plus 展开槽把 row 标成 DefaultRow（无字段形状），此处按 unknown 收窄
  if (!row || typeof row !== 'object') return [];
  const snap = (row as { snapshot?: unknown }).snapshot;
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return [];
  const s = snap as Record<string, unknown>;
  const out: DiffRow[] = [];

  if (
    s.before &&
    typeof s.before === 'object' &&
    !Array.isArray(s.before) &&
    s.after &&
    typeof s.after === 'object' &&
    !Array.isArray(s.after)
  ) {
    const before = s.before as Record<string, unknown>;
    const after = s.after as Record<string, unknown>;
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      out.push({
        field,
        label: FIELD_LABELS[field] ?? field,
        before: diffValue(before[field]),
        after: diffValue(after[field]),
      });
    }
    return out;
  }

  if ('fromStatus' in s || 'toStatus' in s) {
    out.push({
      field: 'status',
      label: FIELD_LABELS.status,
      before: diffValue(s.fromStatus),
      after: diffValue(s.toStatus),
    });
  }
  return out;
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** B3 操作块单行预览（截断，避免撑爆单元格） */
function blockPreview(value: unknown): string {
  if (value === null || value === undefined) return '—';
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/**
 * 导出 CSV（含 B3 三列）
 *
 * ⚠️ 导出**当前筛选条件下的全部命中行**（不受当前分页 pageSize 限制）：
 *    以 `total` 为 pageSize 再拉一次，避免「列表看 20 条、导出只导 20 条」的错配。
 */
async function exportCsv(): Promise<void> {
  exporting.value = true;
  try {
    // 旧实现把 total 当 pageSize 再拉一次，但服务端分页上限会把它钳到 100 ——
    // 「导出全部」实际只导 100 条且不报截断。改走作业后由服务端全量取数、统一生成 CSV。
    const task = await createExportTask({
      kind: 'operation-logs',
      filter: {
        operatorId: query.operatorId,
        module: query.module || undefined,
        date: query.date || undefined,
      },
    });
    ElMessage.success(`已提交导出任务 #${task.id}，完成后到「系统 → 下载中心」取件`);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '提交导出任务失败');
  } finally {
    exporting.value = false;
  }
}

onMounted(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
/* 字段级 diff：变化值走加强档绿，未变字段灰显；不占用状态原色作文字 */
.diff {
  width: 100%;
  margin-bottom: $space-3;
  border-collapse: collapse;
  font-size: $fs-caption;

  th,
  td {
    padding: 4px 8px;
    border-bottom: 1px solid $c-border;
    text-align: left;
    vertical-align: top;
  }

  th {
    color: $c-text-weak;
    font-weight: 400;
  }

  &__field {
    color: $c-text;
    font-weight: 600;
    white-space: nowrap;
  }

  &__value {
    font-family: Consolas, Monaco, monospace;
    word-break: break-all;
  }

  &__arrow {
    width: 20px;
    color: $c-text-weak;
    text-align: center;
  }

  tr:not(.is-same) td:last-child {
    color: $c-ok-fg;
    font-weight: 600;
  }

  tr.is-same td {
    color: $c-text-weak;
  }
}
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

.kb {
  font-weight: 600;
  color: $c-text;
}

.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: $fs-caption;
}

.detail {
  padding: $space-3 $space-4;

  &__title {
    margin: 0 0 $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__empty {
    margin: 0 0 $space-3;
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.6;
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
