<template>
  <div class="page-container">
    <h2 class="page-container__title">社群排期卡</h2>
    <p class="page-container__meta">
      AI 编排节点 P（安全版）· 接口：<code>POST /admin/community-taskcard/generate</code
      >（只读生成）/ <code>POST /admin/community-taskcard/confirm</code>（逐日确认出清单）· AI
      基于靶楼分层与当期套餐出一周排期，话术逐条过合规闸，运营拿清单去群里人工发
    </p>

    <el-alert
      class="notice"
      type="error"
      :closable="false"
      show-icon
      title="本页不发任何群消息、不发券、不加好友 —— 只出「排期表 + 合规话术清单」"
    >
      <template #default>
        生成只读；确认一天，系统只吐出「周几 + 靶楼档位 + 套餐/券（测算示例）+ 合规话术 +
        去哪手动发」清单并记台账，
        <strong>绝不调发消息接口</strong>。请拿清单去群里手动复制发送、去券管理页人工发券。
        话术里的第三方平台名、链接、口令、既成事实词（如「已发券」）会被系统自动拦截。
      </template>
    </el-alert>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-button type="primary" :loading="generating" @click="generate">重新生成排期卡</el-button>
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
      title="AI 脚本不可用或数据不足，已降级"
    >
      本次没有可用排期卡，可在「AI 洞察」页看靶楼分层原始数据；不影响套餐与用户。
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

    <!-- ─────────────── 逐日排期 ─────────────── -->
    <div v-loading="generating" class="draft-list">
      <el-empty
        v-if="!rows.length && !generating"
        description="还没有排期卡 —— 点「重新生成排期卡」"
      />

      <el-card
        v-for="c in rows"
        :key="c.day"
        class="draft-card"
        :class="{ 'draft-card--skipped': decisions[c.day] === 'skip' }"
        :body-style="{ padding: '14px 16px' }"
        shadow="hover"
      >
        <div class="draft-card__head">
          <div>
            <span class="draft-card__name">{{ c.day }}</span>
            <el-tag size="small" :type="tierTagType(c.targetTier)" class="tag-tier">
              {{ tierLabel(c.targetTier) }}
            </el-tag>
            <span class="draft-card__stat">{{ offerText(c) }}</span>
          </div>
          <el-radio-group v-model="decisions[c.day]" size="small">
            <el-radio-button value="approve">确认</el-radio-button>
            <el-radio-button value="skip">跳过</el-radio-button>
          </el-radio-group>
        </div>

        <p class="draft-card__pitch">{{ c.pitch || '（AI 未给话术）' }}</p>
        <p v-if="c.note" class="draft-card__note">备注：{{ c.note }}</p>

        <!-- 确认后展开执行清单 -->
        <div v-if="executions[c.day]" class="material">
          <el-alert
            class="notice"
            type="success"
            :closable="false"
            show-icon
            title="已确认：排期清单已生成（系统未发任何消息）"
          >
            <template #default>{{ executions[c.day]!.operatorNote }}</template>
          </el-alert>
          <div class="material__row">
            <code class="material__path">{{ executions[c.day]!.executeHint }}</code>
            <el-button size="small" @click="copy(dayText(c.day))">复制本日清单</el-button>
          </div>
        </div>
        <div v-if="cardResults[c.day] && !cardResults[c.day]!.ok" class="material">
          <el-alert
            class="notice"
            type="warning"
            :closable="false"
            show-icon
            :title="`未出清单：${cardResults[c.day]!.reason || '实时复核未通过'}`"
          />
        </div>
      </el-card>
    </div>

    <!-- ─────────────── 分档话术清单（确认后出）─────────────── -->
    <div v-if="compliantPitches.length" class="pitch-panel">
      <h3 class="pitch-panel__title">
        合规分档话术（{{ compliantPitches.length }} 条 · 过平台名/链接口令/既成事实闸）
        <el-button size="small" @click="copyAllPitches">复制全部话术</el-button>
      </h3>
      <el-alert
        class="notice"
        type="info"
        :closable="false"
        show-icon
        title="话术已过合规闸，仍请人工通读后再发；系统不会自动发送到任何群"
      />
      <div v-for="p in compliantPitches" :key="p.tier" class="pitch-item">
        <el-tag size="small" :type="tierTagType(p.tier)">{{ tierLabel(p.tier) }}</el-tag>
        <span class="pitch-item__text">{{ p.text }}</span>
        <el-button size="small" link @click="copy(p.text)">复制</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 后台 · 社群排期卡（#P 安全版）
 * ==================================================================
 * 把「靶楼分层 + 当期套餐/券白名单」交给 AI 写成结构化一周排期；运营逐日确认，
 * 系统只产出「排期表 + 合规话术清单」并记台账 —— 不发消息、不发券、不加好友。
 *
 * 🚨 发消息红线：本页没有任何发送入口，只把话术当清单展示；真人拿去群里手动发。
 * 话术合规闸（第三方平台名含快团团 / 链接口令 / 既成事实）在生成与确认时双拦。
 * operator 只能看卡，确认收紧 super_admin/admin（与 G/H/M/N 一致）。
 */
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  confirmCommunityTaskCards,
  generateCommunityTaskCards,
  type CommunityExecution,
  type CommunityPitchCard,
  type CommunityScheduleCard,
  type CommunityScheduleResult,
  type CommunityTaskCardGenResult,
  type CommunityTier,
} from '@/api/community-taskcard';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';

