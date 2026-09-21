<template>
  <div class="page-container">
    <h2 class="page-container__title">套餐矩阵</h2>
    <p class="page-container__meta">
      模块：M31-01 · 原型 P27 · 接口：D1 矩阵 / D2 创建 / D3 编辑 / D4 上架 / D5 批量复制 · 粒度
      <code>出餐日 × 楼群</code>（<code>ab_meal_assignment</code>）
    </p>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-date-picker
        v-model="range"
        type="daterange"
        unlink-panels
        value-format="YYYY-MM-DD"
        range-separator="→"
        start-placeholder="起始出餐日"
        end-placeholder="结束出餐日"
        :clearable="false"
        style="width: 280px"
        @change="reload"
      />
      <el-button-group>
        <el-button @click="shiftRange(-7)">← 上一周</el-button>
        <el-button @click="goToday">本周</el-button>
        <el-button @click="shiftRange(7)">下一周 →</el-button>
      </el-button-group>
      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">刷新</el-button>
        <el-button type="primary" plain @click="copyVisible = true">批量复制</el-button>
      </div>
    </div>

    <!-- ─────────────── 统计条 ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">日期</span>
        <span class="stats__value">{{ matrix?.stats.dateCount ?? 0 }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">楼群</span>
        <span class="stats__value">{{ matrix?.stats.groupCount ?? 0 }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已排期</span>
        <span class="stats__value">{{ matrix?.stats.assignedCells ?? 0 }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已上架</span>
        <span class="stats__value stats__value--ok">{{ matrix?.stats.publishedCells ?? 0 }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">未排期</span>
        <span class="stats__value stats__value--muted">{{ matrix?.stats.emptyCells ?? 0 }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">累计已售</span>
        <span class="stats__value">{{ matrix?.stats.totalSold ?? 0 }}</span>
      </div>
    </div>

    <!-- ─────────────── 矩阵 ─────────────── -->
    <el-table v-loading="loading" :data="tableRows" border size="small" class="matrix">
      <el-table-column label="楼群" width="150" fixed>
        <template #default="{ row }">
          <div class="group">
            <span class="group__name">{{ row.group.name }}</span>
            <span class="group__sub">
              已分配 {{ row.group.assignedBuildings.length }} · 未分配
              {{ row.group.emptyBuildings.length }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column v-for="date in dates" :key="date" :min-width="132">
        <template #header>
          <div class="datehead" :class="{ 'datehead--today': date === today }">
            <span>{{ date.slice(5) }}</span>
            <span class="datehead__week">{{ weekOf(date) }}</span>
          </div>
        </template>
        <template #default="{ row }">
          <div class="cell" :class="cellClass(row.cells[date])" @click="openCell(asRow(row), date)">
            <template v-if="row.cells[date]?.assignmentId">
              <div class="cell__name">{{ row.cells[date].setMealName ?? '—' }}</div>
              <div class="cell__meta">
                <el-tag size="small" effect="plain" :type="statusTagType(row.cells[date].status)">
                  {{ row.cells[date].statusHint }}
                </el-tag>
                <span v-if="row.cells[date].soldCount" class="cell__sold">
                  已售 {{ row.cells[date].soldCount }}
                </span>
              </div>
              <div class="cell__sub">
                {{ row.cells[date].dishCount }} 菜
                <template v-if="row.cells[date].distributionCenterName">
                  · {{ row.cells[date].distributionCenterName }}
                </template>
              </div>
            </template>
            <template v-else>
              <div class="cell__empty">
                <span>未排期</span>
                <span class="cell__plus">＋</span>
              </div>
            </template>
          </div>
        </template>
      </el-table-column>

      <template #empty>
        <el-empty description="暂无楼群或日期范围为空" />
      </template>
    </el-table>

    <p class="hint">
      <strong>口径</strong>：本表「已分配」= 楼群内 <code>status=1</code>（合作中）的办公楼；
      「未分配」= 停用 / 待分配办公楼（在编辑弹窗里以<strong>禁用复选框</strong>呈现）。
      一格的<strong>底色</strong>表达状态：灰=未排期 / 黄=pending 已排期未上架 / 绿=active 已上架 /
      划线=已过截单时刻。<strong>已截单的格子不可再上架</strong>（否则用户端显示可下单、下单必被截单闸拦下）。
    </p>

    <!-- ─────────────── 新建 / 编辑弹窗 ─────────────── -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogMode === 'create' ? '新建套餐分配' : '编辑套餐分配'"
      width="620px"
      @closed="afterDialogClosed"
    >
      <el-descriptions :column="2" border size="small" class="dialog__head">
        <el-descriptions-item label="出餐日">{{ form.mealDate }}</el-descriptions-item>
        <el-descriptions-item label="楼群">{{ form.groupName }}</el-descriptions-item>
      </el-descriptions>

      <el-form label-width="96px" class="dialog__form">
        <el-form-item label="套餐模板" required>
          <el-select
            v-model="form.setMealId"
            placeholder="选择套餐模板"
            filterable
            style="width: 100%"
          >
            <el-option
              v-for="t in templates"
              :key="t.id"
              :label="`${t.name}（${t.dishCount} 菜 · ¥${fenToYuan(t.priceFen)}）`"
              :value="t.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="集散中心">
          <el-select
            v-model="form.distributionCenterId"
            placeholder="可不选（ABox 自有加工场所）"
            clearable
            style="width: 100%"
          >
            <el-option v-for="d in distributionCenters" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>

        <el-form-item label="楼栋范围">
          <div class="buildings">
            <el-checkbox v-for="b in form.assignedBuildings" :key="b" :model-value="true" disabled>
              {{ b }}
            </el-checkbox>
            <el-checkbox v-for="b in form.emptyBuildings" :key="b" :model-value="false" disabled>
              {{ b }}（待分配）
            </el-checkbox>
            <span
              v-if="!form.assignedBuildings.length && !form.emptyBuildings.length"
              class="muted"
            >
              该楼群暂无办公楼
            </span>
          </div>
        </el-form-item>
      </el-form>

      <template #footer>
        <div class="dialog__footer">
          <div class="dialog__footer-left">
            <template v-if="dialogMode === 'edit'">
              <el-button
                v-if="form.status === 'active'"
                :loading="acting"
                @click="doPublish('unpublish')"
              >
                下架
              </el-button>
              <el-button
                v-else
                type="success"
                :loading="acting"
                :disabled="form.cutoffPassed"
                @click="doPublish('publish')"
              >
                {{ form.cutoffPassed ? '已截单不可上架' : '上架' }}
              </el-button>
            </template>
          </div>
          <div>
            <el-button @click="dialogVisible = false">取消</el-button>
            <el-button type="primary" :loading="acting" @click="submitDialog">
              {{ dialogMode === 'create' ? '创建' : '保存' }}
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- ─────────────── 批量复制弹窗 ─────────────── -->
    <el-dialog v-model="copyVisible" title="批量复制套餐分配" width="560px">
      <el-form label-width="110px">
        <el-form-item label="源出餐日" required>
          <el-date-picker
            v-model="copyForm.fromDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="从那一天复制"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="目标出餐日" required>
          <el-date-picker
            v-model="copyForm.targetDates"
            type="dates"
            value-format="YYYY-MM-DD"
            placeholder="可多选（最多 14 天）"
            style="width: 100%"
          />
        </el-form-item>
      </el-form>

      <el-alert type="info" :closable="false" show-icon>
        <p>复制出的分配<strong>一律为 pending（未上架）</strong>，需另行上架才对用户端开放。</p>
        <p><strong>已存在分配的日期会被跳过而不是覆盖</strong>；已截单的日期同样跳过。</p>
      </el-alert>

      <div v-if="copyResult" class="copyresult">
        <p class="copyresult__title">
          已创建 {{ copyResult.createdCount }} 项 · 跳过 {{ copyResult.skippedCount }} 项
        </p>
        <ul v-if="copyResult.skipped.length" class="copyresult__list">
          <li v-for="(s, i) in copyResult.skipped.slice(0, 20)" :key="i">
            {{ s.mealDate }} · 楼群 #{{ s.buildingGroupId }} —— {{ s.reason }}
          </li>
          <li v-if="copyResult.skipped.length > 20" class="muted">
            其余 {{ copyResult.skipped.length - 20 }} 项略
          </li>
        </ul>
      </div>

      <template #footer>
        <el-button @click="copyVisible = false">关闭</el-button>
        <el-button type="primary" :loading="acting" @click="submitCopy">开始复制</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 套餐矩阵（D1–D5）· 原型 P27
 *
 * ## 为什么是「矩阵」而不是「列表」
 * `ab_meal_assignment` 的粒度是「出餐日 × 楼群」。用列表呈现时，运营看不出
 * 「哪几天漏排了」—— 而**空格子本身就是信息**。所以 D1 契约刻意返回**完整网格**
 * （无分配的格子 `assignmentId=null`），前端直接铺表格，不自己拼空格。
 *
 * ## 两个状态语义别混
 * - `pending` 已排期**未上架**：用户端看不到（显示「今日未开团」）
 * - `active` 已上架：用户端 `canOrder=true`
 * 创建（D2）只到 pending，必须再点「上架」（D4）才对外。这不是多余的一步 ——
 * 编排可以提前几天做，开团是临近时的动作。
 *
 * ⚠️ 矩阵的 `cells[]` 是**行优先展开**（外层日期、内层楼群），但表格要**行=楼群、
 *    列=日期**。所以这里不直接用 `cells`，而是按 `groupId` 建 `Map<date, cell>` 再做行。
 *    直接按数组顺序铺会得到一张转置且错位的表。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  copyMealAssignments,
  createMealAssignment,
  fetchDistributionCenterOptions,
  fetchMealMatrix,
  fetchMealTemplates,
  publishMealAssignment,
  updateMealAssignment,
} from '@/api/meal';
import type {
  CopyAssignmentsResult,
  DistributionCenterOption,
  MatrixCell,
  MatrixGroup,
  MealMatrix,
  SetMealTemplateRow,
} from '@/api/meal';
import { ApiError } from '@/api/request';
import { fenToYuan } from '@/utils/format';

/** 表格行：楼群 + 该楼群按日期索引的单元格 */
interface MatrixRow {
  group: MatrixGroup;
  cells: Record<string, MatrixCell | undefined>;
}

const loading = ref(false);
const acting = ref(false);
const matrix = ref<MealMatrix | null>(null);
const templates = ref<SetMealTemplateRow[]>([]);
const distributionCenters = ref<DistributionCenterOption[]>([]);

/** 缺省展示「今日起 7 天」—— 与 D1 服务端缺省一致 */
const range = ref<[string, string]>([todayStr(), addDaysStr(todayStr(), 6)]);
const today = todayStr();

const dialogVisible = ref(false);
const dialogMode = ref<'create' | 'edit'>('create');
const copyVisible = ref(false);
const copyResult = ref<CopyAssignmentsResult | null>(null);

const form = reactive({
  assignmentId: 0 as number | null,
  mealDate: '',
  buildingGroupId: 0,
  groupName: '',
  setMealId: undefined as number | undefined,
  distributionCenterId: undefined as number | undefined,
  status: '' as string,
  cutoffPassed: false,
  assignedBuildings: [] as number[],
  emptyBuildings: [] as number[],
});

const copyForm = reactive({
  fromDate: '',
  targetDates: [] as string[],
});

const dates = computed(() => matrix.value?.dates ?? []);

/**
 * 行优先 `cells[]` → 行=楼群 / 列=日期
 *
 * ⚠️ 以 `groups` 为行基准（而非 `cells` 里出现过的 groupId）：
 *    某楼群若整段日期都没排期，`cells` 里仍有它的格子（完整网格），
 *    但用 Set 去重反而更容易在契约变化时静默丢行。
 */
const tableRows = computed<MatrixRow[]>(() => {
  const m = matrix.value;
  if (!m) return [];
  const byGroup = new Map<number, Record<string, MatrixCell>>();
  for (const g of m.groups) byGroup.set(g.id, {});
  for (const c of m.cells) {
    const bucket = byGroup.get(c.groupId);
    if (bucket) bucket[c.mealDate] = c;
  }
  return m.groups.map((g) => ({ group: g, cells: byGroup.get(g.id) ?? {} }));
});

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDaysStr(base: string, days: number): string {
  const [y, m, d] = base.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return t.toISOString().slice(0, 10);
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function weekOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function statusTagType(status: string | null): 'success' | 'warning' | 'info' {
  if (status === 'active') return 'success';
  if (status === 'pending') return 'warning';
  return 'info';
}

function cellClass(cell: MatrixCell | undefined): Record<string, boolean> {
  if (!cell?.assignmentId) return { 'cell--empty': true };
  return {
    'cell--pending': cell.status === 'pending',
    'cell--active': cell.status === 'active',
    'cell--cutoff': cell.cutoffPassed,
  };
}

function shiftRange(days: number): void {
  range.value = [addDaysStr(range.value[0], days), addDaysStr(range.value[1], days)];
  void reload();
}

function goToday(): void {
  const t = todayStr();
  range.value = [t, addDaysStr(t, 6)];
  void reload();
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    matrix.value = await fetchMealMatrix({
      startDate: range.value?.[0],
      endDate: range.value?.[1],
    });
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '套餐矩阵加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadOptions(): Promise<void> {
  try {
    const [tpl, dc] = await Promise.all([
      fetchMealTemplates({ page: 1, pageSize: 100, status: 1 }),
      fetchDistributionCenterOptions(),
    ]);
    templates.value = tpl.list;
    distributionCenters.value = dc.list;
  } catch (e) {
    // 选项加载失败不阻断矩阵浏览：矩阵是只读区，弹窗再报错也来得及
    ElMessage.warning(e instanceof ApiError ? e.message : '套餐 / 集散中心选项加载失败');
  }
}

/**
 * Element Plus 表格插槽的 `row` 是 `DefaultRow`（宽松索引类型），不能直接传给
 * 收窄了参数类型的函数。在**函数入口**做一次断言，比在每个插槽里写 `as` 更集中 ——
 * 也避免把 `any` 扩散到整个模板。
 */
function asRow(raw: unknown): MatrixRow {
  return raw as MatrixRow;
}

function openCell(row: MatrixRow, date: string): void {
  const cell = row.cells[date];
  form.mealDate = date;
  form.buildingGroupId = row.group.id;
  form.groupName = row.group.name;
  form.assignedBuildings = row.group.assignedBuildings;
  form.emptyBuildings = row.group.emptyBuildings;

  if (cell?.assignmentId) {
    dialogMode.value = 'edit';
    form.assignmentId = cell.assignmentId;
    form.setMealId = cell.setMealId ?? undefined;
    form.distributionCenterId = cell.distributionCenterId ?? undefined;
    form.status = cell.status ?? '';
    form.cutoffPassed = cell.cutoffPassed;
  } else {
    dialogMode.value = 'create';
    form.assignmentId = null;
    form.setMealId = undefined;
    form.distributionCenterId = undefined;
    form.status = '';
    form.cutoffPassed = false;
  }
  dialogVisible.value = true;
}

function afterDialogClosed(): void {
  form.assignmentId = null;
  form.setMealId = undefined;
  form.distributionCenterId = undefined;
  form.status = '';
  form.cutoffPassed = false;
}

async function submitDialog(): Promise<void> {
  if (!form.setMealId) {
    ElMessage.warning('请选择套餐模板');
    return;
  }
  acting.value = true;
  try {
    if (dialogMode.value === 'create') {
      await createMealAssignment({
        mealDate: form.mealDate,
        buildingGroupId: form.buildingGroupId,
        setMealId: form.setMealId,
        distributionCenterId: form.distributionCenterId,
      });
      ElMessage.success('已创建（pending 未上架，需点上架才对用户端开放）');
    } else if (form.assignmentId) {
      await updateMealAssignment(form.assignmentId, {
        setMealId: form.setMealId,
        distributionCenterId: form.distributionCenterId,
      });
      ElMessage.success('已保存');
    }
    dialogVisible.value = false;
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    acting.value = false;
  }
}

async function doPublish(action: 'publish' | 'unpublish'): Promise<void> {
  if (!form.assignmentId) return;
  if (action === 'unpublish') {
    try {
      await ElMessageBox.confirm(
        '下架后用户端立即不可下单。已产生的订单不受影响，如需退单请走强制退款。',
        '确认下架？',
        { type: 'warning', confirmButtonText: '下架', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  acting.value = true;
  try {
    const res = await publishMealAssignment(form.assignmentId, action);
    ElMessage.success(action === 'publish' ? '已上架，用户端可下单' : '已下架');
    form.status = res.status;
    dialogVisible.value = false;
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '操作失败');
  } finally {
    acting.value = false;
  }
}

async function submitCopy(): Promise<void> {
  if (!copyForm.fromDate) {
    ElMessage.warning('请选择源出餐日');
    return;
  }
  if (!copyForm.targetDates?.length) {
    ElMessage.warning('请选择至少一个目标出餐日');
    return;
  }
  acting.value = true;
  try {
    copyResult.value = await copyMealAssignments({
      fromDate: copyForm.fromDate,
      targetDates: copyForm.targetDates,
    });
    ElMessage.success(
      `已创建 ${copyResult.value.createdCount} 项，跳过 ${copyResult.value.skippedCount} 项`,
    );
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '批量复制失败');
  } finally {
    acting.value = false;
  }
}

onMounted(() => {
  void reload();
  void loadOptions();
});
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-3;

  &__right {
    margin-left: auto;
    display: flex;
    gap: $space-2;
  }
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: $space-5;
  padding: $space-2 $space-4;
  margin-bottom: $space-3;
  background: $c-bg;
  border: 1px solid $c-border;
  border-radius: $radius-sm;

  &__item {
    display: flex;
    align-items: baseline;
    gap: $space-1;
  }

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    font-size: 18px;
    font-weight: 600;

    &--ok {
      color: $c-ok-fg;
    }

    &--muted {
      color: $c-text-weak;
    }
  }
}

.matrix {
  :deep(.el-table__cell) {
    padding: 2px 0;
  }
}

.group {
  display: flex;
  flex-direction: column;
  line-height: 1.3;

  &__name {
    font-weight: 600;
  }

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.datehead {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.25;

  &--today {
    color: $c-gold-fg;
    font-weight: 700;
  }

  &__week {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.cell {
  min-height: 62px;
  padding: 6px 8px;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: filter 0.15s;
  line-height: 1.3;

  &:hover {
    filter: brightness(0.96);
  }

  &--empty {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed $c-border;
    color: $c-text-weak;
  }

  &--pending {
    background: rgba(201, 168, 118, 0.16);
    border: 1px solid rgba(201, 168, 118, 0.5);
  }

  &--active {
    background: rgba(91, 124, 58, 0.12);
    border: 1px solid rgba(91, 124, 58, 0.45);
  }

  /** 已过截单：斜纹提示「历史 / 不可再改」 */
  &--cutoff {
    opacity: 0.7;
    background-image: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 6px,
      rgba(110, 84, 53, 0.07) 6px,
      rgba(110, 84, 53, 0.07) 12px
    );
  }

  &__name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__meta {
    display: flex;
    align-items: center;
    gap: $space-1;
    margin-top: 2px;
  }

  &__sold {
    font-size: $fs-caption;
    color: $c-ok-fg;
  }

  &__sub {
    margin-top: 2px;
    font-size: $fs-caption;
    color: $c-text-weak;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__empty {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: $fs-caption;
  }

  &__plus {
    font-weight: 700;
  }
}

.hint {
  margin: $space-3 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}

.dialog {
  &__head {
    margin-bottom: $space-3;
  }

  &__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;

    &-left {
      display: flex;
      gap: $space-2;
    }
  }
}

.buildings {
  display: flex;
  flex-wrap: wrap;
  gap: 0 $space-2;
}

.muted {
  color: $c-text-weak;
}

.copyresult {
  margin-top: $space-3;

  &__title {
    margin: 0 0 $space-1;
    font-weight: 600;
  }

  &__list {
    margin: 0;
    padding-left: 20px;
    max-height: 180px;
    overflow: auto;
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.7;
  }
}
</style>
