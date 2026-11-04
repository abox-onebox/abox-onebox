<template>
  <div class="page-container">
    <h2 class="page-container__title">AI 台账</h2>
    <p class="page-container__meta">
      平台页 / 模块：AI 产出留档 ｜ 数据来源：`ab_ai_insight` ｜ 覆盖 15 个 AI 节点（企微触发 ·
      后台触发 · 每日 09:00 自动编排）
    </p>

    <el-alert class="notice" type="info" :closable="false" show-icon>
      <template #title> 这里存的是「AI 当时说了什么」，不是「我们做了什么」。 </template>
      <template #default>
        企微会话 10 分钟就过期、每日编排推完只留一行日志，所以以前 AI 的结论是一次性的。
        现在每次生成都留一份原文，可以回看、可以标记采纳与否。
        <strong>标记只是给自己留个记号，不会自动执行任何操作</strong
        >（发券、排套餐、改价都要另外在对应页面做）。
      </template>
    </el-alert>

    <el-card shadow="never" class="block">
      <div class="toolbar">
        <el-select
          v-model="kind"
          placeholder="全部类型"
          clearable
          class="toolbar__select"
          @change="reload"
        >
          <el-option v-for="k in kindOptions" :key="k.value" :label="k.label" :value="k.value" />
        </el-select>
        <el-select
          v-model="status"
          placeholder="全部状态"
          clearable
          class="toolbar__select"
          @change="reload"
        >
          <el-option label="待看" value="open" />
          <el-option label="已采纳" value="adopted" />
          <el-option label="已忽略" value="dismissed" />
        </el-select>
        <div class="toolbar__right">
          <span class="hint">共 {{ total }} 条</span>
          <el-button :loading="loading" @click="reload">刷新</el-button>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <el-table v-loading="loading" :data="rows" size="small" row-key="id">
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="类型" width="130">
          <template #default="{ row }">{{ kindLabel(row.kind) }}</template>
        </el-table-column>
        <el-table-column label="标题 / 摘要" min-width="320">
          <template #default="{ row }">
            <el-link type="primary" :underline="false" @click="open(row.id)">
              {{ row.title }}
            </el-link>
            <div class="excerpt">{{ row.excerpt }}</div>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="sourceTag(row.source)" effect="plain">
              {{ sourceLabel(row.source) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)" effect="plain">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button link type="primary" @click="open(row.id)">查看</el-button>
            <el-dropdown trigger="click" @command="(c: string) => mark(row.id, c)">
              <el-button link type="primary">标记</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="adopted" :disabled="row.status === 'adopted'">
                    采纳（只做记号）
                  </el-dropdown-item>
                  <el-dropdown-item command="dismissed" :disabled="row.status === 'dismissed'">
                    忽略
                  </el-dropdown-item>
                  <el-dropdown-item command="open" :disabled="row.status === 'open'">
                    退回待看
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty">
            还没有留档。
            <template v-if="!kind && !status">
              去企微说一句「生成运营日报」，或等明天 09:00 自动编排，这里就会有记录。
            </template>
          </div>
        </template>
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

    <!-- 详情抽屉：正文按**原始文本**展示，不渲染 markdown -->
    <el-drawer v-model="drawer" :title="detail?.title ?? '详情'" size="640px">
      <div v-if="detail" class="detail">
        <div class="detail__meta">
          <span>{{ fmtTime(detail.createdAt) }}</span>
          <span>· {{ kindLabel(detail.kind) }}</span>
          <span>· {{ sourceLabel(detail.source) }}</span>
          <span v-if="detail.actorName">· {{ detail.actorName }}</span>
          <span v-if="modeText"> · {{ modeText }}</span>
        </div>

        <el-alert
          v-if="detail.status !== 'open'"
          class="detail__status"
          :type="detail.status === 'adopted' ? 'success' : 'info'"
          :closable="false"
          :title="`已标记为「${statusLabel(detail.status)}」${detail.decidedBy ? ' · ' + detail.decidedBy : ''}`"
        />

        <!--
          用 <pre> 原样展示：
          ① 内容是 Markdown，渲染成 HTML 会把库里的楼群/套餐名当标签解析（注入）；
          ② 报告的价值就在「原文一字不改」—— 折行、缩进、列表层级都承载语义。
        -->
        <pre class="detail__content">{{ detail.content }}</pre>

        <div class="detail__actions">
          <el-button
            type="primary"
            :disabled="detail.status === 'adopted'"
            @click="mark(detail.id, 'adopted')"
          >
            采纳（只做记号）
          </el-button>
          <el-button
            :disabled="detail.status === 'dismissed'"
            @click="mark(detail.id, 'dismissed')"
          >
            忽略
          </el-button>
          <el-button :disabled="detail.status === 'open'" @click="mark(detail.id, 'open')">
            退回待看
          </el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import {
  decideInsight,
  getInsight,
  listInsightKinds,
  listInsights,
  type InsightDetail,
  type InsightListItem,
} from '@/api/ai-insight';

/**
 * AI 台账（`/stats/ai-insight`）
 *
 * ## 这一页解决什么
 * 15 个 AI 节点的产出以前是「生成即消失」：企微会话 10 分钟过期，
 * 每日 09:00 编排只留一行「推了 N 字」日志。于是「上周 AI 说该上哪几个品」
 * 只能重新生成，而 LLM 非确定 —— **上次那个说法永久丢失**。
 *
 * ## 一个刻意的取舍：正文不渲染 markdown
 * 用 `<pre>` 原样展示。渲染成 HTML 有注入风险（AI 报告里嵌了库中的楼群名/套餐名），
 * 而报告的价值恰恰在「原文一字不改」。代价是能看到 `#` `·` 这些记号 —— 可接受。
 *
 * ## 「采纳」不是「执行」
 * 只是给自己留记号。一键执行是下一批（实体里 `payload_json` 已预留位置），
 * 因为每个节点的执行动作（发券/建模板/招募/排期）可撤销性与错判代价都不同，
 * 一次性统一做必然有一半是错的。UI 上每处都写明了，避免误以为点了就生效。
 */

/** 节点名 → 人话。**不写死枚举**：库里出现新 kind 时退回原值显示，不会崩也不会空白 */
const KIND_LABEL: Record<string, string> = {
  'daily-report': '运营日报',
  'meal-proposal': '选品提案',
  'recruit-proposal': '招募提案',
  'coupon-strategy': '发券策略',
  'demand-forecast': '需求预测',
  'growth-experiment': '增长实验',
  'risk-recon': '风控对账',
  'churn-recall': '流失召回',
  'leader-health': '团长健康度',
  'health-score': '经营健康度',
  'community-plan': '社群排期',
  'refund-cluster': '退款根因',
  'launch-draft': '开团草稿',
  campaign: '招募文案',
  'launch-pack': '提审材料包',
};

const loading = ref(false);
const rows = ref<InsightListItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const kind = ref('');
const status = ref('');

const kindOptions = ref<Array<{ value: string; label: string }>>([]);

const drawer = ref(false);
const detail = ref<InsightDetail | null>(null);

const modeText = computed(() => {
  const m = detail.value?.meta;
  if (!m || typeof m !== 'object') return '';
  const mode = (m as Record<string, unknown>).mode;
  const ms = (m as Record<string, unknown>).elapsedMs;
  const parts: string[] = [];
  // `rules` 是降级到规则兜底，可信度与真调模型差一个量级 —— 必须显式提示
  if (mode === 'rules' || mode === 'stub') parts.push('占位/规则模式产出（未调模型）');
  if (typeof ms === 'number') parts.push(`耗时 ${(ms / 1000).toFixed(1)}s`);
  return parts.join(' · ');
});

function kindLabel(k: string): string {
  return KIND_LABEL[k] ?? k;
}

function sourceLabel(s: string): string {
  return s === 'cron' ? '自动' : s === 'admin' ? '后台' : s === 'chat' ? '企微' : s;
}

function sourceTag(s: string): 'success' | 'warning' | 'info' {
  return s === 'cron' ? 'info' : s === 'admin' ? 'warning' : 'success';
}

function statusLabel(s: string): string {
  return s === 'adopted' ? '已采纳' : s === 'dismissed' ? '已忽略' : '待看';
}

function statusTag(s: string): 'success' | 'info' | 'warning' {
  return s === 'adopted' ? 'success' : s === 'dismissed' ? 'info' : 'warning';
}

/** 时间是后端转好的 `YYYY-MM-DDTHH:mm:ss+08:00`；只截到分钟给人看 */
function fmtTime(s: string | null): string {
  if (!s) return '—';
  return s.replace('T', ' ').slice(0, 16);
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    const r = await listInsights({
      kind: kind.value || undefined,
      status: status.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = r.list;
    total.value = r.total;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadKinds(): Promise<void> {
  try {
    const r = await listInsightKinds();
    kindOptions.value = r.list.map((x) => ({
      value: x.kind,
      label: `${kindLabel(x.kind)}（${x.count}）`,
    }));
  } catch {
    // 下拉拿不到不影响主列表：退回「只有全部」的可用状态，不弹错打断人
    kindOptions.value = [];
  }
}

async function open(id: number): Promise<void> {
  try {
    detail.value = await getInsight(id);
    drawer.value = true;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '打开详情失败');
  }
}

async function mark(id: number, next: string): Promise<void> {
  try {
    await decideInsight(id, next as 'open' | 'adopted' | 'dismissed');
    ElMessage.success(`已标记为「${statusLabel(next)}」`);
    if (detail.value?.id === id) detail.value.status = next;
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '标记失败');
  }
}

function onPage(p: number): void {
  page.value = p;
  void reload();
}

onMounted(() => {
  void reload();
  void loadKinds();
});
</script>

<style lang="scss" scoped>
.notice {
  margin-bottom: $space-3;
}
.block {
  margin-bottom: $space-3;
}
.toolbar {
  display: flex;
  gap: $space-3;
  align-items: center;
}
.toolbar__select {
  width: 180px;
}
.toolbar__right {
  margin-left: auto;
  display: flex;
  gap: $space-3;
  align-items: center;
}
.hint {
  color: $c-text-weak;
  font-size: $fs-caption;
}
.excerpt {
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.5;
  margin-top: 2px;
}
.empty {
  color: $c-text-weak;
  padding: $space-4 0;
  font-size: $fs-caption;
}
.pager {
  margin-top: $space-3;
  justify-content: flex-end;
}
.detail__meta {
  color: $c-text-weak;
  font-size: $fs-caption;
  margin-bottom: $space-2;
}
.detail__status {
  margin-bottom: $space-2;
}
.detail__content {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: $font-family-base;
  font-size: $fs-caption;
  line-height: 1.75;
  background: $c-surface-2;
  border: 1px solid $c-border;
  border-radius: $radius-sm;
  padding: $space-3 $space-4;
  margin: 0;
  max-height: 60vh;
  overflow: auto;
}
.detail__actions {
  margin-top: $space-3;
  display: flex;
  gap: $space-2;
}
</style>