type Decision = 'approve' | 'skip';

const generating = ref(false);
const submitting = ref(false);
const rows = ref<CommunityScheduleCard[]>([]);
const notes = ref<string[]>([]);
const failure = ref('');
const degraded = ref(false);
const generatedAt = ref('');
const decisions = ref<Record<string, Decision>>({});
const executions = ref<Record<string, CommunityExecution>>({});
const cardResults = ref<Record<string, CommunityScheduleResult>>({});
const compliantPitches = ref<CommunityPitchCard[]>([]);

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

function tierLabel(t: CommunityTier): string {
  return (
    {
      amplify: '放量（主战场）',
      steady: '维持',
      wake: '唤醒',
      silent: '沉默待救',
    }[t] || t
  );
}

function tierTagType(t: CommunityTier): 'danger' | 'warning' | 'success' | 'info' {
  if (t === 'amplify') return 'success';
  if (t === 'wake') return 'warning';
  if (t === 'silent') return 'danger';
  return 'info';
}

function offerText(c: CommunityScheduleCard): string {
  const bits: string[] = [];
  if (c.templateName) bits.push(c.templateName);
  if (c.couponName) bits.push(c.couponName);
  // 价格/面额是测算示例，以套餐/券管理页实时配置为准
  return bits.length ? `${bits.join(' · ')}（测算示例：${c.offer}）` : '不指定套餐/券';
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
  compliantPitches.value = [];
  generatedAt.value = '';
  try {
    const r: CommunityTaskCardGenResult = await generateCommunityTaskCards();
    generatedAt.value = r.generatedAt || '';
    notes.value = r.notes ?? [];
    degraded.value = Boolean(r.degraded) || !r.ok;
    if (!r.ok && r.message) failure.value = r.message;
    rows.value = r.schedule ?? [];
    if (!rows.value.length) {
      ElMessage.warning('这次没有可用排期卡，看下面的提示');
      return;
    }
    ElMessage.success(`排期卡 ${rows.value.length} 天，逐日勾选后提交`);
  } catch (e) {
    failure.value = errText(e);
  } finally {
    generating.value = false;
  }
}

async function submitDecisions(): Promise<void> {
  if (!canSubmit.value) return;
  try {
    await ElMessageBox.confirm(
      '系统将按勾选逐日复核并生成排期清单与合规话术，不会发任何群消息、不会发券、不会加好友。请拿清单人工执行。确认继续吗？',
      '确认提交本批决策',
      {
        type: 'info',
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
    .filter((c) => decisions.value[c.day])
    .map((c) => ({
      day: c.day,
      decision: decisions.value[c.day]!,
      // 原卡回传：服务端复核后沿用其话术，价格/面额仍以实时套餐/券为准
      card: c,
    }));
  try {
    const r = await confirmCommunityTaskCards(payload);
    for (const res of r.results) {
      cardResults.value[res.day] = res;
      if (res.ok && res.decision === 'approve' && res.execution) {
        executions.value[res.day] = res.execution;
      }
    }
    compliantPitches.value = r.pitches ?? [];
    for (const c of rows.value) {
      if (decisions.value[c.day] === 'approve') delete decisions.value[c.day];
    }
    ElMessage.success(
      `已确认 ${r.approvedCount} 天（清单已生成，未发任何消息），跳过 ${r.skippedCount} 天`,
    );
  } catch (e) {
    failure.value = errText(e);
  } finally {
    submitting.value = false;
  }
}

function dayText(day: string): string {
  const e = executions.value[day];
  if (!e) return '';
  return (
    `【${e.day} · 社群排期执行清单】\n` +
    `靶楼档位：${tierLabel(e.targetTier)}\n` +
    `套餐/券：${e.offer}（测算示例，以管理页实时配置为准）\n` +
    `群话术：${e.pitch}\n` +
    `${e.executeHint}\n` +
    '（系统未发任何群消息、未发券、未加好友；请去群里人工发送）'
  );
}

async function copyAllPitches(): Promise<void> {
  const text = compliantPitches.value.map((p) => `【${tierLabel(p.tier)}】${p.text}`).join('\n');
  await copy(text);
}

async function copy(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制');
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

.tag-tier {
  margin-right: 8px;
}

.draft-card__stat {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.draft-card__pitch {
  font-size: 13px;
  color: var(--el-text-color-primary);
  margin: 0 0 4px;
}

.draft-card__note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
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

.pitch-panel {
  margin-top: 20px;
  padding: 14px 16px;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
}

.pitch-panel__title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 15px;
  margin: 0 0 12px;
}

.pitch-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.pitch-item__text {
  flex: 1;
  font-size: 13px;
  color: var(--el-text-color-primary);
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
