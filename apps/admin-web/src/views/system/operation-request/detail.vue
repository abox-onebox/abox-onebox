<template>
  <div class="page-container">
    <h2 class="page-container__title">高危操作审批 · 详情</h2>
    <p class="page-container__meta">
      模块：阶段 3 · 接口：M37 新增 · 数据源 <code>ab_operation_request</code>
      （admin 高危操作「申请 → 审批 → 执行」两步流，全程留痕）
    </p>

    <div class="toolbar">
      <el-button @click="router.back()">
        <AbIcon name="back" size="16" />
        返回
      </el-button>
      <span v-if="detail" class="toolbar__id">申请单 #{{ detail.id }}</span>
    </div>

    <el-skeleton v-if="loading" :rows="10" animated />

    <template v-else-if="detail">
      <!-- ─────────────── 申请信息 ─────────────── -->
      <el-card shadow="never" class="card">
        <template #header>
          <div class="card__header">
            <span class="card__title">{{ detail.opLabel }}</span>
            <el-tag size="small" :type="statusType(detail.status)">{{
              statusText(detail.status)
            }}</el-tag>
          </div>
        </template>

        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="申请单 ID">
            <b>{{ detail.id }}</b>
          </el-descriptions-item>
          <el-descriptions-item label="风险等级">
            <el-tag size="small" :type="riskType(detail.risk)">{{ riskText(detail.risk) }}</el-tag>
          </el-descriptions-item>

          <el-descriptions-item label="操作码">{{ detail.opCode }}</el-descriptions-item>
          <el-descriptions-item label="提交人">
            <span v-if="detail.submitterKb">{{ detail.submitterKb }}</span>
            <span v-else class="muted">后台 #{{ detail.submitterAdminId ?? '—' }}</span>
          </el-descriptions-item>

          <el-descriptions-item label="提交时间">
            {{ formatDateTime(detail.createdAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="自然语言意图">
            {{ displayOr(detail.submitterNl) }}
          </el-descriptions-item>

          <el-descriptions-item label="审批人">
            <span v-if="detail.approverId">后台 #{{ detail.approverId }}</span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
          <el-descriptions-item label="审批时间">
            {{ detail.approvedAt ? formatDateTime(detail.approvedAt) : '—' }}
          </el-descriptions-item>

          <el-descriptions-item label="驳回原因">
            {{ displayOr(detail.rejectReason) }}
          </el-descriptions-item>
          <el-descriptions-item label="执行时间">
            {{ detail.executedAt ? formatDateTime(detail.executedAt) : '—' }}
          </el-descriptions-item>
        </el-descriptions>

        <!-- 审批 / 执行动作（仅 super_admin / admin 可见） -->
        <div v-if="canApprove" class="actions">
          <el-button
            v-if="detail.status === 'pending'"
            type="success"
            :loading="acting === 'approve'"
            @click="doApprove"
          >
            <AbIcon name="check" size="16" />
            审批通过
          </el-button>
          <el-button
            v-if="detail.status === 'pending'"
            type="danger"
            :loading="acting === 'reject'"
            @click="doReject"
          >
            <AbIcon name="x-circle" size="16" />
            驳回
          </el-button>
          <el-button
            v-if="detail.status === 'approved'"
            type="primary"
            :loading="acting === 'execute'"
            @click="doExecute"
          >
            <AbIcon name="play" size="16" />
            立即执行
          </el-button>
          <el-alert
            v-if="detail.status === 'pending'"
            type="warning"
            :closable="false"
            class="actions__tip"
          >
            <template #title>
              审批通过仅标记为「已通过」；需再次点击「立即执行」才会真正调用目标接口落库。
            </template>
          </el-alert>
        </div>
        <el-alert v-else type="info" :closable="false" class="actions__tip">
          <template #title>当前角色仅可查看，审批 / 执行需 super_admin 或 admin 操作。</template>
        </el-alert>
      </el-card>

      <!-- ─────────────── 参数 ─────────────── -->
      <el-card shadow="never" class="card">
        <template #header><span class="card__title">操作参数（params）</span></template>
        <pre class="json">{{ pretty(detail.params) }}</pre>
      </el-card>

      <!-- ─────────────── 操作块（知识助手原报） ─────────────── -->
      <el-card
        v-if="detail.submitterOpBlock !== null && detail.submitterOpBlock !== undefined"
        shadow="never"
        class="card"
      >
        <template #header>
          <span class="card__title">操作块（X-KB-OpBlock 原文）</span>
        </template>
        <pre class="json">{{ pretty(detail.submitterOpBlock) }}</pre>
      </el-card>

      <!-- ─────────────── 执行回执 ─────────────── -->
      <el-card
        v-if="detail.snapshot !== null && detail.snapshot !== undefined"
        shadow="never"
        class="card"
      >
        <template #header>
          <span class="card__title">执行回执（snapshot）</span>
        </template>
        <pre class="json">{{ pretty(detail.snapshot) }}</pre>
      </el-card>
    </template>

    <el-empty v-else description="未找到该申请单" />
  </div>
</template>

<script setup lang="ts">
/**
 * 系统管理 · 高危操作审批详情（M37-新增）
 *
 * 两步流：approve 仅置 status=approved；execute 才真正调用原目标接口（后端
 * OperationRequestService.execute 以容器内自调用复用原 controller + @OperationLog 审计）。
 * 本页只发指令，不碰任何业务逻辑。
 *
 * ⚠️ 可见性：审批 / 执行按钮只对 super_admin / admin 显示（canApprove）。
 *    operator 经 admin-role.ts 的 `/system/` 派生规则已被挡在菜单外，只能由知识助手代提交。
 */
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  fetchOperationRequestDetail,
  approveOperationRequest,
  rejectOperationRequest,
  executeOperationRequest,
  type OperationRequestRow,
  type OperationRequestStatus,
} from '@/api/system';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';
import { displayOr, formatDateTime } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const loading = ref(true);
const detail = ref<OperationRequestRow | null>(null);
const canApprove = auth.role === 'super_admin' || auth.role === 'admin';

/** 正在执行的动作（防重复点击） */
const acting = ref<'' | 'approve' | 'reject' | 'execute'>('');

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
function riskText(r: string): string {
  return { high: '高危', mid: '中危', low: '低危' }[r] ?? r;
}
function riskType(r: string): TagType {
  return ({ high: 'danger', mid: 'warning', low: 'info' } as Record<string, TagType>)[r] ?? 'info';
}
function pretty(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function doApprove(): Promise<void> {
  if (!detail.value) return;
  acting.value = 'approve';
  try {
    detail.value = await approveOperationRequest(detail.value.id);
    ElMessage.success('已通过，待执行');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '审批失败');
  } finally {
    acting.value = '';
  }
}

async function doReject(): Promise<void> {
  if (!detail.value) return;
  let reason = '';
  try {
    const { value } = await ElMessageBox.prompt('请填写驳回原因', '驳回申请', {
      confirmButtonText: '确认驳回',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputValidator: (v: string) => (v && v.trim() ? true : '驳回原因不能为空'),
    });
    reason = value.trim();
  } catch {
    return; // 用户取消
  }
  acting.value = 'reject';
  try {
    detail.value = await rejectOperationRequest(detail.value.id, reason);
    ElMessage.success('已驳回');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '驳回失败');
  } finally {
    acting.value = '';
  }
}

async function doExecute(): Promise<void> {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm('确认立即执行？将真实调用目标接口并落库。', '立即执行', {
      type: 'warning',
      confirmButtonText: '确认执行',
      cancelButtonText: '再想想',
    });
  } catch {
    return;
  }
  acting.value = 'execute';
  try {
    detail.value = await executeOperationRequest(detail.value.id);
    ElMessage.success('执行完成');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '执行失败');
  } finally {
    acting.value = '';
  }
}

onMounted(async () => {
  // 查询串传参（与列表页 `list.vue` 的 router.push 对应；原为路径参数 `:id`，
  // 2026-10-20 对齐全仓详情页的查询串 pattern）
  const id = Number(route.query.id);
  if (!Number.isFinite(id) || id < 1) {
    loading.value = false;
    ElMessage.warning('缺少申请单 id');
    return;
  }
  try {
    detail.value = await fetchOperationRequestDetail(id);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '申请单加载失败');
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

.toolbar {
  display: flex;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-3;

  &__id {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.card {
  margin-bottom: $space-3;

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__title {
    font-weight: 700;
  }
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;
  margin-top: $space-3;

  &__tip {
    flex-basis: 100%;
    margin-top: $space-1;
  }
}

.json {
  margin: 0;
  padding: $space-2 $space-3;
  max-height: 320px;
  overflow: auto;
  background: $c-bg;
  border: 1px solid $c-border;
  border-radius: $radius-sm;
  font-size: $fs-caption;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.muted {
  color: $c-text-weak;
}
</style>
