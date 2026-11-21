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

    <!-- 新建申请：按服务端字段声明渲染表单，JSON 只作为高级入口保留 -->
    <el-dialog v-model="dialogVisible" title="新建高危操作申请" width="640px">
      <el-form :model="form" label-width="132px">
        <el-form-item label="操作" required>
          <el-select
            v-model="form.opCode"
            placeholder="选择 admin 高危操作"
            style="width: 100%"
            @change="onOpChange"
          >
            <el-option v-for="o in OP_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>

        <el-alert
          v-if="currentSchema"
          type="info"
          :closable="false"
          class="op-effect"
          :title="currentSchema.effect"
        />

        <template v-if="currentSchema && !advancedMode">
          <el-form-item
            v-for="f in currentSchema.fields"
            :key="f.key"
            :label="f.label"
            :required="f.required"
          >
            <el-select v-if="f.type === 'select'" v-model="fieldValues[f.key]" style="width: 100%">
              <el-option
                v-for="o in f.options ?? []"
                :key="String(o.value)"
                :label="o.label"
                :value="String(o.value)"
              />
            </el-select>
            <el-input
              v-else
              v-model="fieldValues[f.key]"
              :type="f.type === 'text' ? 'textarea' : f.type === 'int' ? 'number' : 'text'"
              :rows="f.type === 'text' ? 3 : undefined"
              :placeholder="f.placeholder"
            />
          </el-form-item>
        </template>

        <el-form-item label="高级">
          <el-switch v-model="advancedMode" />
          <span class="hint-text">直接编辑 JSON（复杂参数 / 知识助手原文）</span>
        </el-form-item>
        <el-form-item v-if="advancedMode" label="参数 JSON">
          <el-input
            v-model="form.paramsText"
            type="textarea"
            :rows="8"
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
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  fetchOperationSchemas,
  fetchOperationRequests,
  createOperationRequest,
  type OperationRequestRow,
  type OperationRequestQuery,
  type OperationRequestStatus,
  type OpSchema,
} from '@/api/system';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime } from '@/utils/format';

const router = useRouter();
const auth = useAuthStore();
const canApprove = auth.role === 'super_admin' || auth.role === 'admin';

/** 操作下拉与表单字段都来自服务端声明（单一真相，消除前后端三处集合漂移） */
const schemas = ref<OpSchema[]>([]);
const OP_OPTIONS = computed(() => schemas.value.map((s) => ({ value: s.opCode, label: s.label })));

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
  // 查询串传参（与 `/leader/detail`、`/order/detail` 同 pattern —— 路径参数路由
  // 无法被 nav:consistency 的 drilldown 豁免核验，且全仓详情页一律查询串）
  router.push({ path: '/system/operation-request/detail', query: { id: String(row.id) } });
}

type TagType = 'success' | 'info' | 'warning' | 'danger' | 'primary';

function statusText(s: OperationRequestStatus): string {
  return (
    {
      pending: '待审',
      approved: '已通过',
      rejected: '已驳回',
      executed: '已执行',
      recalled: '已撤回',
    }[s] ?? s
  );
}
function statusType(s: OperationRequestStatus): TagType {
  return (
    (
      {
        pending: 'warning',
        approved: 'info',
        rejected: 'danger',
        executed: 'success',
        recalled: 'info',
      } as Record<string, TagType>
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

const fieldValues = reactive<Record<string, string>>({});
const advancedMode = ref(false);
const currentSchema = computed(() => schemas.value.find((s) => s.opCode === form.opCode));

function onOpChange(): void {
  for (const k of Object.keys(fieldValues)) delete fieldValues[k];
  // 安全默认：群发的 dryRun 这类布尔字段，默认走「预演不真发」
  for (const f of currentSchema.value?.fields ?? []) {
    if (f.type === 'boolean') fieldValues[f.key] = 'true';
  }
}

async function loadSchemas(): Promise<void> {
  try {
    schemas.value = await fetchOperationSchemas();
  } catch {
    ElMessage.warning('字段声明加载失败，可开启高级模式直接填 JSON');
  }
}

async function submit(): Promise<void> {
  if (!form.opCode) {
    ElMessage.warning('请选择操作');
    return;
  }
  let params: Record<string, unknown> = {};
  if (advancedMode.value) {
    try {
      const parsed: unknown = JSON.parse(form.paramsText || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not object');
      params = parsed as Record<string, unknown>;
    } catch {
      ElMessage.warning('参数 JSON 必须是对象');
      return;
    }
  } else if (currentSchema.value) {
    const missing = currentSchema.value.fields.filter(
      (f) => f.required && !String(fieldValues[f.key] ?? '').trim(),
    );
    if (missing.length) {
      ElMessage.warning(`请填写：${missing.map((f) => f.label).join('、')}`);
      return;
    }
    for (const f of currentSchema.value.fields) {
      const raw = fieldValues[f.key];
      if (raw === undefined || !String(raw).trim()) continue;
      if (f.type === 'int') params[f.key] = Number(raw);
      else if (f.type === 'ints') {
        params[f.key] = String(raw)
          .split(/[,，]/)
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isFinite(n));
      } else if (f.type === 'boolean') params[f.key] = raw === 'true';
      else if (f.type === 'select') {
        const hit = (f.options ?? []).find((o) => String(o.value) === String(raw));
        params[f.key] = hit ? hit.value : raw;
      } else params[f.key] = String(raw);
    }
  } else {
    ElMessage.warning('字段声明未加载，请稍后重试或开启高级模式');
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
    advancedMode.value = false;
    onOpChange();
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
void loadSchemas();
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
.op-effect {
  margin-bottom: $space-2;
}
.hint-text {
  margin-left: $space-2;
  color: $c-text-weak;
  font-size: $fs-caption;
}
</style>
