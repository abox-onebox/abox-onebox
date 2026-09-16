<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchInvoices, type InvoiceListView, type InvoiceStatusValue } from '@/api/finance';

/**
 * P34 发票管理（D44 · M3-15 · 模块 M35-07）
 *
 * ## 页面为什么长这样（三条口径决定）
 * 1. **粒度是「供应商 × 月份」**：发票按月开一张。若按应付行平铺，运营看到的是
 *    「同一个发票号重复 30 次」，**完全看不出**「这家这个月只开了一半」——
 *    故聚合行 + 三态徽章，`部分开票` 是这个页面存在的理由。
 * 2. **分母只含「已付款」**：未付款就要票，供应商不会给。未付款的应付额
 *    单列一栏（`unpaidAmountFen`），否则一个刚出单的日子会满屏「未开票」，
 *    把真正该催的欠票淹没。
 * 3. **月份 = 应付单生成月**（权责发生制台账），不是付款月 —— 跨月付款仍归原月。
 *
 * ## 两个「可执行的下一步」
 * - `overdue`（已付超 `overdueDays` 天仍无票）→ 税前扣除凭证缺失，是**税务风险**
 * - `titleMissing`（未登记开票抬头）→ 抬头缺失**票开不出来**，去供应商档案补（D28）
 *
 * ⚠️ 页面**不做计算**：所有金额、状态、逾期天数均由服务端下发（口径唯一真相）。
 */
const loading = ref(false);
const month = ref('');
const status = ref('');
const keyword = ref('');
const page = ref(1);
const pageSize = ref(20);
const data = ref<InvoiceListView | null>(null);

const money = (fen?: number | null) => `¥${((fen ?? 0) / 100).toFixed(2)}`;
const signedMoney = (fen?: number | null) => {
  const v = fen ?? 0;
  return v < 0 ? `-¥${(-v / 100).toFixed(2)}` : `¥${(v / 100).toFixed(2)}`;
};

/** 三态配色：`partial` 是最该被看见的状态，故用 warning 而非 info */
const STATUS_TAG: Record<InvoiceStatusValue, 'info' | 'warning' | 'success'> = {
  none: 'info',
  partial: 'warning',
  full: 'success',
};

const FALLBACK_STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'none', label: '未开票' },
  { value: 'partial', label: '部分开票' },
  { value: 'full', label: '已开票' },
];

