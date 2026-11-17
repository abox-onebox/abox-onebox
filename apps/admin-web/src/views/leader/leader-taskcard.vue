<template>
  <div class="page-container">
    <h2 class="page-container__title">团长处置卡</h2>
    <p class="page-container__meta">
      AI 编排节点 N（安全版）· 接口：<code>POST /admin/leader-taskcard/generate</code>（只读生成）/
      <code>POST /admin/leader-taskcard/confirm</code>（逐卡确认出清单）· AI
      基于在职团长健康度出处置建议，运营挑卡后拿清单去 D22 人工确认
    </p>

    <el-alert
      class="notice"
      type="error"
      :closable="false"
      show-icon
      title="本页不停用任何团长、不改任何状态、不清用户归属 —— 只出「可执行处置清单」"
    >
      <template #default>
        生成只读；确认一张卡，系统只吐出「团长 #id + 建议 D22 动作 + 事实依据 +
        去哪页人工点」清单并记台账，
        <strong>绝不调停用接口</strong>。真处置请拿清单去「团长管理 D22
        资质补录/例外处理」由人核对事实后点确认。
        <strong>suspend（停用）会清该团长名下用户归属，直接影响履约，务必二次核对后再操作。</strong>
      </template>
    </el-alert>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-button type="primary" :loading="generating" @click="generate">重新生成处置卡</el-button>
      <span v-if="generatedAt" class="muted">生成于 {{ generatedAt }}</span>
      <el-button
        type="success"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="submitDecisions"
      >
        提交本批决策（{{ approvedCount }} 确认 / {{ skippedCount }} 跳过）
      </el-button>
    </div>

    <el-alert
      v-if="failure"
      class="notice"
      type="error"
      :closable="false"
      show-icon
      :title="failure"
    />

    <el-alert
      v-if="degraded"
      class="notice"
      type="warning"
      :closable="false"
      show-icon
      title="AI 脚本不可用，已降级"
    >
      本次没有 AI 处置卡，可在「AI 洞察」页看团长健康度原始数据；不影响团长档案本身。
    </el-alert>

    <el-alert
      v-if="notes.length"
      class="notice"
      type="info"
      :closable="false"
      show-icon
      title="提示"
    >
      <ul class="needs">
        <li v-for="(s, i) in notes" :key="i">{{ s }}</li>
      </ul>
    </el-alert>

    <!-- ─────────────── 逐卡决策 ─────────────── -->
    <div v-loading="generating" class="draft-list">
      <el-empty
        v-if="!rows.length && !generating"
        description="还没有处置卡 —— 点「重新生成处置卡」"
      />

      <el-card
        v-for="c in rows"
        :key="c.kind"
        class="draft-card"
        :class="{
          'draft-card--skipped': decisions[c.kind] === 'skip',
          'draft-card--danger': c.kind === 'suspendReview',
        }"
        :body-style="{ padding: '14px 16px' }"
        shadow="hover"
      >
        <div class="draft-card__head">
          <div>
            <span class="draft-card__name">{{ kindLabel(c.kind) }}</span>
            <el-tag size="small" :type="actionTagType(c.action)" class="tag-action">
              {{ actionLabel(c.action) }}
            </el-tag>
            <span class="draft-card__stat">团长 #{{ c.leaderId }} · {{ c.buildingName }}</span>
          </div>
          <el-radio-group v-model="decisions[c.kind]" size="small">
            <el-radio-button value="approve">确认</el-radio-button>
            <el-radio-button value="skip">跳过</el-radio-button>
          </el-radio-group>
        </div>

        <div class="leader-facts">
          <span class="lbl">事实依据（系统只读，AI 改不动）</span>
          <span>{{ c.facts }}</span>
        </div>

        <p class="draft-card__reason">{{ c.reason || '（AI 未给理由）' }}</p>

        <!-- 确认后展开执行清单 -->
        <div v-if="executions[c.kind]" class="material">
          <el-alert
            class="notice"
            type="success"
            :closable="false"
            show-icon
            title="已确认：执行清单已生成（系统未停用任何团长）"
          >
            <template #default>{{ executions[c.kind]!.operatorNote }}</template>
          </el-alert>
          <div class="material__row">
            <code class="material__path">{{ executions[c.kind]!.executeHint }}</code>
            <el-button size="small" @click="copy(textOf(c.kind))">复制执行清单</el-button>
          </div>
        </div>
        <div v-if="cardResults[c.kind] && !cardResults[c.kind]!.ok" class="material">
          <el-alert
            class="notice"
            type="warning"
            :closable="false"
            show-icon
            :title="`未出清单：${cardResults[c.kind]!.reason || '实时复核未通过'}`"
          />
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 后台 · 团长处置卡（#N 安全版）
 * ==================================================================
 * 把「在职团长健康度分档」交给 AI 写成结构化处置卡；运营逐张确认，系统只产出
 * 「可执行处置清单」并记台账 —— 不停用、不改状态、不清用户归属。
 *
 * 🚨 履约红线：D22 的 suspend 会清用户归属团长。本页没有任何真处置入口，
 * 只把「建议动作」当标签写进清单；真处置由人拿清单去 D22 核对事实后确认。
 * operator 只能看卡，确认收紧 super_admin/admin（与 G/H/M 一致）。
 */
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  confirmLeaderTaskCards,
  generateLeaderTaskCards,
  type LeaderAuditSuggestion,
  type LeaderCardKind,
  type LeaderCardResult,
  type LeaderExecution,
  type LeaderStrategyCard,
  type LeaderTaskCardGenResult,
} from '@/api/leader-taskcard';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';

