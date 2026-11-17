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

    <el-card shadow="never" class="block preflight">
      <div class="toolbar">
        <span class="toolbar__hint">数据体检 · 今天有没有数据可算</span>
        <div class="toolbar__right">
          <span v-if="preflightAt" class="hint">检查于 {{ fmtTime(preflightAt) }}</span>
          <el-button :loading="preflightLoading" @click="loadPreflight">重新体检</el-button>
        </div>
      </div>
      <div v-if="preflightText" class="preflight__body">
        <el-tag :type="preflightTag" size="small" effect="light">{{ preflightGradeLabel }}</el-tag>
        <span class="preflight__headline">{{ preflightHeadline }}</span>
      </div>
      <pre v-if="preflightText" class="preflight__detail">{{ preflightText }}</pre>
      <p v-else-if="!preflightLoading" class="hint">
        还没有体检结果，点「重新体检」跑一次（只读，不写库）。
      </p>
    </el-card>

    <el-card shadow="never" class="block weekly">
      <div class="toolbar">
        <span class="toolbar__hint">本周汇总 · 只读预览（不推送）</span>
        <div class="toolbar__right">
          <span v-if="weekly" class="hint">{{ weekly.rangeFrom }} ~ {{ weekly.rangeTo }}</span>
          <el-button :loading="weeklyLoading" @click="loadWeekly">刷新汇总</el-button>
        </div>
      </div>
      <template v-if="weekly">
        <div class="weekly__stats">
          <span class="weekly__total">本周共 {{ weekly.total }} 条留档</span>
          <el-tag
            v-for="(count, k) in weeklyTopKinds"
            :key="k"
            size="small"
            effect="plain"
            class="weekly__tag"
          >
            {{ kindLabel(k) }} {{ count }}
          </el-tag>
        </div>
        <pre class="weekly__digest">{{ weekly.digest }}</pre>
      </template>
      <p v-else-if="!weeklyLoading" class="hint">还没有汇总，点「刷新汇总」看本周 AI 产出概览。</p>
    </el-card>

    <el-card shadow="never" class="block">
      <div class="toolbar">
        <span class="toolbar__hint">共 {{ reportKinds.length }} 类报告</span>
        <div class="toolbar__right">
          <el-button :loading="listing" @click="reload">刷新</el-button>
          <el-button :loading="backfilling" @click="openBackfill">回填效果</el-button>
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
        <el-select
          v-model="statusFilter"
          placeholder="全部状态"
          clearable
          class="toolbar__select"
          @change="onFilter"
        >
          <el-option label="待决策 (open)" value="open" />
          <el-option label="已采纳 (adopted)" value="adopted" />
          <el-option label="已忽略 (dismissed)" value="dismissed" />
        </el-select>
        <div class="toolbar__right">
          <el-tag v-if="pendingCount > 0" type="warning" size="small" effect="light">
            {{ pendingCount }} 条待决策
          </el-tag>
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
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)" effect="plain">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="190">
          <template #default="{ row }">
            <template v-if="row.status === 'open'">
              <el-button link type="success" @click="decide(row.id, 'adopted')">采纳</el-button>
              <el-button link type="info" @click="decide(row.id, 'dismissed')">忽略</el-button>
            </template>
            <el-button v-else link type="warning" @click="decide(row.id, 'open')"
              >退回待看</el-button
            >
            <el-button link type="primary" @click="open(row.id)">原文</el-button>
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
        <div v-if="detail.status === 'adopted'" class="detail__execution">
          <div class="detail__execution-head">
            <span class="detail__execution-title">执行跟踪</span>
            <el-tag :type="executionDone ? 'success' : 'warning'" size="small" effect="plain">
              {{ executionDone ? '已执行' : '待执行' }}
            </el-tag>
          </div>
          <p v-if="executionDone" class="detail__execution-meta">
            {{ executionDoneBy }} · {{ executionDoneAt }}
            <span v-if="executionNote"> · {{ executionNote }}</span>
          </p>
          <div class="detail__execution-actions">
            <el-button
              v-if="!executionDone"
              type="primary"
              size="small"
              :loading="execLoading"
              @click="markExec(true)"
            >
              标记已执行
            </el-button>
            <el-button v-else size="small" :loading="execLoading" @click="markExec(false)">
              撤销执行标记
            </el-button>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  backfillEffects,
  generateReports,
  getPreflight,
  getWeeklyDigest,
  type BackfillResult,
  type DailyNodeResult,
  type WeeklyDigest,
} from '@/api/ai-report';
import {
  decideInsight,
  getInsight,
  listInsights,
  markInsightExecution,
  type InsightDetail,
  type InsightExecution,
  type InsightListItem,
} from '@/api/ai-insight';

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
const backfilling = ref(false);
const rows = ref<InsightListItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const kind = ref('');
const statusFilter = ref('');
const pendingCount = ref(0);
/** 每个 kind 的最近记录（从当前筛选外的全量一次取回，用于卡片计数） */
const latest = ref<Record<string, InsightListItem>>({});

const drawer = ref(false);
const detail = ref<InsightDetail | null>(null);
const execLoading = ref(false);
const genVisible = ref(false);
const genResult = ref<{ nodes: DailyNodeResult[]; pushed: false; generated: number } | null>(null);

