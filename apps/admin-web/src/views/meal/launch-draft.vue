<template>
  <div class="page-container">
    <h2 class="page-container__title">开团草稿</h2>
    <p class="page-container__meta">
      AI 编排节点 R · 接口：<code>POST /admin/meal/launch-draft</code>（只读生成）/
      <code>POST /admin/meal/launch-draft/confirm</code>（真写排期）· 粒度
      <code>出餐日 × 楼群</code>（<code>ab_meal_assignment</code>）
    </p>

    <!--
      为什么把「会真改线上排期」写在最上面而不是弹窗里：
      这一页的风险不在操作复杂，而在**看起来像预览**。先入为主地说明白，
      比确认框里藏一行小字更有用。
    -->
    <el-alert
      class="notice"
      type="warning"
      :closable="false"
      show-icon
      title="生成草稿不写库；只有点「确认开团」才会真排上去"
    >
      <template #default>
        草稿里的楼群与套餐<strong>只可能来自真实候选集</strong>（停用的模板、停用的楼群、预包装品已被服务端拦掉）。
        生成后请扫一眼理由再确认 —— 这一页存在的意义就是那一眼。
      </template>
    </el-alert>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-date-picker
        v-model="mealDate"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="出餐日"
        :clearable="false"
        style="width: 160px"
      />
      <el-button type="primary" :loading="generating" @click="generate">生成草稿</el-button>
      <el-button :loading="generating" :disabled="!rows.length" @click="selectAll(true)">
        全选
      </el-button>
      <div class="toolbar__right">
        <span v-if="!canConfirm" class="hint">「确认开团」只给管理员</span>
        <span class="hint">已选 {{ picked.length }} / {{ rows.length }} 条</span>
        <el-button
          type="danger"
          :loading="confirming"
          :disabled="!picked.length || !canConfirm"
          @click="confirm"
        >
          确认开团
        </el-button>
      </div>
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
      脚本没走模型（<code>--no-llm</code>），只按固定规则挑了几条 —— 用来验证链路，不要照它开团。
    </el-alert>

    <!-- ─────────────── 草稿表 ─────────────── -->
    <el-table
      ref="tableRef"
      v-loading="generating"
      :data="rows"
      row-key="rowKey"
      class="draft-table"
      empty-text="还没有草稿 —— 选好出餐日点「生成草稿」"
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="46" />
      <el-table-column prop="buildingGroupName" label="楼群" min-width="140" />
      <el-table-column prop="setMealName" label="套餐" min-width="160" />
      <el-table-column label="价格" width="96" align="right">
        <template #default="{ row }">¥{{ fenToYuan(row.priceFen) }}</template>
      </el-table-column>
      <el-table-column prop="usedCount" label="被引用" width="86" align="right" />
      <el-table-column prop="mealDate" label="出餐日" width="118" />
      <el-table-column label="AI 理由" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.reason">{{ row.reason }}</span>
          <span v-else class="muted">（未给理由）</span>
        </template>
      </el-table-column>
    </el-table>

    <!-- ─────────────── 被拦下的候选 ─────────────── -->
    <el-collapse v-if="blocked.length" class="blocked">
      <el-collapse-item :title="`被拦下 ${blocked.length} 条（不可开团，未进草稿）`" name="b">
        <el-table :data="blocked" size="small" :show-header="true">
          <el-table-column prop="buildingGroupId" label="楼群 ID" width="96" />
          <el-table-column prop="setMealId" label="套餐 ID" width="96" />
          <el-table-column prop="code" label="原因码" width="180" />
          <el-table-column prop="detail" label="说明" min-width="280" show-overflow-tooltip />
        </el-table>
      </el-collapse-item>
    </el-collapse>

    <!-- ─────────────── AI 自报还缺什么 ─────────────── -->
    <el-alert
      v-if="needsNewTemplate.length"
      class="notice"
      type="info"
      :closable="false"
      show-icon
      title="AI 说还缺这些模板（不会自动建，需你在「组合模板」页建好）"
    >
      <ul class="needs">
        <li v-for="(s, i) in needsNewTemplate" :key="i">{{ s }}</li>
      </ul>
    </el-alert>

    <!-- ─────────────── 被剔除的越界条目 ─────────────── -->
    <el-alert
      v-if="droppedReasons.length"
      class="notice"
      type="warning"
      :closable="false"
      show-icon
      title="有草稿被判为越界已剔除（AI 给的 ID 不在当前候选集里）"
    >
      <ul class="needs">
        <li v-for="(s, i) in droppedReasons" :key="i">{{ s }}</li>
      </ul>
    </el-alert>

    <!-- ─────────────── 执行结果 ─────────────── -->
    <template v-if="results.length">
      <h3 class="sub-title">
        本次结果：成功 {{ successCount }} / {{ results.length }}
        <span v-if="failCount" class="sub-title__warn">（失败 {{ failCount }} 条，见下）</span>
      </h3>
      <el-table :data="results" size="small">
        <el-table-column prop="index" label="#" width="56" />
        <el-table-column prop="buildingGroupName" label="楼群" min-width="140" />
        <el-table-column prop="setMealName" label="套餐" min-width="150" />
        <el-table-column label="结果" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.ok" type="success" size="small">已上架</el-tag>
            <el-tag v-else type="danger" size="small">{{ stageLabel(row.stage) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="assignmentId" label="分配 ID" width="96" />
        <el-table-column label="说明" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.ok">用户能下单</span>
            <span v-else class="danger-text">{{ row.errorText || '未知原因' }}</span>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="failCount" class="foot-hint">
        「只建起分配、上架没成功」的那几条，手机上还买不到 —— 请到「组合矩阵」页补点一次上架。
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 后台 · 开团草稿（#1 自动开团闭环 · 批 4）
 * ==================================================================
 * 这一页只是**企微那条链路的另一副面孔**：生成与执行都打同一批服务端方法
 * （`buildLaunchDraft` / `runLaunchConfirm`），不存在第二套判据或第二套写库实现。
 *
 * ## 为什么默认全选
 *
 * 逐日排的常态是「1~2 个楼群、都排」。默认全选让常见路径只点两下；
 * 要少排一个就取消勾选 —— 比「先全选」省事，也比「强制逐条勾」少犯错。
 *
 * ## 为什么确认一定要二次弹窗
 *
 * 这是全站少数**一按就改线上排期**的按钮。弹窗里把「几条、哪天、哪个楼群」
 * 逐条列出来，是为了让人在最后一刻还能看见自己要动什么。
 */
import { computed, h, nextTick, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import { confirmLaunchDraft, generateLaunchDraft } from '@/api/meal';
import type { LaunchConfirmRowResult, LaunchDraftBlocked, LaunchDraftRow } from '@/api/meal';
import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';
import { fenToYuan } from '@/utils/format';

interface DraftRowView extends LaunchDraftRow {
  /** el-table 的 row-key：出餐日 + 楼群在草稿内唯一 */
  rowKey: string;
}

const tableRef = ref<{
  toggleRowSelection: (row: DraftRowView, selected: boolean) => void;
  clearSelection: () => void;
} | null>(null);

const generating = ref(false);
const confirming = ref(false);

const rows = ref<DraftRowView[]>([]);
const blocked = ref<LaunchDraftBlocked[]>([]);
const needsNewTemplate = ref<string[]>([]);
/** 越界剔除原因：与「AI 未给」是两回事，必须分开显示 */
const droppedReasons = ref<string[]>([]);
const results = ref<LaunchConfirmRowResult[]>([]);

/** `null` = 还没生成过（不显示占位模式提示） */
const realMode = ref<string | null>(null);
const failure = ref('');

/** 勾选的行号（1-based，与服务端 `picks` 同口径） */
const picked = ref<number[]>([]);

const mealDate = ref(tomorrowStr());

const successCount = computed(() => results.value.filter((r) => r.ok).length);
const failCount = computed(() => results.value.filter((r) => !r.ok).length);

/**
 * 谁能按「确认开团」：与控制器方法级 `@Roles('super_admin','admin')` 同口径。
 *
 * ⚠️ 这只是**体验**（提前把按钮灰掉并给出原因），不是安全边界 ——
 *   真正拦人的是服务端 403。前端过滤写错了顶多难看，不会放坏人进来。
 */
const auth = useAuthStore();
const canConfirm = computed(() => auth.role === 'super_admin' || auth.role === 'admin');

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 默认明日 —— 与企微「不指定日期就是明天」一致。
 * 用本地日期而不是 `toISOString()`：后者按 UTC 截断，东八区晚上会退成前一天。
 */
function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return ymd(d);
}

function stageLabel(stage?: string): string {
  if (stage === 'create') return '没排上';
  if (stage === 'no_id') return '缺回执';
  if (stage === 'publish') return '未上架';
  return '失败';
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message || `请求失败（${e.code}）`;
  return e instanceof Error ? e.message : '请求失败';
}

function onSelectionChange(sel: DraftRowView[]): void {
  const keys = new Set(sel.map((r) => r.rowKey));
  picked.value = rows.value.map((r, i) => (keys.has(r.rowKey) ? i + 1 : 0)).filter((i) => i > 0);
}

/**
 * 全选 / 全不选。
 *
 * ⚠️ 不用 `toggleAllSelection()`：它是**切换**语义。同一日期重新生成时行 key
 *   （`日期-楼群`）与上次相同，el-table 会**保留**上次的选中态，一 toggle 就变成
 *   「把已选的取消」⇒ 页面上写着「已选 0」，人以为默认全选坏了。
 *   逐行 `toggleRowSelection(row, true/false)` 是幂等的，怎么说怎么做。
 */
function selectAll(on: boolean): void {
  const t = tableRef.value;
  if (!t) return;
  for (const r of rows.value) t.toggleRowSelection(r, on);
}

async function generate(): Promise<void> {
  generating.value = true;
  failure.value = '';
  results.value = [];
  picked.value = [];
  try {
    const r = await generateLaunchDraft({ mealDate: mealDate.value });
    if (!r.ok) {
      failure.value = r.message;
      rows.value = [];
      blocked.value = [];
      needsNewTemplate.value = [];
      droppedReasons.value = [];
      realMode.value = null;
      return;
    }
    rows.value = r.rows.map((x) => ({
      ...x,
      rowKey: `${x.mealDate}-${x.buildingGroupId}`,
    }));
    blocked.value = r.blocked;
    needsNewTemplate.value = r.needsNewTemplate;
    droppedReasons.value = r.dropped ?? [];
    realMode.value = r.mode;

    if (!rows.value.length) {
      ElMessage.warning('这次没排出可用草稿，看下面的拦截原因');
      return;
    }
    // 默认全选：等表格渲染完再勾，否则 toggle 打空
    await nextTick();
    selectAll(true);
    ElMessage.success(`草稿 ${rows.value.length} 条，已默认全选`);
  } catch (e) {
    failure.value = errText(e);
  } finally {
    generating.value = false;
  }
}

async function confirm(): Promise<void> {
  const lines = picked.value
    .map((i) => rows.value[i - 1])
    .filter((r): r is DraftRowView => Boolean(r))
    .map((r) => `· ${r.buildingGroupName} → ${r.setMealName}`);
  if (!lines.length) {
    ElMessage.warning('一条都没选，我什么都没动');
    return;
  }

  try {
    // ⚠️ 用 VNode 而不是字符串 + `\n`：ElMessageBox 默认把 message 塞进 <p>，
    //    换行会被折叠成一行，「逐条列出来」就名不副实。
    //    也不用 `dangerouslyUseHTMLString` —— 楼群/套餐名来自数据库，字符串拼 HTML 会把
    //    名字里的 `<` `&` 当成标签解析。
    await ElMessageBox.confirm(
      h('div', { style: 'line-height: 1.9' }, [
        h('p', `将把下面 ${lines.length} 条真排到 ${mealDate.value} 并立即上架（用户能下单）：`),
        ...lines.map((t) => h('div', { style: 'margin: 2px 0 2px 10px' }, t)),
        h(
          'p',
          { style: 'margin-top: 8px' },
          '截单后改不了，要撤只能到「组合矩阵」页取消。确定吗？',
        ),
      ]),
      '确认开团',
      { type: 'warning', confirmButtonText: '确认开团', cancelButtonText: '再想想' },
    );
  } catch {
    return; // 用户点了取消
  }

  confirming.value = true;
  failure.value = '';
  try {
    const r = await confirmLaunchDraft({ picks: picked.value });
    if (!r.ok) {
      failure.value = r.detail;
      ElMessage.error('没执行');
      return;
    }
    results.value = r.rows;
    // 草稿已被服务端消费（先删再执行），页面同步清空，避免「看着还在、其实已执行」
    rows.value = [];
    picked.value = [];
    const okN = r.rows.filter((x) => x.ok).length;
    if (okN === r.rows.length) ElMessage.success(`办好了 ${okN} 条`);
    else ElMessage.warning(`成功 ${okN}、失败 ${r.rows.length - okN}，逐条看下面的结果`);
  } catch (e) {
    failure.value = errText(e);
  } finally {
    confirming.value = false;
  }
}

// 刻意**不做**「进页面自动生成」：生成会读一遍实时模板/楼群并调一次模型，
// 自动跑等于每开一个标签页就花一次钱，还容易让人以为草稿是「系统替我排好的」。
// 所以本页没有任何 mount 期副作用，一律由人点「生成草稿」。
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

.toolbar__right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.draft-table {
  margin-bottom: 12px;
}

.blocked {
  margin-bottom: 12px;
}

.needs {
  margin: 4px 0 0;
  padding-left: 18px;
  line-height: 1.9;
}

.sub-title {
  margin: 18px 0 10px;
  font-size: 15px;
  font-weight: 600;
}

.sub-title__warn {
  color: var(--el-color-danger);
  font-weight: 500;
}

.muted {
  color: var(--el-text-color-placeholder);
}

.danger-text {
  color: var(--el-color-danger);
}

.foot-hint {
  margin-top: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
