<template>
  <div class="page-container">
    <h2 class="page-container__title">招募任务卡</h2>
    <p class="page-container__meta">
      AI 编排节点 G（安全版）· 接口：<code>POST /admin/recruit-taskcard/generate</code>（只读生成）/
      <code>POST /admin/recruit-taskcard/confirm</code>（逐卡确认出物料）·
      把招募缺口写成可逐卡确认的任务卡
    </p>

    <el-alert
      class="notice"
      type="warning"
      :closable="false"
      show-icon
      title="本页只出物料，系统不对外发任何消息、也不建团长"
    >
      <template #default>
        批准一张卡，系统只吐出「可复制话术 + 申请路径」，由运营自己拿去发。
        <strong>投放前请确认目标用户已归属该楼</strong>（缺口楼没有团长，用户未绑楼会申请不了）。
        用户是否成为团长，由他在小程序自行申请决定。
      </template>
    </el-alert>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-button type="primary" :loading="generating" @click="generate">重新生成缺口卡</el-button>
      <span v-if="generatedAt" class="muted">生成于 {{ generatedAt }}</span>
      <el-button
        type="success"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="submitDecisions"
      >
        提交本批决策（{{ approvedCount }} 批准 / {{ skippedCount }} 跳过）
      </el-button>
    </div>

    <!-- ─────────────── 失败 / 提示 ─────────────── -->
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
      本次没有 AI 任务卡，请在后台看板查看原始缺口数据；不影响 GAP 计算本身。
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
        description="还没有任务卡 —— 点「重新生成缺口卡」"
      />

      <el-card
        v-for="c in rows"
        :key="c.buildingId"
        class="draft-card"
        :class="{ 'draft-card--skipped': decisions[c.buildingId] === 'skip' }"
        :body-style="{ padding: '14px 16px' }"
        shadow="hover"
      >
        <div class="draft-card__head">
          <div>
            <span class="draft-card__name">{{ c.buildingName }}</span>
            <el-tag size="small" type="info" class="tag-priority">优先级 {{ c.priority }}</el-tag>
            <span class="draft-card__stat"
              >近30天 {{ c.gap.orderCount30d }} 单 · GMV ¥{{ c.gap.gmv30d }}</span
            >
          </div>
          <el-radio-group v-model="decisions[c.buildingId]" size="small">
            <el-radio-button value="approve">批准</el-radio-button>
            <el-radio-button value="skip">跳过</el-radio-button>
          </el-radio-group>
        </div>

        <p class="draft-card__reason">{{ c.reason || '（AI 未给理由）' }}</p>
        <div class="draft-card__pitch">
          <span class="lbl">招募话术</span>
          <p>{{ c.pitchText }}</p>
        </div>
        <div class="draft-card__pitch">
          <span class="lbl">收益文案</span>
          <p>{{ c.estimatedEarningText }}</p>
        </div>
        <p class="muted">目标分群：{{ c.targetSegment }}</p>

        <!-- 批准后展开物料 -->
        <div v-if="materials[c.buildingId]" class="material">
          <el-alert
            class="notice"
            type="success"
            :closable="false"
            show-icon
            title="已批准：物料已生成（系统未代发任何消息）"
          >
            <template #default>{{ materials[c.buildingId]!.operatorNote }}</template>
          </el-alert>
          <div class="material__row">
            <code class="material__path">{{ materials[c.buildingId]!.applyPath }}</code>
            <el-button size="small" @click="copy(textOf(c.buildingId))">复制话术 + 路径</el-button>
          </div>
        </div>
        <div v-if="cardResults[c.buildingId] && !cardResults[c.buildingId]!.ok" class="material">
          <el-alert
            class="notice"
            type="warning"
            :closable="false"
            show-icon
            :title="`未出物料：${cardResults[c.buildingId]!.reason || '实时复核未通过'}`"
          />
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 后台 · 招募任务卡（#G 安全版）
 * ==================================================================
 * 把「招募缺口数据」交给 AI 写成逐卡可确认的任务卡；运营逐张勾选批准，
 * 系统只产出「可复制话术 + 裸申请路径」物料并记台账 —— 不对外发消息、
 * 不建团长、不替用户申请（C3 提交即生效，团长身份由真人自己决定）。
 *
 * 逐卡确认：一批可含多卡，服务端逐卡独立复核（已被覆盖的楼拦下不出物料，
 * 不影响同批其它卡）。批准结果在此页展开物料，未通过的卡给出原因。
 */
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';