// 数据体检（只读）：解释报告为何降级
const preflightLoading = ref(false);
const preflightAt = ref('');
const preflightHeadline = ref('');
const preflightText = ref('');
const preflightGrade = ref('');
const preflightTag = (): 'success' | 'warning' | 'danger' | 'info' => {
  const g = preflightGrade.value;
  if (g === 'ok' || g === 'green') return 'success';
  if (g === 'yellow') return 'warning';
  if (g === 'red') return 'danger';
  return 'info';
};
const preflightGradeLabel = (): string =>
  (({ ok: '通过', green: '良好', yellow: '有缺口', red: '缺数据' }) as Record<string, string>)[
    preflightGrade.value
  ] ?? preflightGrade.value;
async function loadPreflight(): Promise<void> {
  preflightLoading.value = true;
  try {
    const r = await getPreflight();
    preflightAt.value = r.at;
    preflightGrade.value = r.result?.grade ?? '';
    preflightHeadline.value = r.result?.headline ?? '';
    preflightText.value = r.text ?? '';
  } catch {
    preflightText.value = '数据体检没取到（接口异常），不影响报告页其它功能。';
  } finally {
    preflightLoading.value = false;
  }
}

// 本周汇总（只读预览，后端强制 dryRun）
const weeklyLoading = ref(false);
const weekly = ref<WeeklyDigest | null>(null);
const weeklyTopKinds = (): Record<string, number> => {
  const byKind = weekly.value?.byKind ?? {};
  return Object.fromEntries(
    Object.entries(byKind)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6),
  );
};
async function loadWeekly(): Promise<void> {
  weeklyLoading.value = true;
  try {
    weekly.value = await getWeeklyDigest();
  } catch {
    weekly.value = null;
  } finally {
    weeklyLoading.value = false;
  }
}

async function reload(): Promise<void> {
  listing.value = true;
  try {
    const r = await listInsights({
      kind: kind.value || undefined,
      status: statusFilter.value || undefined,
      page: page.value,
      pageSize,
    });
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

/** 待决策计数：只统计 open，供顶部提示；失败不影响列表 */
async function loadPending(): Promise<void> {
  try {
    const r = await listInsights({ status: 'open', page: 1, pageSize: 1 });
    pendingCount.value = r.total;
  } catch {
    pendingCount.value = 0;
  }
}

/** 标记决策：只写台账 status，不碰任何业务表 */
async function decide(id: number, status: 'open' | 'adopted' | 'dismissed'): Promise<void> {
  try {
    await decideInsight(id, status);
    ElMessage.success(
      status === 'open' ? '已退回待看' : status === 'adopted' ? '已采纳' : '已忽略',
    );
    await Promise.all([reload(), loadPending()]);
  } catch {
    ElMessage.error('标记失败，请稍后重试');
  }
}

function statusLabel(s: string): string {
  return (
    ({ open: '待决策', adopted: '已采纳', dismissed: '已忽略' } as Record<string, string>)[s] ?? s
  );
}
function statusTag(s: string): 'warning' | 'success' | 'info' {
  if (s === 'open') return 'warning';
  if (s === 'adopted') return 'success';
  return 'info';
}
function onPage(p: number): void {
  page.value = p;
  void reload();
}

const currentExecution = (): InsightExecution | null => {
  const m = detail.value?.meta?.execution;
  return m && typeof m === 'object' ? (m as InsightExecution) : null;
};
const executionDone = computed<boolean>(() => currentExecution()?.done === true);
const executionDoneBy = computed<string>(() => currentExecution()?.doneBy ?? '—');
const executionDoneAt = computed<string>(() => currentExecution()?.doneAt ?? '—');
const executionNote = computed<string>(() => currentExecution()?.note ?? '');

async function markExec(done: boolean): Promise<void> {
  if (!detail.value) return;
  execLoading.value = true;
  try {
    const r = await markInsightExecution(detail.value.id, done);
    // 本地即时更新 meta，免得关抽屉再看；只动台账回显，不碰业务数据
    if (detail.value.meta && typeof detail.value.meta === 'object') {
      detail.value.meta.execution = r.execution;
    } else {
      detail.value.meta = { execution: r.execution };
    }
    ElMessage.success(done ? '已标记执行' : '已撤销执行标记');
  } catch {
    ElMessage.error('标记失败，请稍后重试');
  } finally {
    execLoading.value = false;
  }
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

async function openBackfill(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '扫所有「已采纳且已标记执行」的建议，按生成后 7 天的业务增量回填效果背景（券核销/新增团长/订单）。只读业务表、只写台账，可重复跑。确定继续？',
      '回填效果背景',
      { type: 'info', confirmButtonText: '开始回填', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  backfilling.value = true;
  try {
    const r: BackfillResult = await backfillEffects(7);
    ElMessage.success(
      '扫描 ' +
        r.scanned +
        ' 条，回填 ' +
        r.filled +
        ' 条' +
        (r.degraded ? '，降级 ' + r.degraded + ' 条' : '') +
        '（业务快照为相关性背景，非因果归因）',
    );
  } catch {
    ElMessage.error('回填失败，请稍后重试');
  } finally {
    backfilling.value = false;
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

onMounted(() => {
  void reload();
  void loadPending();
  void loadPreflight();
  void loadWeekly();
});
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
.preflight__body {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.preflight__headline {
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.preflight__detail {
  margin: 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
.weekly__stats {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.weekly__total {
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.weekly__tag {
  margin-right: 2px;
}
.weekly__digest {
  margin: 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
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
.detail__execution {
  margin-top: 1.5rem;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.detail__execution-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.detail__execution-title {
  font-size: 14px;
  font-weight: 500;
}
.detail__execution-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 0 0 10px;
}
.detail__execution-actions {
  display: flex;
  gap: 8px;
}
</style>
