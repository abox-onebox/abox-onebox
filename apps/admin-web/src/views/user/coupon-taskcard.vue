<template>
  <div class="page-container">
    <h2 class="page-container__title">发券策略卡</h2>
    <p class="page-container__meta">
      AI 编排节点 H（安全版）· 接口：<code>POST /admin/coupon-taskcard/generate</code>（只读生成）/
      <code>POST /admin/coupon-taskcard/confirm</code>（逐卡确认出清单）· AI
      基于经营数据动态定券方案，运营挑卡后拿清单去券管理页发
    </p>

    <el-alert
      class="notice"
      type="warning"
      :closable="false"
      show-icon
      title="本页不发券、不建券种 —— 只出「可执行发券清单」"
    >
      <template #default>
        生成只读；确认一张卡，系统只吐出「scope + 券种 #id + 面额门槛 + 试算人群」清单并记台账，
        <strong>不碰用户账户</strong>。真发券请拿清单去「财务-代金券」页用批量发券执行， 发前先
        dryRun 试算。金额一律测算法，以券种实际定义为准。
      </template>
    </el-alert>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-button type="primary" :loading="generating" @click="generate">重新生成策略卡</el-button>
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
      本次没有 AI 策略卡，可在「AI 洞察」页看原始数据；不影响券种/楼栋数据本身。
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
        description="还没有策略卡 —— 点「重新生成策略卡」"
      />

      <el-card
        v-for="c in rows"
        :key="c.kind"
        class="draft-card"
        :class="{ 'draft-card--skipped': decisions[c.kind] === 'skip' }"
        :body-style="{ padding: '14px 16px' }"
        shadow="hover"
      >
        <div class="draft-card__head">
          <div>
            <span class="draft-card__name">{{ kindLabel(c.kind) }}</span>
            <el-tag size="small" type="info" class="tag-scope">
              {{ c.scope === 'building' ? `楼栋定向 · ${c.buildingName}` : '全部用户' }}
            </el-tag>
            <span class="draft-card__stat">试算人群 {{ c.targetCount }} 人</span>
          </div>
          <el-radio-group v-model="decisions[c.kind]" size="small">
            <el-radio-button value="approve">确认</el-radio-button>
            <el-radio-button value="skip">跳过</el-radio-button>
          </el-radio-group>
        </div>

        <div class="coupon-spec">
          <span class="lbl">券方案（以券种定义为准）</span>
          <span
            >{{ c.couponName }} <code>#{{ c.couponDefId }}</code></span
          >
          <span class="spec-item">面额 ¥{{ fenToYuan(c.faceValueFen) }}</span>
          <span class="spec-item">
            门槛 {{ c.thresholdFen > 0 ? `¥${fenToYuan(c.thresholdFen)}` : '无门槛' }}
          </span>
          <span class="spec-item">有效期 {{ c.validDays }} 天</span>
        </div>

        <p class="draft-card__reason">{{ c.reason || '（AI 未给理由）' }}</p>
        <p class="draft-card__budget">{{ c.budgetText }}</p>

        <!-- 确认后展开执行清单 -->
        <div v-if="executions[c.kind]" class="material">
          <el-alert
            class="notice"
            type="success"
            :closable="false"
            show-icon
            title="已确认：执行清单已生成（系统未发券）"
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
 * 后台 · 发券策略卡（#H 安全版）
 * ==================================================================
 * 把「经营数据 + 现有券种/楼栋白名单」交给 AI 写成结构化发券策略卡；运营逐张确认，
 * 系统只产出「可执行发券清单」并记台账 —— 不真发券、不建券种、不碰用户账户。
 *
 * 真发券仍走后台「批量发券」那一处入口：运营拿清单里的 scope + 券种 #id 过去，
 * 自己 dryRun 试算后确认。这样避免和 M 召回页、券管理页形成第三个发券入口。
 */
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';

import {
  confirmCouponTaskCards,
  generateCouponTaskCards,
  type CouponCardResult,
  type CouponExecution,
  type CouponStrategyCard,
  type CouponStrategyKind,
  type CouponTaskCardGenResult,
} from '@/api/coupon-taskcard';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';

type Decision = 'approve' | 'skip';

const generating = ref(false);
const submitting = ref(false);
const rows = ref<CouponStrategyCard[]>([]);
const notes = ref<string[]>([]);
const failure = ref('');
const degraded = ref(false);
const generatedAt = ref('');
const decisions = ref<Record<string, Decision>>({});
const executions = ref<Record<string, CouponExecution>>({});
const cardResults = ref<Record<string, CouponCardResult>>({});

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

function kindLabel(k: CouponStrategyKind): string {
  return (
    {
      newCustomer: '新客承接券',
      sleepWake: '沉睡唤醒券',
      buildingTarget: '楼栋定向券',
      repurchase: '复购激励券',
    }[k] || k
  );
}

function fenToYuan(fen: number): string {
  return (fen / 100).toFixed(2);
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
    const r: CouponTaskCardGenResult = await generateCouponTaskCards();
    generatedAt.value = r.generatedAt || '';
    notes.value = r.notes ?? [];
    degraded.value = Boolean(r.degraded) || !r.ok;
    if (!r.ok && r.message) failure.value = r.message;
    rows.value = r.cards ?? [];
    if (!rows.value.length) {
      ElMessage.warning('这次没有可用策略卡，看下面的提示');
      return;
    }
    ElMessage.success(`策略卡 ${rows.value.length} 张，逐张勾选后提交`);
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
    .filter((c) => decisions.value[c.kind])
    .map((c) => ({
      kind: c.kind,
      decision: decisions.value[c.kind]!,
      // 原卡回传：服务端复核后沿用其预算文案/理由，金额仍以实时券种为准
      card: c,
    }));
  try {
    const r = await confirmCouponTaskCards(payload);
    for (const res of r.results) {
      cardResults.value[res.kind] = res;
      if (res.ok && res.decision === 'approve' && res.execution) {
        executions.value[res.kind] = res.execution;
      }
    }
    for (const c of rows.value) {
      if (decisions.value[c.kind] === 'approve') delete decisions.value[c.kind];
    }
    ElMessage.success(`已确认 ${r.approvedCount} 张（清单已生成），跳过 ${r.skippedCount} 张`);
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
    `【${kindLabel(e.kind)} · 发券执行清单】\n` +
    `${e.executeHint}\n` +
    `券种 #${e.couponDefId} ${e.couponName}：面额 ¥${fenToYuan(e.faceValueFen)} / ` +
    `门槛 ${e.thresholdFen > 0 ? `¥${fenToYuan(e.thresholdFen)}` : '无门槛'} / 有效期 ${e.validDays} 天\n` +
    `试算人群 ${e.targetCount} 人\n` +
    `${e.budgetText}\n` +
    `（系统未发券；请去财务-代金券页 dryRun 试算后确认）`
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

.tag-scope {
  margin-right: 8px;
}

.draft-card__stat {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.coupon-spec {
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

.coupon-spec .lbl {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.spec-item {
  color: var(--el-text-color-regular);
}

.draft-card__reason {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin: 0 0 4px;
}

.draft-card__budget {
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