async function load() {
  loading.value = true;
  try {
    data.value = await fetchInvoices({
      month: month.value || undefined,
      status: (status.value || undefined) as InvoiceStatusValue | undefined,
      keyword: keyword.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function onPage(p: number) {
  page.value = p;
  void load();
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page-container">
    <h2 class="page-container__title">财务结算 · 发票管理</h2>
    <p class="page-container__meta">
      原型页 / 模块：P34 · M35-07 ｜ 供应商开给 ABox 的<strong>进项票</strong>（税前扣除凭证）· 粒度
      = 供应商 × 月份 · <strong>零 DDL 派生视图</strong>（事实全在应付单里）
    </p>

    <el-card shadow="never" class="bar">
      <div class="toolbar">
        <el-date-picker
          v-model="month"
          type="month"
          value-format="YYYY-MM"
          placeholder="应付生成月"
          @change="onPage(1)"
        />
        <el-select v-model="status" placeholder="开票状态" style="width: 140px" @change="onPage(1)">
          <el-option
            v-for="opt in data?.summary.statusOptions?.length
              ? [{ value: '', label: '全部状态' }, ...data.summary.statusOptions]
              : FALLBACK_STATUS_OPTIONS"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <el-input
          v-model="keyword"
          placeholder="供应商名称"
          clearable
          style="width: 180px"
          @keyup.enter="onPage(1)"
          @clear="onPage(1)"
        />
        <el-button type="primary" @click="onPage(1)">查询</el-button>
        <div class="toolbar__right">
          <el-button @click="load">刷新</el-button>
        </div>
      </div>
    </el-card>

    <div v-loading="loading" class="stats">
      <div class="stats__item">
        <span class="stats__label">已付款应付（开票分母）</span>
        <span class="stats__value">{{ money(data?.summary.paidAmountFen) }}</span>
        <span class="stats__hint">
          {{ data?.summary.supplierCount ?? 0 }} 家 · {{ data?.summary.monthCount ?? 0 }} 个月
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已开票</span>
        <span class="stats__value ok">{{ money(data?.summary.invoicedFen) }}</span>
        <span class="stats__hint">{{ data?.summary.fullCount ?? 0 }} 组已开齐</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">未开票（该催的）</span>
        <span class="stats__value bad">{{ money(data?.summary.uninvoicedFen) }}</span>
        <span class="stats__hint">
          未开 {{ data?.summary.noneCount ?? 0 }} 组 · 部分开
          {{ data?.summary.partialCount ?? 0 }} 组
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">未付款应付</span>
        <span class="stats__value">{{ money(data?.summary.unpaidAmountFen) }}</span>
        <span class="stats__hint">不参与开票判定</span>
      </div>
    </div>

    <el-alert
      v-if="(data?.summary.overdueCount ?? 0) > 0"
      class="warn"
      type="warning"
      :closable="false"
      show-icon
      :title="`${data?.summary.overdueCount} 组已付款超过 ${data?.summary.overdueDays} 天仍未收到发票 —— 税前扣除凭证缺失，属税务风险`"
    />

    <el-card shadow="never" class="table">
      <template #header>
        <span>开票台账</span>
      </template>
      <el-table :data="data?.list ?? []" size="small" border empty-text="没有符合条件的记录">
        <el-table-column label="供应商" min-width="220">
          <template #default="{ row }">
            <div class="cell__name">
              {{ row.supplierName }}
              <el-tag v-if="row.overdue" type="danger" size="small" effect="dark">逾期</el-tag>
            </div>
            <div class="cell__sub">
              抬头：{{ row.invoiceTitle ?? '未登记' }}
              <el-tag v-if="row.titleMissing" type="warning" size="small" effect="plain">
                需补开票抬头
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="月份" width="90" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="STATUS_TAG[row.status as InvoiceStatusValue]" size="small">
              {{ row.statusText }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="应付笔数" width="130">
          <template #default="{ row }">
            <span>已付 {{ row.paidRowCount }}</span>
            <span class="cell__sub"> · 未付 {{ row.unpaidRowCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="已付款额" width="120" align="right">
          <template #default="{ row }">{{ money(row.paidAmountFen) }}</template>
        </el-table-column>
        <el-table-column label="已开票" width="120" align="right">
          <template #default="{ row }">{{ money(row.invoicedFen) }}</template>
        </el-table-column>
        <el-table-column label="未开票" width="120" align="right">
          <template #default="{ row }">
            <span :class="row.uninvoicedFen > 0 ? 'bad' : ''">{{ money(row.uninvoicedFen) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="未付款额" width="120" align="right">
          <template #default="{ row }">{{ money(row.unpaidAmountFen) }}</template>
        </el-table-column>
        <el-table-column label="发票号" min-width="180">
          <template #default="{ row }">
            <span v-if="row.invoiceNos?.length" class="mono">{{ row.invoiceNos.join(' / ') }}</span>
            <span v-else class="cell__sub">—</span>
            <div v-if="(row.reversalFen ?? 0) !== 0" class="cell__sub">
              冲销 {{ signedMoney(row.reversalFen) }}（需另行换票）
            </div>
          </template>
        </el-table-column>
        <el-table-column label="逾期天数" width="100" align="right">
          <template #default="{ row }">
            <span :class="row.overdue ? 'bad' : ''">
              {{ row.overdueDays == null ? '—' : `${row.overdueDays} 天` }}
            </span>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        class="pager"
        layout="total, prev, pager, next"
        :current-page="page"
        :page-size="pageSize"
        :total="data?.total ?? 0"
        @current-change="onPage"
      />

      <p class="note">{{ data?.note }}</p>
    </el-card>
  </div>
</template>

<style lang="scss" scoped>
.bar {
  margin-bottom: $space-3;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-3;
  align-items: center;

  &__right {
    margin-left: auto;
  }
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: $space-3;
  margin-bottom: $space-3;

  &__item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: $space-3;
    background: var(--el-fill-color-light);
    border-radius: 8px;
  }

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    font-size: 20px;
    font-weight: 700;

    &.ok {
      color: var(--el-color-success);
    }

    &.bad {
      color: var(--el-color-danger);
    }
  }

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.warn {
  margin-bottom: $space-3;
}

.table {
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }

  .bad {
    color: var(--el-color-danger);
    font-weight: 600;
  }

  .cell__name {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 13px;
  }

  .cell__sub {
    margin-top: 2px;
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  .pager {
    margin-top: $space-3;
  }
}

.note {
  margin: $space-3 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.8;
}
</style>
