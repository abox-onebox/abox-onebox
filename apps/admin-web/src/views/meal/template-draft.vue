<template>
  <div class="page-container">
    <h2 class="page-container__title">AI 模板草稿</h2>
    <p class="page-container__meta">
      AI 编排节点 #A · 接口：<code>POST /admin/meal/template-draft/generate</code>（只读生成）/
      <code>POST /admin/meal/template-draft/confirm</code>（真写模板库）· 解决「自动开团恒 0
      条」的供给侧缺口
    </p>

    <el-alert
      class="notice"
      type="warning"
      :closable="false"
      show-icon
      title="生成不写库；只有点「确认入库」才会真建模板"
    >
      <template #default>
        草稿里的菜品<strong>只可能来自真实在售库</strong>（已下架 / 编造的被服务端拦掉）。
        生成后请扫一眼构成再确认 —— 这一页存在的意义就是那一眼。
      </template>
    </el-alert>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-select v-model="kind" placeholder="模板类型" style="width: 140px">
        <el-option label="饭类（一饭四菜）" value="meal" />
        <el-option label="快消品" value="fmcg" />
      </el-select>
      <el-input
        v-model="proposalText"
        type="textarea"
        :rows="1"
        placeholder="选品提案 / 业务目标（可空，留空则 AI 基于现有菜品库发挥）"
        style="width: 360px"
      />
      <el-button type="primary" :loading="generating" @click="generate">生成草稿</el-button>
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
      v-if="realMode === 'stub'"
      class="notice"
      type="info"
      :closable="false"
      show-icon
      title="这份草稿是「占位模式」产出的"
    >
      脚本没走模型（<code>--no-llm</code>），只按固定规则挑了几条 —— 用来验证链路，不要照它建模板。
    </el-alert>

    <el-alert
      v-if="notes.length"
      class="notice"
      type="info"
      :closable="false"
      show-icon
      title="AI 提示"
    >
      <ul class="needs">
        <li v-for="(s, i) in notes" :key="i">{{ s }}</li>
      </ul>
    </el-alert>

    <!-- ─────────────── 草稿卡 ─────────────── -->
    <div v-loading="generating" class="draft-list">
      <el-empty
        v-if="!rows.length"
        description="还没有草稿 —— 选好类型、填点提案，点「生成草稿」"
      />

      <el-card
        v-for="(d, i) in rows"
        :key="i"
        class="draft-card"
        :body-style="{ padding: '14px 16px' }"
        shadow="hover"
      >
        <div class="draft-card__head">
          <div>
            <span class="draft-card__name">{{ d.name }}</span>
            <el-tag size="small" :type="d.kind === 'meal' ? 'warning' : 'info'" class="tag-kind">
              {{ d.kind === 'meal' ? '饭类' : '快消' }}
            </el-tag>
            <span v-if="d.price" class="draft-card__price">¥{{ d.price.toFixed(2) }}</span>
          </div>
          <el-button
            type="primary"
            size="small"
            :loading="confirming === i"
            :disabled="!canConfirm"
            @click="confirm(i)"
          >
            确认入库
          </el-button>
        </div>

        <div class="draft-card__items">
          <span v-for="it in d.items" :key="it.itemId" class="dish-chip">
            <em class="slot">{{ slotLabel(it.slot) }}</em
            >{{ it.name }}
          </span>
        </div>

        <p v-if="d.reason" class="draft-card__reason">AI 理由：{{ d.reason }}</p>
        <p v-else class="muted">（未给理由）</p>
      </el-card>
    </div>

    <!-- ─────────────── 越界剔除 ─────────────── -->
    <el-alert
      v-if="droppedReasons.length"
      class="notice"
      type="warning"
      :closable="false"
      show-icon
      title="有草稿被判为越界已剔除（菜品不在当前在售库里）"
    >
      <ul class="needs">
        <li v-for="(s, i) in droppedReasons" :key="i">{{ s }}</li>
      </ul>
    </el-alert>

    <!-- ─────────────── 执行结果 ─────────────── -->
    <el-alert
      v-if="lastSaved"
      class="notice"
      type="success"
      :closable="false"
      show-icon
      :title="`已入库模板「${lastSaved}」`"
    >
      这条草稿现在已进模板库；要上架到某天某楼群，去「组合模板 / 矩阵」页操作。
    </el-alert>
  </div>
</template>

<script setup lang="ts">
/**
 * 后台 · AI 模板草稿（#A 供给侧建模板）
 * ==================================================================
 * 把「选品提案」交给 AI 落成可入库的模板草稿，人工确认后由 D7 真写模板库。
 * 这是「AI 出方案、人执行」在供给侧的闭环 —— 自动开团恒 0 条的死结，卡在
 * 模板库缺「零食/饮品」这类提案里高频出现的类型，本页补的就是这层。
 *
 * 与开团草稿页的区别：那页改的是「排期」（ab_meal_assignment），本页改的是
 * 「模板」（ab_set_meal）—— 更上游、更该先有，没有模板，开团自然排不出东西。
 */
