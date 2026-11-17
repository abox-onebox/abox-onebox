<template>
  <div class="page-container">
    <h2 class="page-container__title">用户召回</h2>
    <p class="page-container__meta">
      AI 编排节点 M（主动唤醒）· 接口：<code>POST /admin/recall-campaign/preview</code>（只读圈人）/
      <code>POST /admin/recall-campaign/confirm</code>（真发券）· 基于有效订单圈出复购客 /
      流失客，人工确认后批量发券
    </p>

    <el-alert
      class="notice"
      type="warning"
      :closable="false"
      show-icon
      title="生成只圈人不发券；只有「确认发放」才会真建券种、真发到用户账户"
    >
      <template #default>
        系统按有效订单自动分档，<strong>人群与券方案均为「测算示例」</strong>（面额 /
        门槛在后端定义，
        页面只展示不可改）。默认走<strong>试算</strong>，只报命中人数不写库；真发需勾选档位并二次确认。
        发放即真触达用户，请确认人群口径后再操作。
      </template>
    </el-alert>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-button type="primary" :loading="previewing" @click="preview">生成召回预览</el-button>
      <span v-if="generatedAt" class="muted">圈人于 {{ generatedAt }}</span>
      <el-checkbox v-model="dryRun" class="dryrun">试算模式（不写库、不发券）</el-checkbox>
      <el-button
        type="danger"
        :loading="confirming"
        :disabled="!canConfirm || !canIssue"
        @click="issue"
      >
        {{ dryRun ? '试算发放结果' : '确认发放' }}
      </el-button>
    </div>

    <el-alert
      v-if="!canConfirm"
      class="notice"
      type="info"
      :closable="false"
      show-icon
      title="只读权限：你可生成预览、试算，但不能真发券"
    >
      真发券仅负责人（super_admin / admin）可操作；operator 只能圈人查看。
    </el-alert>

    <el-alert
      v-if="failure"
      class="notice"
      type="error"
      :closable="false"
      show-icon
      :title="failure"
    />

    <!-- ─────────────── 圈人结果 ─────────────── -->
    <div v-loading="previewing" class="draft-list">
      <el-empty
        v-if="!rows.length && !previewing"
        description="还没有预览 —— 点「生成召回预览」圈人"
      />

      <el-card
        v-for="s in rows"
        :key="s.segment"
        class="draft-card"
        :class="{ 'draft-card--picked': picked[s.segment] }"
        :body-style="{ padding: '14px 16px' }"
        shadow="hover"
      >
        <div class="draft-card__head">
          <div>
            <span class="draft-card__name">{{ segmentLabel(s.segment) }}</span>
            <span class="draft-card__stat">命中 {{ s.count }} 人</span>
          </div>
          <el-checkbox v-model="picked[s.segment]" :disabled="s.count === 0">
            纳入本次发放
          </el-checkbox>
        </div>

        <div class="coupon-spec">
          <span class="lbl">券方案（测算示例）</span>
          <span>{{ s.coupon.name }}</span>
          <span class="spec-item">面额 ¥{{ fenToYuan(s.coupon.faceValueFen) }}</span>
          <span class="spec-item">
            门槛 {{ s.coupon.thresholdFen > 0 ? `¥${fenToYuan(s.coupon.thresholdFen)}` : '无门槛' }}
          </span>
          <span class="spec-item">有效期 {{ s.coupon.validDays }} 天</span>
        </div>

        <p class="muted">{{ rangeNote }}</p>
      </el-card>
    </div>

    <!-- ─────────────── 发放结果 ─────────────── -->
    <div v-if="result" class="result">
      <el-alert
        class="notice"
        :type="result.reason ? 'warning' : 'success'"
        :closable="false"
        show-icon
        :title="resultTitle"
      >
        <template #default>
          <p>发放批次与台账已记录，可在「AI 洞察」页按 kind=<code>recall-campaign</code> 查回。</p>
          <p v-if="result.reason">企微摘要推送失败：{{ result.reason }}</p>
          <p class="muted">
            {{ dryRun ? '本次为试算，未发券、未写业务库。' : '本次为真发券，已触达用户账户。' }}
          </p>
        </template>
      </el-alert>
      <el-table :data="result.segments" size="small" border>
        <el-table-column prop="segment" label="档位" :formatter="segFmt" width="120" />
        <el-table-column prop="targetCount" label="命中人数" width="110" />
        <el-table-column prop="couponDefId" label="券种 ID" width="100" />
        <el-table-column prop="grantedCount" label="发放张数" width="110" />
        <el-table-column prop="skippedCount" label="跳过张数" width="110" />
        <el-table-column prop="batchNo" label="批次号" min-width="180" />
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 后台 · 用户召回（#M 主动唤醒闭环）
 * ==================================================================
 * 后端闭环早已完整（preview 零副作用圈人 / confirm 建券种 + 批量发券 + 幂等 +
 * 台账 + 企微推送），本页是把闭环接到运营手上的最后一块。
 *
 * 安全设计（比 G 的「只出物料」更敏感 —— 这里是真发券到用户账户）：
 * - 进页只读圈人，不写库；
 * - 试算默认开启，接口默认值也是 dryRun=true（漏传不会真发）；
 * - 真发必须勾选档位 + ElMessageBox 二次确认；
 * - 前端 canConfirm 与后端 confirm 方法级 @Roles 双重收紧，operator 只能圈人查看。
 */
