<template>
  <div class="page-container">
    <h2 class="page-container__title">高危操作审批</h2>
    <p class="page-container__meta">
      模块：阶段 3 · 接口：M37 新增 · 数据源 <code>ab_operation_request</code>
      （admin 高危操作「申请 → 审批 → 执行」两步流，全程留痕）
    </p>

    <el-form :inline="true" class="filters" @submit.prevent>
      <el-form-item label="状态">
        <el-select v-model="query.status" placeholder="全部" clearable style="width: 140px">
          <el-option label="待审" value="pending" />
          <el-option label="已通过" value="approved" />
          <el-option label="已驳回" value="rejected" />
          <el-option label="已执行" value="executed" />
        </el-select>
      </el-form-item>
      <el-form-item label="操作">
        <el-select v-model="query.opCode" placeholder="全部" clearable style="width: 200px">
          <el-option v-for="o in OP_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="reload">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
        <el-button v-if="canApprove" type="success" @click="dialogVisible = true"
          >新建申请</el-button
        >
      </el-form-item>
    </el-form>

    <el-table
      v-loading="loading"
      :data="rows"
      border
      stripe
      @row-dblclick="(r: unknown) => goDetail(r as OperationRequestRow)"
    >
      <el-table-column prop="id" label="ID" width="80" />
      <el-table-column prop="opLabel" label="操作" min-width="180" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="提交人" min-width="140">
        <template #default="{ row }">
          <span v-if="row.submitterKb">{{ row.submitterKb }}</span>
          <span v-else class="muted">后台 #{{ row.submitterAdminId ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="自然语言意图" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ row.submitterNl || '—' }}</template>
      </el-table-column>
      <el-table-column label="提交时间" min-width="170">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="goDetail(row as OperationRequestRow)"
            >查看</el-button
          >
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无审批申请" />
      </template>
    </el-table>

    <!-- 新建申请（admin 代建 / 手动录入） -->
    <el-dialog v-model="dialogVisible" title="新建高危操作申请" width="560px">
      <el-form :model="form" label-width="96px">
        <el-form-item label="操作" required>
          <el-select v-model="form.opCode" placeholder="选择 admin 高危操作" style="width: 100%">
            <el-option v-for="o in OP_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="参数 JSON" required>
          <el-input
            v-model="form.paramsText"
            type="textarea"
            :rows="6"
            placeholder='如 {"id":1,"action":"note","reason":"..."}'
          />
        </el-form-item>
        <el-form-item label="自报操作人">
          <el-input v-model="form.submitterKb" placeholder="留空则记为后台账号" />
        </el-form-item>
        <el-form-item label="自然语言">
          <el-input v-model="form.submitterNl" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  fetchOperationRequests,
  createOperationRequest,
  type OperationRequestRow,
  type OperationRequestQuery,
  type OperationRequestStatus,
} from '@/api/system';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime } from '@/utils/format';

const router = useRouter();
const auth = useAuthStore();
const canApprove = auth.role === 'super_admin' || auth.role === 'admin';

/** admin 高危 op（与后端 OperationRequestService.OP_ENDPOINTS 对齐） */
const OP_OPTIONS = [
  { value: 'create_dish', label: '上架新菜品' },
  { value: 'batch_dish_status', label: '批量上下架菜品' },
  { value: 'edit_dish', label: '编辑菜品' },
  { value: 'change_leader', label: '变更团长（等级/楼/层）' },
  { value: 'appoint_leader', label: '任命/转交团长' },
  { value: 'leader_audit', label: '团长资质补录（停职/恢复/补签）' },
  { value: 'send_message', label: '群发运营通知' },
  { value: 'manual_adjust', label: '手动改单（改份数/改取餐楼）' },
];

const loading = ref(false);
const rows = ref<OperationRequestRow[]>([]);

const query = reactive<OperationRequestQuery>({ status: undefined, opCode: undefined });

async function reload(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await fetchOperationRequests({
      status: query.status,
      opCode: query.opCode,
    });
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function resetQuery(): void {
  query.status = undefined;
  query.opCode = undefined;
  void reload();
}

function goDetail(row: OperationRequestRow): void {
  router.push(`/system/operation-request/${row.id}`);
}

type TagType = 'success' | 'info' | 'warning' | 'danger' | 'primary';

function statusText(s: OperationRequestStatus): string {
  return { pending: '待审', approved: '已通过', rejected: '已驳回', executed: '已执行' }[s] ?? s;
}
function statusType(s: OperationRequestStatus): TagType {
  return (
    (
      { pending: 'warning', approved: 'info', rejected: 'danger', executed: 'success' } as Record<
        string,
        TagType
      >
    )[s] ?? 'info'
  );
}

// —— 新建申请弹窗 ——
const dialogVisible = ref(false);
const submitting = ref(false);
const form = reactive({
  opCode: '',
  paramsText: '',
  submitterKb: '',
  submitterNl: '',
});

async function submit(): Promise<void> {
  if (!form.opCode) {
    ElMessage.warning('请选择操作');
    return;
  }
  let params: Record<string, unknown>;
  try {
    params = JSON.parse(form.paramsText || '{}');
  } catch {
    ElMessage.warning('参数 JSON 格式错误');
    return;
  }
  submitting.value = true;
  try {
    await createOperationRequest({
      opCode: form.opCode,
      params,
      submitterKb: form.submitterKb || undefined,
      submitterNl: form.submitterNl || undefined,
    });
    ElMessage.success('申请已提交，待审批');
    dialogVisible.value = false;
    form.opCode = '';
    form.paramsText = '';
    form.submitterKb = '';
    form.submitterNl = '';
    void reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '提交失败');
  } finally {
    submitting.value = false;
  }
}

void reload();
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
.muted {
  color: $c-text-weak;
}
</style>