import { computed, h, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  confirmTemplateDraft,
  generateTemplateDraft,
  type MealTemplateGenResult,
  type TemplateDraftView,
} from '@/api/meal';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';

const SLOT_LABELS: Record<number, string> = {
  1: '主件',
  2: '辅品',
  3: '素品',
  4: '附品',
  5: '随附',
};
function slotLabel(slot: number): string {
  return SLOT_LABELS[slot] ?? `档${slot}`;
}

const generating = ref(false);
const confirming = ref<number | null>(null);
const rows = ref<TemplateDraftView[]>([]);
const notes = ref<string[]>([]);
const droppedReasons = ref<string[]>([]);
const failure = ref('');
const realMode = ref<string | null>(null);
const lastSaved = ref('');

const kind = ref<'meal' | 'fmcg'>('meal');
const proposalText = ref('');

const auth = useAuthStore();
const canConfirm = computed(() => auth.role === 'super_admin' || auth.role === 'admin');

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message || `请求失败（${e.code}）`;
  return e instanceof Error ? e.message : '请求失败';
}

async function generate(): Promise<void> {
  generating.value = true;
  failure.value = '';
  lastSaved.value = '';
  rows.value = [];
  notes.value = [];
  droppedReasons.value = [];
  realMode.value = null;
  try {
    const r: MealTemplateGenResult = await generateTemplateDraft({
      kind: kind.value,
      proposalText: proposalText.value.trim() || undefined,
    });
    if (!r.ok) {
      failure.value = r.message || '生成失败';
      return;
    }
    rows.value = r.drafts ?? [];
    notes.value = r.notes ?? [];
    droppedReasons.value = (r.dropped ?? []).map((d) => String(d.why));
    realMode.value = r.mode;
    if (!rows.value.length) {
      ElMessage.warning('这次没产出可用草稿，看下面的提示');
      return;
    }
    ElMessage.success(`草稿 ${rows.value.length} 条，挑一条确认入库`);
  } catch (e) {
    failure.value = errText(e);
  } finally {
    generating.value = false;
  }
}

async function confirm(i: number): Promise<void> {
  const d = rows.value[i];
  if (!d) return;

  const lines = d.items.map((it) => `· ${slotLabel(it.slot)}：${it.name}`);
  try {
    await ElMessageBox.confirm(
      // ⚠️ VNode 而非字符串：MessageBox 默认塞进 <p>，换行会被折叠；也不用
      //   dangerouslyUseHTMLString（模板名来自库，拼 HTML 有注入风险）。
      h('div', { style: 'line-height: 1.9' }, [
        h('p', `将把模板「${d.name}」(${d.kind === 'meal' ? '饭类' : '快消'}) 真写入模板库：`),
        ...lines.map((t) => h('div', { style: 'margin: 2px 0 2px 10px' }, t)),
        h('p', { style: 'margin-top: 8px' }, '入库后可在「组合模板」页上架到具体排期。确定吗？'),
      ]),
      '确认入库',
      { type: 'warning', confirmButtonText: '确认入库', cancelButtonText: '再想想' },
    );
  } catch {
    return; // 用户取消
  }

  confirming.value = i;
  failure.value = '';
  try {
    await confirmTemplateDraft({
      name: d.name,
      kind: d.kind,
      price: d.price,
      items: d.items.map((it) => ({ itemId: it.itemId, slot: it.slot })),
    });
    lastSaved.value = d.name;
    // 该草稿已消费，从页面移除（避免「看着还在、其实已入库」）
    rows.value.splice(i, 1);
    ElMessage.success(`已入库模板「${d.name}」`);
  } catch (e) {
    failure.value = errText(e);
  } finally {
    confirming.value = null;
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
  gap: 8px;
  margin-bottom: 12px;
}

.draft-list {
  min-height: 120px;
}

.draft-card {
  margin-bottom: 12px;
}

.draft-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.draft-card__name {
  font-size: 15px;
  font-weight: 600;
  margin-right: 8px;
}

.tag-kind {
  margin-right: 8px;
}

.draft-card__price {
  color: var(--el-color-danger);
  font-weight: 600;
}

.draft-card__items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.dish-chip {
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 13px;
}

.dish-chip .slot {
  color: var(--el-color-primary);
  font-style: normal;
  margin-right: 4px;
  font-weight: 600;
}

.draft-card__reason {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin: 0;
}

.muted {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  margin: 0;
}

.needs {
  margin: 4px 0 0;
  padding-left: 18px;
  line-height: 1.9;
}
</style>