import { computed, h, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  recallConfirm,
  recallPreview,
  type RecallConfirmResult,
  type RecallPreview,
  type RecallSegment,
  type SegmentPlan,
} from '@/api/recall-campaign';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';

const previewing = ref(false);
const confirming = ref(false);
const rows = ref<SegmentPlan[]>([]);
const generatedAt = ref('');
const rangeNote = ref('');
const dryRun = ref(true);
const picked = ref<Record<RecallSegment, boolean>>({ repurchase: false, churn: false });
const failure = ref('');
const result = ref<RecallConfirmResult | null>(null);

const auth = useAuthStore();
const canConfirm = computed(() => auth.role === 'super_admin' || auth.role === 'admin');
const pickedSegments = computed(() =>
  (['repurchase', 'churn'] as RecallSegment[]).filter(
    (s) => picked.value[s] && (rows.value.find((r) => r.segment === s)?.count ?? 0) > 0,
  ),
);
const canIssue = computed(() => pickedSegments.value.length > 0);
const resultTitle = computed(() =>
  dryRun.value ? '试算完成（未发券、未写库）' : '发放完成（已真发券到用户账户）',
);

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message || `请求失败（${e.code}）`;
  return e instanceof Error ? e.message : '请求失败';
}

function segmentLabel(s: RecallSegment): string {
  return s === 'repurchase' ? '复购客' : '流失客';
}

function fenToYuan(fen: number): string {
  return (fen / 100).toFixed(2);
}

function segFmt(row: { segment: RecallSegment }): string {
  return segmentLabel(row.segment);
}

async function preview(): Promise<void> {
  previewing.value = true;
  failure.value = '';
  result.value = null;
  rows.value = [];
  generatedAt.value = '';
  picked.value = { repurchase: false, churn: false };
  try {
    const r: RecallPreview = await recallPreview();
    rows.value = r.segments ?? [];
    generatedAt.value = r.generatedAt || '';
    rangeNote.value = r.rangeNote || '';
    ElMessage.success(
      `圈人完成：${rows.value.map((s) => `${segmentLabel(s.segment)} ${s.count} 人`).join('、')}`,
    );
  } catch (e) {
    failure.value = errText(e);
  } finally {
    previewing.value = false;
  }
}

async function issue(): Promise<void> {
  if (!canConfirm.value || !canIssue.value) return;
  const segs = pickedSegments.value;
  const total = segs.reduce((n, s) => n + (rows.value.find((r) => r.segment === s)?.count ?? 0), 0);
  const detail = segs.map((s) => {
    const row = rows.value.find((r) => r.segment === s);
    return `${segmentLabel(s)} ${row?.count ?? 0} 人 · 面额 ¥${fenToYuan(row?.coupon.faceValueFen ?? 0)}`;
  });

  try {
    await ElMessageBox.confirm(
      h('div', { style: 'line-height: 1.9' }, [
        h(
          'p',
          dryRun.value
            ? '【试算】只统计命中人数，不建券种、不发券、不写业务库。'
            : '【真发券】将建券种并把券发到下列用户账户（真触达）：',
        ),
        ...detail.map((t) => h('div', { style: 'margin: 2px 0 2px 10px' }, t)),
        h('p', { style: 'margin-top: 8px' }, `合计 ${total} 人。确定继续吗？`),
      ]),
      dryRun.value ? '确认试算' : '确认发放',
      {
        type: dryRun.value ? 'info' : 'warning',
        confirmButtonText: dryRun.value ? '开始试算' : '确认发放',
        cancelButtonText: '再想想',
      },
    );
  } catch {
    return; // 用户取消
  }

  confirming.value = true;
  failure.value = '';
  try {
    const r = await recallConfirm(segs, dryRun.value);
    result.value = r;
    if (r.reason) {
      ElMessage.warning('发放已执行，但企微摘要推送失败，详见结果');
    } else {
      ElMessage.success(dryRun.value ? '试算完成' : `发放完成，共 ${segs.length} 档`);
    }
    // 结果已出，清掉勾选态避免误点重复发放
    picked.value = { repurchase: false, churn: false };
  } catch (e) {
    failure.value = errText(e);
  } finally {
    confirming.value = false;
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

.dryrun {
  margin: 0 6px;
}

.draft-list {
  min-height: 120px;
}

.draft-card {
  margin-bottom: 12px;
}

.draft-card--picked {
  border-color: var(--el-color-primary);
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
  font-size: 13px;
}

.coupon-spec .lbl {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.spec-item {
  color: var(--el-text-color-regular);
}

.muted {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  margin: 8px 0 0;
  line-height: 1.7;
}

.result {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color);
}
</style>
