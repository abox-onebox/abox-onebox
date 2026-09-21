<template>
  <div class="page-container">
    <h2 class="page-container__title">订单中心</h2>
    <p class="page-container__meta">
      模块：M32-01/02/06 · 原型 P30 · 接口：D8 订单流 / D10 手动改单 / D12 导出 · 数据源
      <code>ab_order</code>（全平台，手机号脱敏）
    </p>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-radio-group v-model="dateMode" @change="onDateModeChange">
        <el-radio-button value="day">按出餐日</el-radio-button>
        <el-radio-button value="range">按区间</el-radio-button>
      </el-radio-group>

      <el-date-picker
        v-if="dateMode === 'day'"
        v-model="query.mealDate"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="出餐日"
        :clearable="true"
        style="width: 160px"
        @change="reload"
      />
      <el-date-picker
        v-else
        v-model="range"
        type="daterange"
        unlink-panels
        value-format="YYYY-MM-DD"
        range-separator="→"
        start-placeholder="起始"
        end-placeholder="结束"
        style="width: 260px"
        @change="onRangeChange"
      />

      <el-select
        v-model="query.groupId"
        placeholder="全部楼群"
        clearable
        filterable
        style="width: 150px"
        @change="onGroupChange"
      >
        <el-option v-for="g in options.groups" :key="g.id" :label="g.name" :value="g.id" />
      </el-select>

      <el-select
        v-model="query.buildingId"
        placeholder="全部办公楼"
        clearable
        filterable
        style="width: 170px"
        @change="reload"
      >
        <el-option v-for="b in buildingChoices" :key="b.id" :label="b.name" :value="b.id" />
      </el-select>

      <el-select
        v-model="query.leaderId"
        placeholder="全部团长"
        clearable
        filterable
        style="width: 150px"
        @change="reload"
      >
        <el-option v-for="l in options.leaders" :key="l.id" :label="l.name" :value="l.id" />
      </el-select>

      <el-select
        v-model="query.status"
        placeholder="全部状态"
        clearable
        style="width: 140px"
        @change="reload"
      >
        <el-option v-for="s in options.statuses" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>

      <el-input
        v-model="query.keyword"
        placeholder="订单号 / 用户昵称"
        clearable
        style="width: 180px"
        @keyup.enter="reload"
        @clear="reload"
      />

      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">查询</el-button>
        <el-button :loading="exporting" @click="doExport">导出 CSV</el-button>
      </div>
    </div>

    <!-- ─────────────── 汇总 ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">订单数</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">有效份数</span>
        <span class="stats__value stats__value--ok">{{ summary.validQuantity }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">有效金额</span>
        <span class="stats__value">{{ fenToCny(summary.validAmountFen) }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">异常单</span>
        <span class="stats__value stats__value--warn">{{ summary.abnormalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">待支付</span>
        <span class="stats__value stats__value--muted">{{ summary.pendingPayCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">退款待处理</span>
        <span class="stats__value stats__value--warn">{{ summary.refundingCount }}</span>
      </div>
    </div>

    <!-- ─────────────── Tab ─────────────── -->
    <el-tabs v-model="activeTab" class="tabs" @tab-change="onTabChange">
      <el-tab-pane label="全部订单" name="all" />
      <el-tab-pane name="abnormal">
        <template #label>
          <span>
            异常订单
            <el-badge
              v-if="summary.abnormalCount"
              :value="summary.abnormalCount"
              type="warning"
              class="tabs__badge"
            />
          </span>
        </template>
      </el-tab-pane>
    </el-tabs>

    <!-- ─────────────── 表格 ─────────────── -->
    <el-table v-loading="loading" :data="rows" border size="small" class="table">
      <el-table-column label="订单号" width="180" fixed>
        <template #default="{ row }">
          <span class="mono">{{ row.orderNo }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="mealDate" label="出餐日" width="104" />
      <el-table-column label="用户" width="140">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(row.userName, '(未设昵称)') }}</span>
            <span class="stack__sub">{{ row.phoneMasked }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="楼群 / 办公楼" min-width="180">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(row.groupName) }}</span>
            <span class="stack__sub">{{ displayOr(row.buildingName) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="团长" width="110">
        <template #default="{ row }">{{ displayOr(row.leaderName) }}</template>
      </el-table-column>
      <el-table-column label="套餐" min-width="140">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(row.mainDishName, displayOr(row.setMealName)) }}</span>
            <span class="stack__sub">{{ row.setMealName }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="份数" width="64" align="right">
        <template #default="{ row }">{{ row.quantity }}</template>
      </el-table-column>
      <el-table-column label="总额" width="96" align="right">
        <template #default="{ row }">{{ fenToCny(row.totalAmountFen) }}</template>
      </el-table-column>
      <el-table-column label="余额抵扣" width="96" align="right">
        <template #default="{ row }">
          <span :class="{ muted: !row.balanceUsedFen }">
            {{ fenToCny(row.balanceUsedFen) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="微信实付" width="96" align="right">
        <template #default="{ row }">{{ fenToCny(row.payAmountFen) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="104">
        <template #default="{ row }">
          <el-tag size="small" effect="plain" :type="statusTagType(row.status)">
            {{ row.statusText }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="退款" width="104">
        <template #default="{ row }">
          <span v-if="row.refund" class="stack">
            <el-tag size="small" :type="refundTagType(row.refund.status)" effect="plain">
              {{ row.refund.statusText }}
            </el-tag>
            <span class="stack__sub">{{ row.refund.applySourceText }}</span>
          </span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="下单时间" width="150">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="132" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="goDetail(asRow(row))">详情</el-button>
          <el-button link type="primary" size="small" @click="openAdjust(asRow(row))"
            >改单</el-button
          >
        </template>
      </el-table-column>

      <template #empty>
        <el-empty :description="activeTab === 'abnormal' ? '没有异常订单' : '没有符合条件的订单'" />
      </template>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      :page-sizes="[20, 50, 100]"
      layout="total, sizes, prev, pager, next, jumper"
      class="pager"
      @current-change="reload"
      @size-change="reload"
    />

    <p class="hint">
      <strong>异常订单口径</strong>：待支付超时 + 退款待审批 + 退款处理中；
      <strong>已取消不算异常</strong>（它是一个正常终态，算进去只会让这个 Tab 永远噪杂）。
      <strong>改单</strong>：改份数<strong>仅限未支付</strong>订单（已支付的改份数等于补收 / 退款，
      属支付通道动作 → 请先强制退款再让用户重下单）；改取餐楼须与原楼<strong>同楼群</strong>。
      两者都要求<strong>未过截单</strong>。列表手机号已脱敏 —— 完整号只在「导出
      CSV」中给出，且服务端强制留痕。
    </p>

    <!-- ─────────────── 改单弹窗（与详情页共用同一组件，保证校验只有一处） ─────────────── -->
    <AdjustDialog v-model="adjustVisible" :order="adjusting" @saved="reload" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  exportAdminOrders,
  fetchAdminOrders,
  fetchOrderFilterOptions,
  type AdminOrderRow,
  type AdminOrdersSummary,
  type OrderFilterOptions,
} from '@/api/order';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny, formatDateTime } from '@/utils/format';
import AdjustDialog from './components/adjust-dialog.vue';

const router = useRouter();

const loading = ref(false);
const exporting = ref(false);
const rows = ref<AdminOrderRow[]>([]);
const total = ref(0);
const activeTab = ref<'all' | 'abnormal'>('all');
const dateMode = ref<'day' | 'range'>('day');
const range = ref<[string, string] | null>(null);

const summary = reactive<AdminOrdersSummary>({
  totalCount: 0,
  validCount: 0,
  validQuantity: 0,
  validAmountFen: 0,
  abnormalCount: 0,
  pendingPayCount: 0,
  refundingCount: 0,
});

const query = reactive({
  mealDate: '' as string,
  startDate: '' as string,
  endDate: '' as string,
  groupId: undefined as number | undefined,
  buildingId: undefined as number | undefined,
  leaderId: undefined as number | undefined,
  status: undefined as string | undefined,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const options = reactive<OrderFilterOptions>({
  groups: [],
  buildings: [],
  leaders: [],
  statuses: [],
});

/** 选了楼群就只列该楼群下的楼 —— 两个筛选互相矛盾时用户会以为「筛不出来」 */
const buildingChoices = computed(() =>
  query.groupId ? options.buildings.filter((b) => b.groupId === query.groupId) : options.buildings,
);

function onDateModeChange(): void {
  if (dateMode.value === 'day') {
    range.value = null;
    query.startDate = '';
    query.endDate = '';
  } else {
    query.mealDate = '';
  }
  reload();
}

function onRangeChange(v: [string, string] | null): void {
  query.startDate = v?.[0] ?? '';
  query.endDate = v?.[1] ?? '';
  reload();
}

/** 换楼群时清掉已选的楼（否则会变成「楼群 A + 楼群 B 的楼」= 空集） */
function onGroupChange(): void {
  if (query.buildingId && !buildingChoices.value.some((b) => b.id === query.buildingId)) {
    query.buildingId = undefined;
  }
  reload();
}

function onTabChange(): void {
  query.page = 1;
  reload();
}

function params() {
  return {
    mealDate: query.mealDate || undefined,
    startDate: query.startDate || undefined,
    endDate: query.endDate || undefined,
    groupId: query.groupId,
    buildingId: query.buildingId,
    leaderId: query.leaderId,
    status: query.status,
    keyword: query.keyword.trim() || undefined,
    tab: activeTab.value,
    page: query.page,
    pageSize: query.pageSize,
  };
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchAdminOrders(params());
    rows.value = res.list ?? [];
    total.value = res.total ?? 0;
    Object.assign(summary, res.summary);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '订单列表加载失败');
  } finally {
    loading.value = false;
  }
}

async function doExport(): Promise<void> {
  exporting.value = true;
  try {
    // 导出刻意**不复用分页**：导出的必须是「筛出来的那批」，不是「这一页」
    const res = await exportAdminOrders({ ...params(), page: undefined, pageSize: undefined });
    const csv = [res.headers, ...res.list].map((line) => line.map(csvCell).join(',')).join('\r\n');
    // BOM 头：不加的话 Excel 打开中文列名会乱码
    downloadBlob(`\uFEFF${csv}`, res.fileName, 'text/csv;charset=utf-8');
    ElMessage.success(
      res.truncated
        ? `已导出 ${res.count} 条（已达单次上限，请缩小筛选范围后分批导出）`
        : `已导出 ${res.count} 条`,
    );
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '导出失败');
  } finally {
    exporting.value = false;
  }
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(content: string, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------ 改单

const adjustVisible = ref(false);
const adjusting = ref<AdminOrderRow | null>(null);

function openAdjust(row: AdminOrderRow): void {
  adjusting.value = row;
  adjustVisible.value = true;
}

// ------------------------------------------------------------ 其它

/**
 * 表格插槽收窄
 *
 * Element Plus 的 `#default="{ row }"` 把 row 声明为 `DefaultRow`（≈ `Record<string, any>`），
 * 与我们的 `AdminOrderRow` 无重叠，直接传参会报 TS2345。与其把参数类型放宽成 `any`
 * （那就等于放弃这列的检查），不如在**函数入口**收窄一次 —— 类型断言只出现在这里。
 */
function asRow(raw: unknown): AdminOrderRow {
  return raw as AdminOrderRow;
}

function goDetail(row: AdminOrderRow): void {
  router.push({ path: '/order/detail', query: { orderNo: row.orderNo } });
}

function statusTagType(status: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (status === 'completed') return 'success';
  if (status === 'pending_pay') return 'warning';
  if (status === 'refund_applying' || status === 'refunding') return 'danger';
  if (status === 'cancelled' || status === 'refunded') return 'info';
  return 'primary';
}

function refundTagType(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'refunded') return 'success';
  if (status === 'rejected' || status === 'failed') return 'info';
  if (status === 'refunding') return 'danger';
  return 'warning';
}

onMounted(async () => {
  try {
    Object.assign(options, await fetchOrderFilterOptions());
  } catch {
    // 下拉加载失败不该挡住列表 —— 少几个筛选项，总比整页空白好
  }
  await reload();
});
</script>

<style lang="scss" scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-3;

  &__right {
    display: flex;
    gap: $space-2;
    margin-left: auto;
  }
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: $space-4;
  padding: $space-2 $space-3;
  margin-bottom: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__item {
    display: flex;
    flex-direction: column;
  }

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    font-size: $fs-h2;
    font-weight: 700;

    &--ok {
      color: $c-ok-fg;
    }

    &--warn {
      color: $c-warn-fg;
    }

    &--muted {
      color: $c-text-weak;
    }
  }
}

.tabs {
  margin-bottom: $space-1;

  &__badge {
    margin-left: $space-1;
    transform: translateY(-2px);
  }
}

.table {
  margin-bottom: $space-3;
}

.stack {
  display: flex;
  flex-direction: column;
  line-height: 1.4;

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: $fs-caption;
}

.muted {
  color: $c-text-weak;
}

.pager {
  display: flex;
  justify-content: flex-end;
}

.hint {
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;

  code {
    padding: 0 3px;
    background: $c-bg;
    border-radius: $radius-sm;
  }
}

.dialog {
  &__head {
    margin-bottom: $space-3;
  }

  &__tip {
    margin-left: $space-2;
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}
</style>
