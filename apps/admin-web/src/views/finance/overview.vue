<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchFinanceOverview, type FinanceOverview } from '@/api/finance';

/**
 * P34 资金总览（D33 · M3-13 · 模块 M35-01）
 *
 * ## 页面为什么长这样（三条口径决定）
 * 1. **收入 / 成本 / 毛利与「数据看板」是同一份口径**：服务端 D33 直接调 D47 那套
 *    统计函数，所以这里的 GMV 与看板的 GMV 不可能对不上 —— 端上因此**不做任何计算**，
 *    只展示服务端下发的数（连百分比都是服务端算好的）。
 * 2. **区间只给三档（今日 / 近 7 日 / 近 30 日）+ 一个终点锚点**：放开自由起止日期，
 *    运营会拿「8/1–8/13」和「8/2–8/14」去比，两个区间的自然周不重合，结论全是噪声。
 *    锚点用于**回看已过完的区间**（今天的数据还在长，期末对账要看昨天的）。
 * 3. **余额与待入账佣金是「时点量」**：它们不随区间变化，代表平台**此刻**的负债。
 *    页面把它和区间指标分开摆、并标注「截至 …」，否则会被误读成「本期新增负债」。
 *
 * ⚠️ 经营毛利是**结果值**：履约成本三项未登记、或本期采购应付单还没出，
 *    它就会系统性偏高。服务端把原因放在 `warnings` 里，本页**原样展示** ——
 *    绝不在这里补一句「仅供参考」把它糊过去。
 */
const RANGE_OPTIONS = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近 7 日' },
  { value: '30d', label: '近 30 日' },
];

const loading = ref(false);
const range = ref('7d');
/** 区间终点锚点；空 = 今日（只有回看历史区间时才填） */
const anchor = ref('');
const data = ref<FinanceOverview | null>(null);