type Decision = 'approve' | 'skip';

const generating = ref(false);
const submitting = ref(false);
const rows = ref<LeaderStrategyCard[]>([]);
const notes = ref<string[]>([]);
const failure = ref('');
const degraded = ref(false);
const generatedAt = ref('');
const decisions = ref<Record<string, Decision>>({});
const executions = ref<Record<string, LeaderExecution>>({});
const cardResults = ref<Record<string, LeaderCardResult>>({});

const auth = useAuthStore();
const canConfirm = computed(() => auth.role === 'super_admin' || auth.role === 'admin');
const approvedCount = computed(
  () => Object.values(decisions.value).filter((d) => d === 'approve').length,
);
const skippedCount = computed(
  () => Object.values(decisions.value).filter((d) => d === 'skip').length,
);
const canSubmit = computed(() => canConfirm.value && approvedCount.value + skippedCount.value > 0);

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message || `请求失败（${e.code}）`;
  return e instanceof Error ? e.message : '请求失败';
}

function kindLabel(k: LeaderCardKind): string {
  return (
    {
      agreementFollowup: '协议补签跟进',
      silentWakeup: '沉睡唤醒',
      payoutFollowup: '收款卡点跟进',
      suspendReview: '停用复核（高危·仅建议）',
    }[k] || k
  );
}

function actionLabel(a: LeaderAuditSuggestion): string {
  return (
    {
      suspend: '建议停用（会清归属）',
      restore: '建议恢复在职',
      sign_agreement: '建议补签协议',
      note: '建议备注跟进',
    }[a] || a
  );
}

function actionTagType(a: LeaderAuditSuggestion): 'danger' | 'warning' | 'success' | 'info' {
  if (a === 'suspend') return 'danger';
  if (a === 'restore') return 'success';
  if (a === 'sign_agreement') return 'warning';
  return 'info';
}

