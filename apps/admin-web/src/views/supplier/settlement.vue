<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchSettlement, type SettlementData } from '@/api/supplier-portal';

/**
 * P25 应付结算明细（S9 · M3-9 · 《ABox一盒自营结算口径定义v1.0.md》）
 *
 * ## 两句话讲清这页
 * 1. **你交多少，平台付多少**：计费基数是你在「出餐确认」里申报的**实收量**
 *    （未申报视为足额）—— 短送即少付，所以你如实申报既是对账依据，也是自己的收入依据。
 * 2. **价格是你的协商价**，按菜逐项列示；平台怎么卖、卖多少钱，与你的结算无关。
 *
 * ⚠️ 本页**看不到**终端售价 ¥25.80 / 佣金 / 毛利 —— 这不是前端隐藏，而是服务端
 *    出参结构里就没有这些字段（不变量 I1）。
 * ⚠️ 应付单在**次日凌晨**按前一日实际交付量生成，所以查「今天」常常是空的，
 *    属正常状态（页面给说明，不报错）。
 */
const loading = ref(false);
const date = ref('');
const data = ref<SettlementData | null>(null);

const rows = computed(() => data.value?.list ?? []);
const isEmpty = computed(() => data.value?.summary?.empty === true);

const money = (fen?: number) => `¥${((fen ?? 0) / 100).toFixed(2)}`;

const statusType = (s: string) => (s === 'success' ? 'success' : 'warning');

async function load() {
  loading.value = true;
  try {
    data.value = await fetchSettlement(date.value || undefined);
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="portal-page">
    <el-card shadow="never">
      <div class="head">
        <div>
          <h3>应付结算明细</h3>
          <p class="sub">
            {{ data?.supplier?.name ?? '—' }} · 计费基数 = 实收量（你申报的实送份数）· 按菜逐项列示
          </p>
        </div>
        <div class="ops">
          <el-date-picker
            v-model="date"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="出餐日（默认今天）"
            clearable
            @change="load"
          />
          <el-button @click="load">刷新</el-button>
        </div>
      </div>
    </el-card>

    <el-row :gutter="12" class="kpi-row">
      <el-col :span="6">
        <el-card shadow="never" class="kpi-card">
          <div class="kpi">
            <div class="kpi-v warn">{{ money(data?.summary?.pendingTotalAmountFen) }}</div>
            <div class="kpi-l">
              平台待付合计（全部日期 · {{ data?.summary?.pendingTotalRowCount ?? 0 }} 单）
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="kpi-card">
          <div class="kpi">
            <div class="kpi-v">{{ money(data?.summary?.amountFen) }}</div>
            <div class="kpi-l">
              {{ data?.date ?? '—' }} 应付合计（{{ data?.summary?.rowCount ?? 0 }} 单）
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="kpi-card">
          <div class="kpi">
            <div class="kpi-v ok">{{ money(data?.summary?.paidAmountFen) }}</div>
            <div class="kpi-l">其中已付款（{{ data?.summary?.paidCount ?? 0 }} 单）</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="kpi-card">
          <div class="kpi">
            <div class="kpi-v">{{ data?.summary?.quantity ?? 0 }}</div>
            <div class="kpi-l">当日实收份数合计（结算依据）</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <el-table v-if="rows.length" :data="rows" size="small" stripe>
        <el-table-column prop="shareNo" label="应付单号" min-width="150" />
        <el-table-column prop="mealDate" label="出餐日" width="110" />
        <el-table-column prop="dishName" label="菜品" min-width="120" />
        <el-table-column label="实收量" width="90" align="right">
          <template #default="{ row }">{{ row.quantity }}</template>
        </el-table-column>
        <el-table-column label="我的单价" width="110" align="right">
          <template #default="{ row }">{{ money(row.unitPriceFen) }}</template>
        </el-table-column>
        <el-table-column label="应付金额" width="120" align="right">
          <template #default="{ row }"
            ><strong>{{ money(row.amountFen) }}</strong></template
          >
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ row.statusLabel }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="银行回单号" min-width="150">
          <template #default="{ row }">{{ row.paymentVoucherNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="付款日" min-width="150">
          <template #default="{ row }">{{ row.paidAt || '—' }}</template>
        </el-table-column>
      </el-table>

      <el-empty
        v-else
        :description="
          isEmpty
            ? '该出餐日暂无应付单 —— 应付单在次日凌晨按实际交付量生成，当日看不到属正常'
            : '暂无数据'
        "
      />
    </el-card>

    <el-card v-if="data?.notes" shadow="never" class="notes">
      <template #header>
        <span>结算说明</span>
      </template>
      <ul class="notes__list">
        <li v-for="(v, k) in data.notes" :key="k">{{ v }}</li>
      </ul>
    </el-card>
  </div>
</template>

<style lang="scss" scoped>
.portal-page {
  padding: 4px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  h3 {
    margin: 0 0 4px;
  }
}

.sub {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.ops {
  display: flex;
  gap: 8px;
  align-items: center;
}

.kpi-row {
  margin: $space-3 0;
}

.kpi-card {
  height: 100%;
}

.kpi {
  text-align: center;

  &-v {
    font-size: 24px;
    font-weight: 700;

    &.ok {
      color: var(--el-color-success);
    }

    &.warn {
      color: var(--el-color-warning);
    }
  }

  &-l {
    margin-top: 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}

.notes {
  margin-top: $space-3;

  &__list {
    padding-left: 18px;
    margin: 0;
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.9;
  }
}
</style>