const money = (fen?: number | null) => `¥${((fen ?? 0) / 100).toFixed(2)}`;
/** 可为负的金额（毛利）—— 负号放 ¥ 前面更易读 */
const signedMoney = (fen?: number | null) => {
  const v = fen ?? 0;
  return v < 0 ? `-¥${(-v / 100).toFixed(2)}` : `¥${(v / 100).toFixed(2)}`;
};
const pct = (v?: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

const hasWarnings = computed(() => (data.value?.warnings?.length ?? 0) > 0);
const rangeText = computed(() => {
  const r = data.value?.range;
  return r ? `${r.label} · ${r.startDate} ~ ${r.endDate}` : '';
});

const payableTagType = (s: string) =>
  s === 'paid' ? 'success' : s === 'none' ? 'info' : 'warning';

async function load() {
  loading.value = true;
  try {
    data.value = await fetchFinanceOverview({
      range: range.value,
      date: anchor.value || undefined,
    });
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page-container">
    <h2 class="page-container__title">财务结算 · 资金总览</h2>
    <p class="page-container__meta">
      原型页 / 模块：P34 · M35-01 ｜ 收入 / 成本 /
      毛利与「数据看板」<strong>同一份口径</strong>（同一服务端函数）· GMV 不含未支付 / 已取消 /
      已退款（<strong>在途退款计入</strong>）
    </p>

    <el-card shadow="never" class="bar">
      <div class="toolbar">
        <el-radio-group v-model="range" @change="load">
          <el-radio-button v-for="opt in RANGE_OPTIONS" :key="opt.value" :label="opt.value">
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
        <el-date-picker
          v-model="anchor"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="区间终点（默认今日）"
          @change="load"
        />
        <span class="toolbar__hint">{{ rangeText }}</span>
        <div class="toolbar__right">
          <el-button @click="load">刷新</el-button>
        </div>
      </div>
    </el-card>

    <el-alert
      v-for="(w, i) in data?.warnings ?? []"
      :key="i"
      class="warn"
      type="warning"
      :closable="false"
      show-icon
      :title="w"
    />

    <div v-loading="loading" class="stats">
      <div class="stats__item">
        <span class="stats__label">GMV（实收口径）</span>
        <span class="stats__value">{{ money(data?.income.gmvFen) }}</span>
        <span class="stats__hint">
          {{ data?.income.orderCount ?? 0 }} 单 · {{ data?.income.quantity ?? 0 }} 份 · 客单价
          {{ money(data?.income.avgOrderAmountFen) }}
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">经营毛利（结果值）</span>
        <span class="stats__value" :class="(data?.profit.grossProfitFen ?? 0) >= 0 ? 'ok' : 'warn'">
          {{ signedMoney(data?.profit.grossProfitFen) }}
        </span>
        <span class="stats__hint">毛利率 {{ pct(data?.profit.grossProfitRate) }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">团长佣金（净额）</span>
        <span class="stats__value">{{ money(data?.expense.commissionFen) }}</span>
        <span class="stats__hint">含退款冲销</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">供应商采购款</span>
        <span class="stats__value">{{ money(data?.expense.purchaseFen) }}</span>
        <span class="stats__hint">{{
          data?.payable.generated ? '本期已出单' : '本期尚未出单'
        }}</span>
      </div>
    </div>

    <div class="stats stats--second">
      <div class="stats__item">
        <span class="stats__label">应付 · 待付款</span>
        <span class="stats__value warn">{{ money(data?.payable.unpaidFen) }}</span>
        <span class="stats__hint">{{ data?.payable.pendingCount ?? 0 }} 单（人工对公转账）</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">应付 · 已付款</span>
        <span class="stats__value ok">{{ money(data?.payable.paidFen) }}</span>
        <span class="stats__hint">{{ data?.payable.paidCount ?? 0 }} 单</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已退回用户</span>
        <span class="stats__value">{{ money(data?.expense.refundedAmountFen) }}</span>
        <span class="stats__hint">
          退款 {{ data?.income.refundCount ?? 0 }} 单 · 率 {{ pct(data?.income.refundRate) }}
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">平台负债（时点）</span>
        <span class="stats__value">{{ money(data?.liability.balanceFen) }}</span>
        <span class="stats__hint">
          冻结 {{ money(data?.liability.frozenFen) }} · 待入账佣金
          {{ money(data?.liability.pendingCommissionFen) }}
        </span>
      </div>
    </div>

    <el-card shadow="never" class="daily">
      <template #header>
        <div class="daily__head">
          <span>每日结算跑批</span>
          <span class="daily__asof">余额等时点量截至 {{ data?.liability.asOf || '—' }}</span>
        </div>
      </template>
      <el-table v-if="data?.daily?.length" :data="data.daily" size="small" stripe>
        <el-table-column prop="date" label="出餐日" width="120" />
        <el-table-column label="订单数" width="90" align="right">
          <template #default="{ row }">{{ row.orderCount }}</template>
        </el-table-column>
        <el-table-column label="份数" width="90" align="right">
          <template #default="{ row }">{{ row.quantity }}</template>
        </el-table-column>
        <el-table-column label="GMV" min-width="120" align="right">
          <template #default="{ row }"
            ><strong>{{ money(row.gmvFen) }}</strong></template
          >
        </el-table-column>
        <el-table-column label="团长佣金" min-width="110" align="right">
          <template #default="{ row }">{{ money(row.commissionFen) }}</template>
        </el-table-column>
        <el-table-column label="供应商应付" min-width="120" align="right">
          <template #default="{ row }">{{ money(row.purchaseFen) }}</template>
        </el-table-column>
        <el-table-column label="应付状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="payableTagType(row.payableStatus)">
              {{ row.payableStatusText }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="该区间暂无有效订单" />
    </el-card>

    <el-card shadow="never" class="cost">
      <template #header>成本登记状态（履约成本三项 · 修改请到「系统配置」）</template>
      <div class="cost__row">
        <span>场所摊销 {{ money((data?.costItems.siteFee ?? 0) * 100) }}/份</span>
        <span>打包人工 {{ money((data?.costItems.packingLaborFee ?? 0) * 100) }}/份</span>
        <span>配送费 {{ money((data?.costItems.deliveryFee ?? 0) * 100) }}/份</span>
        <el-tag :type="data?.costRegistration.allRegistered ? 'success' : 'warning'" size="small">
          {{ data?.costRegistration.allRegistered ? '三项均已登记' : '存在未登记项' }}
        </el-tag>
      </div>
      <p v-if="hasWarnings" class="cost__missing">
        未登记：{{ (data?.costRegistration.missingLabels ?? []).join(' / ') || '—' }}
        （未登记时按 0 计算，毛利会被高估）
      </p>
    </el-card>

    <p v-if="data?.note" class="note">{{ data.note }}</p>
  </div>
</template>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-4;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.bar {
  margin-bottom: $space-3;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__right {
    display: flex;
    gap: $space-2;
    margin-left: auto;
  }
}

.warn {
  margin-bottom: $space-2;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: $space-4;
  padding: $space-3;
  margin-bottom: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  /* 第二组是「应付状态 / 平台负债」，与第一组（区间损益）用虚线框刻意区分 */
  &--second {
    background: transparent;
    border-style: dashed;
  }

  &__item {
    display: flex;
    flex-direction: column;
    min-width: 180px;
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

    &.warn {
      color: var(--el-color-warning);
    }
  }

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.daily {
  margin-bottom: $space-3;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__asof {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.cost {
  margin-bottom: $space-3;

  &__row {
    display: flex;
    flex-wrap: wrap;
    gap: $space-3;
    align-items: center;
  }

  &__missing {
    margin: $space-2 0 0;
    color: var(--el-color-warning);
    font-size: $fs-caption;
  }
}

.note {
  margin: 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.8;
}
</style>
