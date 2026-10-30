<template>
  <div class="page-container">
    <h2 class="page-container__title">助手禁止清单</h2>
    <p class="page-container__meta">
      模块：P1-c · 接口：<code>GET / POST / DELETE /admin/op-blocklist</code> · 数据源
      <code>ab_op_blocklist</code>
    </p>

    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>只约束 AI 助手，不约束人。</b>
        列入后助手「直执行」与「提交审批」两条路都会被服务端拦回；<b>后台人工操作不受影响</b>
        —— 禁止清单管的是自动化，不是管理员。
      </template>
    </el-alert>

    <div class="toolbar">
      <el-select
        v-model="pick"
        filterable
        clearable
        placeholder="选择要禁止的操作"
        style="width: 240px"
      >
        <el-option
          v-for="op in catalog"
          :key="op.opCode"
          :label="`${op.label}（${op.opCode}）`"
          :value="op.opCode"
          :disabled="blockedCodes.has(op.opCode)"
        />
      </el-select>
      <el-input
        v-model="note"
        maxlength="120"
        placeholder="原因（选填，建议写一句：为什么禁）"
        style="width: 280px"
      />
      <el-button v-if="canWrite" type="danger" :loading="saving" @click="onAdd">列入禁止</el-button>
      <el-button :loading="loading" @click="load">刷新</el-button>
      <span v-if="!canWrite" class="dialog__tip">只读：列入与解除需要 super_admin / admin</span>
    </div>

    <el-table v-loading="loading" :data="rows" border size="small">
      <el-table-column label="操作" min-width="220">
        <template #default="{ row }">
          <b>{{ labelOf(asRow(row).opCode) }}</b>
          <div class="ob__code">{{ asRow(row).opCode }}</div>
        </template>
      </el-table-column>
      <el-table-column label="原因" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ asRow(row).note || '—' }}</template>
      </el-table-column>
      <el-table-column label="列入人" width="100">
        <template #default="{ row }">{{
          asRow(row).createdBy ? `#${asRow(row).createdBy}` : '—'
        }}</template>
      </el-table-column>
      <el-table-column label="列入时间" width="160">
        <template #default="{ row }">{{ formatDateTime(asRow(row).createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button v-if="canWrite" link type="danger" @click="onRemove(asRow(row))"
            >解除</el-button
          >
          <span v-else class="dialog__tip">—</span>
        </template>
      </el-table-column>
      <template #empty>
        <span class="dialog__tip">清单为空 —— 助手当前可提交、可执行上面下拉里的全部操作</span>
      </template>
    </el-table>

    <p class="footnote">
      提示：重复列入<b>不报错</b>（后端按 opCode 唯一，已存在就直接返回原行）；
      解除是<b>物理删除</b>，事后查不到「这条禁令存在过」，故后端会另写一条操作日志留痕。
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 知识助手禁止清单（补 admin:coverage 扫出的缺口 #41）
 *
 * ⭐ 为什么这个页面必须存在：清单是「出事后能立刻止血」的开关 ——
 *    某个 op 被助手误用，管理员要能**马上**禁掉它。此前三个端点全在、后台零引用，
 *    等于「有闸门但阀门在墙里」，真出事时只能改库。
 *
 * ⭐ op 中文名**不在本表**：`ab_op_blocklist` 只存 opCode，中文来自
 *    `GET /admin/op-blocklist/ops`（真源 `wecom-kb/op-meta.ts`）。
 *    端上**不维护第二份映射** —— 两套映射迟早会说不一样的话（与 `statusText` 同纪律）。
 *    查不到就原样显示 opCode：宁可露一串代码，也不编一个中文名。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  addOpBlock,
  fetchOpBlocklist,
  fetchOpCatalog,
  removeOpBlock,
  type OpBlockRow,
  type OpCatalogItem,
} from '@/api/system';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime } from '@/utils/format';

const auth = useAuthStore();
/** 真正的越权闸门是后端 `@Roles('super_admin','admin')`，这里只做按钮显隐（同 sales-pause） */
const canWrite = computed(() => auth.role === 'super_admin' || auth.role === 'admin');

const loading = ref(false);
const saving = ref(false);
const rows = ref<OpBlockRow[]>([]);
const catalog = ref<OpCatalogItem[]>([]);
const pick = ref('');
const note = ref('');

/** 已禁的 opCode 集合 —— 下拉里置灰，避免「点了个没反应的按钮」 */
const blockedCodes = computed(() => new Set(rows.value.map((r) => r.opCode)));

/** el-table 插槽的 row 是宽松 DefaultRow，入口断言一次，避免 `as` 扩散到模板（同 supplier/list.vue） */
function asRow(raw: unknown): OpBlockRow {
  return raw as OpBlockRow;
}

function labelOf(opCode: string): string {
  return catalog.value.find((c) => c.opCode === opCode)?.label ?? opCode;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [b, c] = await Promise.all([fetchOpBlocklist(), fetchOpCatalog()]);
    rows.value = b.list ?? [];
    catalog.value = c.list ?? [];
  } finally {
    loading.value = false;
  }
}

async function onAdd(): Promise<void> {
  if (!pick.value) {
    ElMessage.warning('请先选择要禁止的操作');
    return;
  }
  saving.value = true;
  try {
    await addOpBlock({ opCode: pick.value, note: note.value.trim() || undefined });
    ElMessage.success(`已禁止「${labelOf(pick.value)}」，助手即刻不可执行`);
    pick.value = '';
    note.value = '';
    await load();
  } finally {
    saving.value = false;
  }
}

async function onRemove(row: OpBlockRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `解除后助手可以重新执行「${labelOf(row.opCode)}」。确认解除？`,
      '确认解除禁止',
      { type: 'warning', confirmButtonText: '确认解除', cancelButtonText: '再想想' },
    );
  } catch {
    return;
  }
  await removeOpBlock(row.opCode);
  ElMessage.success('已解除');
  await load();
}

onMounted(load);
</script>

<style lang="scss" scoped>
.note {
  margin-bottom: $space-3;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-3;
}

.ob__code {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.footnote {
  margin-top: $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;
}
</style>