async function generate(): Promise<void> {
  generating.value = true;
  failure.value = '';
  degraded.value = false;
  rows.value = [];
  notes.value = [];
  decisions.value = {};
  executions.value = {};
  cardResults.value = {};
  generatedAt.value = '';
  try {
    const r: LeaderTaskCardGenResult = await generateLeaderTaskCards();
    generatedAt.value = r.generatedAt || '';
    notes.value = r.notes ?? [];
    degraded.value = Boolean(r.degraded) || !r.ok;
    if (!r.ok && r.message) failure.value = r.message;
    rows.value = r.cards ?? [];
    if (!rows.value.length) {
      ElMessage.warning('这次没有可用处置卡，看下面的提示');
      return;
    }
    ElMessage.success(`处置卡 ${rows.value.length} 张，逐张勾选后提交`);
  } catch (e) {
    failure.value = errText(e);
  } finally {
    generating.value = false;
  }
}

async function submitDecisions(): Promise<void> {
  if (!canSubmit.value) return;
  const hasSuspend = rows.value.some(
    (c) => decisions.value[c.kind] === 'approve' && c.action === 'suspend',
  );
  try {
    await ElMessageBox.confirm(
      hasSuspend
        ? '本批含「建议停用」卡。系统只会生成清单、不会真停用；真停用请拿清单去 D22 人工核对，且会清该团长名下用户归属。确认继续出清单吗？'
        : '系统将按勾选逐卡复核并生成执行清单与台账，不会停用任何团长、不改状态、不清归属。确认继续吗？',
      '确认提交本批决策',
      {
        type: hasSuspend ? 'warning' : 'info',
        confirmButtonText: '确认出清单',
        cancelButtonText: '再看看',
      },
    );
  } catch {
    return; // 用户取消
  }
  submitting.value = true;
  failure.value = '';
  const payload = rows.value
    .filter((c) => decisions.value[c.kind])
    .map((c) => ({
      kind: c.kind,
      decision: decisions.value[c.kind]!,
      // 原卡回传：服务端复核后沿用其理由，事实仍以实时名册为准
      card: c,
    }));
  try {
    const r = await confirmLeaderTaskCards(payload);
    for (const res of r.results) {
      cardResults.value[res.kind] = res;
      if (res.ok && res.decision === 'approve' && res.execution) {
        executions.value[res.kind] = res.execution;
      }
    }
    for (const c of rows.value) {
      if (decisions.value[c.kind] === 'approve') delete decisions.value[c.kind];
    }
    ElMessage.success(
      `已确认 ${r.approvedCount} 张（清单已生成，未停用任何团长），跳过 ${r.skippedCount} 张`,
    );
  } catch (e) {
    failure.value = errText(e);
  } finally {
    submitting.value = false;
  }
}

function textOf(kind: string): string {
  const e = executions.value[kind];
  if (!e) return '';
  return (
    `【${kindLabel(e.kind)} · 团长处置执行清单】\n` +
    `团长 #${e.leaderId} · ${e.buildingName} · 等级 ${e.level}\n` +
    `建议 D22 动作：${actionLabel(e.action)}\n` +
    `事实依据：${e.facts}\n` +
    `处置理由：${e.reason}\n` +
    `${e.executeHint}\n` +
    '（系统未停用任何团长、未改状态、未清归属；请去团长管理 D22 人工核对后确认）'
  );
}

async function copy(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制执行清单');
  } catch {
    ElMessage.warning('复制失败，请手动选中文本');
  }
}
</script>

<style scoped>
.notice {
  margin-bottom: 12px;
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}

.draft-list {
  min-height: 120px;
}

.draft-card {
  margin-bottom: 12px;
}

.draft-card--skipped {
  opacity: 0.6;
}

.draft-card--danger {
  border-left: 4px solid var(--el-color-danger);
}

.draft-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
}

.draft-card__name {
  font-size: 15px;
  font-weight: 600;
  margin-right: 8px;
}

.tag-action {
  margin-right: 8px;
}

.draft-card__stat {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.leader-facts {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 8px;
  font-size: 13px;
}

.leader-facts .lbl {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.draft-card__reason {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin: 0;
}

.material {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--el-border-color);
}

.material__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}

.material__path {
  background: var(--el-fill-color-light);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.muted {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  margin: 4px 0;
}

.needs {
  margin: 4px 0 0;
  padding-left: 18px;
  line-height: 1.9;
}
</style>