import {
  confirmRecruitTaskCards,
  generateRecruitTaskCards,
  type ConfirmCardResult,
  type RecruitTaskCard,
  type RecruitTaskCardGenResult,
} from '@/api/recruit-taskcard';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';

type Decision = 'approve' | 'skip';

const generating = ref(false);
const submitting = ref(false);
const rows = ref<RecruitTaskCard[]>([]);
const notes = ref<string[]>([]);
const failure = ref('');
const degraded = ref(false);
const generatedAt = ref('');
const decisions = ref<Record<number, Decision>>({});
const materials = ref<Record<number, NonNullable<ConfirmCardResult['material']>>>({});
const cardResults = ref<Record<number, ConfirmCardResult>>({});

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

async function generate(): Promise<void> {
  generating.value = true;
  failure.value = '';
  degraded.value = false;
  rows.value = [];
  notes.value = [];
  decisions.value = {};
  materials.value = {};
  cardResults.value = {};
  generatedAt.value = '';
  try {
    const r: RecruitTaskCardGenResult = await generateRecruitTaskCards();
    generatedAt.value = r.generatedAt || '';
    notes.value = r.notes ?? [];
    degraded.value = Boolean(r.degraded) || !r.ok;
    if (!r.ok && r.message) {
      const gapHint = r.gaps?.length
        ? ` 原始缺口：${r.gaps.map((g) => g.buildingName || `#${g.buildingId}`).join('、')}`
        : '';
      failure.value = r.message + gapHint;
    }
    rows.value = r.cards ?? [];
    if (!rows.value.length) {
      ElMessage.warning('这次没有可用任务卡，看下面的提示');
      return;
    }
    ElMessage.success(`缺口卡 ${rows.value.length} 张，逐张勾选后提交`);
  } catch (e) {
    failure.value = errText(e);
  } finally {
    generating.value = false;
  }
}

async function submitDecisions(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  failure.value = '';
  const payload = rows.value
    .filter((c) => decisions.value[c.buildingId])
    .map((c) => ({
      buildingId: c.buildingId,
      decision: decisions.value[c.buildingId]!,
      // 原卡话术随决策回传：服务端复核后沿用这段出物料，卡片与复制内容才一致
      pitchText: c.pitchText,
      estimatedEarningText: c.estimatedEarningText,
      reason: c.reason,
    }));
  try {
    const r = await confirmRecruitTaskCards(payload);
    for (const res of r.results) {
      cardResults.value[res.buildingId] = res;
      if (res.ok && res.decision === 'approve' && res.material) {
        materials.value[res.buildingId] = res.material;
      }
    }
    // 批准的卡从待决区移除勾选态，避免重复提交
    for (const c of rows.value) {
      if (decisions.value[c.buildingId] === 'approve') delete decisions.value[c.buildingId];
    }
    ElMessage.success(`已批准 ${r.approvedCount} 张（物料已生成），跳过 ${r.skippedCount} 张`);
  } catch (e) {
    failure.value = errText(e);
  } finally {
    submitting.value = false;
  }
}

function textOf(buildingId: number): string {
  const m = materials.value[buildingId];
  if (!m) return '';
  return `【招募话术】\n${m.pitchText}\n\n【收益文案】\n${m.estimatedEarningText}\n\n【申请路径】\n${m.applyPath}`;
}

async function copy(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制话术 + 路径');
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
  gap: 12px;
  margin-bottom: 10px;
}

.draft-card__name {
  font-size: 15px;
  font-weight: 600;
  margin-right: 8px;
}

.tag-priority {
  margin-right: 8px;
}

.draft-card__stat {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.draft-card__reason {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin: 0 0 8px;
}

.draft-card__pitch {
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 6px;
}

.draft-card__pitch .lbl {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.draft-card__pitch p {
  font-size: 13px;
  line-height: 1.7;
  margin: 2px 0 0;
}

.material {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--el-border-color);
}

.material__row {
  display: flex;
  align-items: center;
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
