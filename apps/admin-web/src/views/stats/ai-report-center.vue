<template>
  <div class="page-container">
    <h2 class="page-container__title">AI 报告中心</h2>
    <p class="page-container__meta">
      平台页 / 模块：9 类经营报告的生成与回看 ｜ 数据来源：`ab_ai_insight` ｜ 本地 / 每日 09:00
      编排留档
    </p>

    <el-alert class="notice" type="info" :closable="false" show-icon>
      <template #title> 这里只「生成报告并留档」，不做任何执行。 </template>
      <template #default>
        点「批量生成」会把 7
        类编排内报告各跑一遍、原文存进台账，<strong>不推送企微、不发券、不改订单</strong>。
        文案素材、提审材料包属独立生成（走各自入口），不进批量。报告是给人看的判断依据；真要发券、排套餐、处置团长，仍去对应业务页人工操作。
      </template>
    </el-alert>

    <el-card shadow="never" class="block">
      <div class="toolbar">
        <span class="toolbar__hint">共 {{ reportKinds.length }} 类报告</span>
        <div class="toolbar__right">
          <el-button :loading="listing" @click="reload">刷新</el-button>
          <el-button type="primary" :loading="generating" @click="openGenerate">
            批量生成报告
          </el-button>
        </div>
      </div>

      <div class="cards">
        <div v-for="k in reportKinds" :key="k.kind" class="report-card">
          <div class="report-card__head">
            <span class="report-card__title">{{ k.label }}</span>
            <span class="report-card__kind">{{ k.kind }}</span>
          </div>
          <div v-if="!k.batch" class="report-card__tag">独立生成</div>
          <div class="report-card__body">
            <span class="report-card__count">{{ latestCount(k.kind) }}</span>
            <span class="report-card__unit">份留档</span>
          </div>
          <div class="report-card__foot">
            <span v-if="latestAt(k.kind)">最近 {{ fmtTime(latestAt(k.kind)) }}</span>
            <span v-else class="report-card__none">暂无记录</span>
          </div>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <div class="toolbar">
        <el-select
          v-model="kind"
          placeholder="全部报告类型"
          clearable
          class="toolbar__select"
          @change="onFilter"
        >
          <el-option v-for="k in reportKinds" :key="k.kind" :label="k.label" :value="k.kind" />
        </el-select>
        <div class="toolbar__right">
          <span class="hint">共 {{ total }} 条</span>
        </div>
      </div>
      <el-table v-loading="listing" :data="rows" size="small" row-key="id">
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="报告类型" width="130">
          <template #default="{ row }">{{ kindLabel(row.kind) }}</template>
        </el-table-column>
        <el-table-column label="标题 / 摘要" min-width="360">
          <template #default="{ row }">
            <el-link type="primary" :underline="false" @click="open(row.id)">{{
              row.title
            }}</el-link>
            <div class="excerpt">{{ row.excerpt }}</div>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.source === 'cron' ? 'info' : 'success'" effect="plain">
              {{
                row.source === 'cron' ? '自动编排' : row.source === 'admin' ? '后台生成' : '企微'
              }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button link type="primary" @click="open(row.id)">查看原文</el-button>
          </template>
        </el-table-column>
        <template #empty
          ><div class="empty">还没有报告。点上方「批量生成报告」跑一份。</div></template
        >
      </el-table>
      <el-pagination
        v-if="total > pageSize"
        class="pager"
        layout="prev, pager, next, jumper"
        :current-page="page"
        :page-size="pageSize"
        :total="total"
        @current-change="onPage"
      />
    </el-card>

    <!-- 批量生成结果 -->
    <el-dialog v-model="genVisible" title="批量生成报告" width="640px">
      <div v-if="genResult" class="gen">
        <p class="gen__note">
          已生成 {{ genResult.generated }} 份报告并留档，
          <strong>未推送企微（pushed={{ String(genResult.pushed) }}）</strong>。
        </p>
        <el-table :data="genResult.nodes" size="small" border>
          <el-table-column label="节点" width="150" prop="title" />
          <el-table-column label="结果" width="90">
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="row.skipped ? 'warning' : row.ok ? 'success' : 'danger'"
                effect="plain"
              >
                {{ row.skipped ? '跳过' : row.ok ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="摘要" min-width="260">
            <template #default="{ row }">{{ firstLine(row.text) }}</template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer
        ><el-button type="primary" @click="genVisible = false">完成</el-button></template
      >
    </el-dialog>

    <!-- 详情抽屉：原样展示 Markdown 全文 -->
    <el-drawer v-model="drawer" :title="detail?.title ?? '报告原文'" size="640px">
      <div v-if="detail" class="detail">
        <div class="detail__meta">
          <span>{{ kindLabel(detail.kind) }}</span>
          <span>· {{ fmtTime(detail.createdAt) }}</span>
        </div>
        <pre class="detail__content">{{ detail.content }}</pre>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import { generateReports, type DailyNodeResult } from '@/api/ai-report';
import {
  getInsight,
  listInsights,
  type InsightDetail,
  type InsightListItem,
} from '@/api/ai-insight';

/** 9 类报告节点（kind 与后端台账一致，对应编排的 9 个纯报告节点） */
/** 9 类报告节点（kind 与后端台账一致）。batch=false 的两类不在 12 节点编排里，走各自独立入口 */
const reportKinds: Array<{ kind: string; label: string; batch: boolean }> = [
  { kind: 'campaign', label: '文案素材', batch: false },
  { kind: 'launch-pack', label: '提审材料', batch: false },
  { kind: 'daily-report', label: '运营日报', batch: true },
  { kind: 'meal-proposal', label: '选品提案', batch: true },
  { kind: 'demand-forecast', label: '需求预测', batch: true },
  { kind: 'growth-experiment', label: '增长实验', batch: true },
  { kind: 'risk-recon', label: '风控对账', batch: true },
  { kind: 'health-score', label: '经营健康度', batch: true },
  { kind: 'refund-cluster', label: '退款聚类', batch: true },
];
const kindLabel = (k: string): string => reportKinds.find((x) => x.kind === k)?.label ?? k;

const listing = ref(false);
const generating = ref(false);
const rows = ref<InsightListItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const kind = ref('');
/** 每个 kind 的最近记录（从当前筛选外的全量一次取回，用于卡片计数） */
const latest = ref<Record<string, InsightListItem>>({});

const drawer = ref(false);
const detail = ref<InsightDetail | null>(null);
const genVisible = ref(false);
const genResult = ref<{ nodes: DailyNodeResult[]; pushed: false; generated: number } | null>(null);

async function reload(): Promise<void> {
  listing.value = true;
  try {
    const r = await listInsights({ kind: kind.value || undefined, page: page.value, pageSize });
    rows.value = r.list;
    total.value = r.total;
    await reloadLatest();
  } finally {
    listing.value = false;
  }
}

async function reloadLatest(): Promise<void> {
  // 逐类取第一条（pageSize=1）拼卡片摘要；失败不影响主列表
  const out: Record<string, InsightListItem> = {};
  await Promise.all(
    reportKinds.map(async (k) => {
      try {
        const r = await listInsights({ kind: k.kind, page: 1, pageSize: 1 });
        if (r.list[0]) out[k.kind] = r.list[0];
      } catch {
        /* 单类失败留空 */
      }
    }),
  );
  latest.value = out;
}

const latestCount = (k: string): number => (latest.value[k] ? 1 : 0);
const latestAt = (k: string): string | null => latest.value[k]?.createdAt ?? null;

function onFilter(): void {
  page.value = 1;
  void reload();
}
function onPage(p: number): void {
  page.value = p;
  void reload();
}

async function open(id: number): Promise<void> {
  drawer.value = true;
  detail.value = null;
  try {
    detail.value = await getInsight(id);
  } catch {
    ElMessage.error('读取报告失败');
  }
}

async function openGenerate(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将把 7 类编排内报告各跑一遍并留档（不推送企微、不发券、不改订单）。报告生成需要一点时间，确定继续？',
      '批量生成报告',
      { type: 'info', confirmButtonText: '确定生成', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  generating.value = true;
  try {
    genResult.value = await generateReports(reportKinds.filter((k) => k.batch).map((k) => k.kind));
    genVisible.value = true;
    await reload();
  } catch {
    ElMessage.error('生成失败，请稍后重试');
  } finally {
    generating.value = false;
  }
}

function fmtTime(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function firstLine(s: string): string {
  return (
    (s ?? '')
      .split('\n')
      .find((x) => x.trim())
      ?.slice(0, 60) ?? '—'
  );
}

onMounted(() => void reload());
</script>

<style scoped>
.notice {
  margin-bottom: 1rem;
}
.block {
  margin-bottom: 1rem;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.toolbar__hint {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.toolbar__right {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.toolbar__select {
  width: 180px;
}
.hint {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
}
.report-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 12px;
}
.report-card__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.report-card__title {
  font-size: 14px;
  font-weight: 500;
}
.report-card__kind {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.report-card__tag {
  display: inline-block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 1px 6px;
}
.report-card__body {
  margin: 12px 0 8px;
}
.report-card__count {
  font-size: 22px;
  font-weight: 500;
}
.report-card__unit {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 4px;
}
.report-card__foot {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.report-card__none {
  color: var(--el-text-color-placeholder);
}
.excerpt {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
.gen__note {
  font-size: 13px;
  margin-top: 0;
}
.detail__meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
}
.detail__content {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
}
</style>
