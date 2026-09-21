<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">核心指标看板</h2>
    <p class="page-container__meta">
      原型页 / 模块：P35 · M36-01 ｜ 口径见《接口规范》§6.6 ｜ 统计基准：<strong>出餐日</strong>
    </p>

    <el-card shadow="never" class="block">
      <div class="toolbar">
        <el-radio-group v-model="range" size="default" @change="reload">
          <el-radio-button v-for="o in STATS_RANGE_OPTIONS" :key="o.value" :value="o.value">
            {{ o.label }}
          </el-radio-button>
        </el-radio-group>
        <div class="toolbar__right">
          <span v-if="data" class="range-hint">
            区间 {{ data.range.startDate }} ~ {{ data.range.endDate }}（共
            {{ data.range.days }} 天）
          </span>
          <el-button :loading="loading" @click="reload">刷新</el-button>
        </div>
      </div>
    </el-card>

    <!-- ⚠️ 毛利可靠性提示：任何一个减项缺失都会让经营毛利虚高，必须显式说出来 -->
    <el-alert
      v-for="(w, i) in data?.warnings ?? []"
      :key="i"
      type="warning"
      :closable="false"
      show-icon
      class="block"
      :title="w"
    />

    <template v-if="data">
      <div class="kpi-grid">
        <div class="kpi">
          <div class="kpi__label">单量</div>
          <div class="kpi__value">{{ m.orderCount }}</div>
          <div class="kpi__sub">共 {{ m.quantity }} 份 ｜ 未支付 {{ m.pendingPayCount }} 单</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">GMV</div>
          <div class="kpi__value">{{ fenToCny(m.gmvFen) }}</div>
          <!-- ⚠️ 本文案是 stats.constants.ts `STATS_VALID_STATUSES` 的**投影**，口径改那里、这里跟着改。
               曾写成「不含已取消 / 已退款」—— 漏了未支付，且与「在途退款计入」的实现相矛盾。 -->
          <div class="kpi__sub">不含未支付 / 已取消 / 已退款（在途退款计入）</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">客单价</div>
          <div class="kpi__value">{{ fenToCny(m.avgOrderAmountFen) }}</div>
          <div class="kpi__sub">
            单份均价 {{ fenToCny(m.avgUnitPriceFen) }}（两者不同：一单可多份）
          </div>
        </div>
        <div class="kpi">
          <div class="kpi__label">退款率</div>
          <div class="kpi__value">{{ pct(m.refundRate) }}</div>
          <div class="kpi__sub">{{ m.refundCount }} 单 / {{ m.totalOrderCount }} 单</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">复购率</div>
          <div class="kpi__value">{{ pct(m.repeatRate) }}</div>
          <div class="kpi__sub">{{ m.repeatUserCount }} / {{ m.activeUserCount }} 位下单用户</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">活跃用户</div>
          <div class="kpi__value">{{ m.activeUserCount }}</div>
          <div class="kpi__sub">去重 · 区间内有有效订单</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">活跃团长</div>
          <div class="kpi__value">{{ m.activeLeaderCount }}</div>
          <div class="kpi__sub">去重</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">活跃楼栋</div>
          <div class="kpi__value">{{ m.activeBuildingCount }}</div>
          <div class="kpi__sub">去重</div>
        </div>
      </div>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="card-head">
            <span>经营毛利（结果值）</span>
            <el-tag v-if="!profitReliable" type="warning" size="small" effect="plain">
              上限值
            </el-tag>
            <el-tag v-else type="success" size="small" effect="plain">已扣全成本</el-tag>
          </div>
        </template>
        <div class="profit">
          <div class="profit__value" :class="{ 'is-negative': m.grossProfitFen < 0 }">
            {{ fenToCny(m.grossProfitFen) }}
          </div>
          <div class="profit__rate">
            毛利率 {{ m.grossProfitRate === null ? '—' : pct(m.grossProfitRate) }}
          </div>
        </div>
        <table class="breakdown">
          <tbody>
            <tr>
              <td>GMV（收入）</td>
              <td class="num">{{ fenToCny(m.gmvFen) }}</td>
            </tr>
            <tr>
              <td>
                半成品采购款
                <span v-if="!data.purchaseGenerated" class="mark">未出单 · 按 0 计</span>
              </td>
              <td class="num">− {{ fenToCny(m.purchaseFen) }}</td>
            </tr>
            <tr>
              <td>
                履约成本（场所摊销 / 打包人工 / 配送费）
                <span v-if="!data.costRegistration.allRegistered" class="mark">
                  未登记：{{ data.costRegistration.missingLabels.join(' / ') }}
                </span>
              </td>
              <td class="num">− {{ fenToCny(m.fulfillmentFen) }}</td>
            </tr>
            <tr>
              <td>团长佣金（净额 · 含反向冲销）</td>
              <td class="num">− {{ fenToCny(m.commissionFen) }}</td>
            </tr>
            <tr class="total">
              <td>= 经营毛利</td>
              <td class="num">{{ fenToCny(m.grossProfitFen) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="note">
          履约成本三项当前值（元/份）：场所摊销 {{ data.costItems.siteFee }} ｜ 打包人工
          {{ data.costItems.packingLaborFee }} ｜ 配送费 {{ data.costItems.deliveryFee }} ——
          可在「系统配置 →
          履约成本」登记真实值。退款份数的采购款仍要支付给供应商（退款不冲减应付），
          故退款场景下经营毛利可能为负，这是正常承担的经营风险。
        </p>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>
          <span>逐日趋势（{{ data.range.label }} · 无单日补 0）</span>
        </template>
        <div v-if="data.trend.length" class="trend">
          <div v-for="d in data.trend" :key="d.date" class="trend__col">
            <div class="trend__bar-wrap">
              <div
                class="trend__bar"
                :style="{ height: barHeight(d.gmvFen) }"
                :title="`${d.date} · ${fenToCny(d.gmvFen)} · ${d.orderCount} 单`"
              />
            </div>
            <div class="trend__val">{{ d.orderCount }}</div>
            <div class="trend__date">{{ d.date.slice(5) }}</div>
          </div>
        </div>
        <el-empty v-else description="区间内暂无订单" />
      </el-card>
    </template>

    <el-empty v-else-if="!loading" description="暂无数据" />
  </div>
</template>

<script setup lang="ts">
// 核心指标看板 —— D47 /admin/stats/dashboard（原型 P35 · M36-01）
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchStatsDashboard, STATS_RANGE_OPTIONS } from '@/api/stats';
import type { StatsDashboardResult, StatsRangeValue } from '@/api/stats';
import { fenToCny } from '@/utils/format';

const loading = ref(false);
const range = ref<StatsRangeValue>('7d');
const data = ref<StatsDashboardResult | null>(null);

const m = computed(() => data.value?.metrics ?? ({} as StatsDashboardResult['metrics']));

/** 毛利是否为可靠值（两个减项都齐了才算） */
const profitReliable = computed(
  () => !!data.value && data.value.purchaseGenerated && data.value.costRegistration.allRegistered,
);

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`;

/** 趋势柱高：以区间内最大 GMV 为基准（全 0 时给 2% 占位，避免柱子完全消失） */
const maxGmv = computed(() => Math.max(1, ...(data.value?.trend ?? []).map((t) => t.gmvFen)));
function barHeight(v: number) {
  const h = Math.round((v / maxGmv.value) * 100);
  return `${Math.max(v > 0 ? 4 : 0, h)}%`;
}

async function reload() {
  loading.value = true;
  try {
    data.value = await fetchStatsDashboard({ range: range.value });
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => void reload());
</script>

<style lang="scss" scoped>
.block {
  margin-bottom: $space-3;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
  flex-wrap: wrap;

  &__right {
    display: flex;
    align-items: center;
    gap: $space-2;
  }
}

.range-hint {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: $space-2;
  margin-bottom: $space-3;
}

.kpi {
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;
  padding: $space-3;

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    color: $c-text;
    font-size: $fs-h1;
    font-weight: 700;
    margin: 4px 0;
  }

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.card-head {
  display: flex;
  align-items: center;
  gap: $space-2;
}

.profit {
  display: flex;
  align-items: baseline;
  gap: $space-3;
  margin-bottom: $space-2;

  &__value {
    font-size: 28px;
    font-weight: 700;
    color: $c-ok-fg;

    &.is-negative {
      color: $c-warn-fg;
    }
  }

  &__rate {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.breakdown {
  width: 100%;
  border-collapse: collapse;

  td {
    padding: 6px 0;
    border-bottom: 1px dashed $c-border;
    font-size: $fs-body;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .total td {
    font-weight: 700;
    border-bottom: none;
  }
}

.mark {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: $radius-sm;
  background: rgba(196, 69, 54, 0.1);
  color: $c-warn-fg;
  font-size: $fs-caption;
}

.note {
  margin: $space-2 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}

.trend {
  display: flex;
  align-items: flex-end;
  gap: $space-1;
  min-height: 160px;

  &__col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  &__bar-wrap {
    width: 100%;
    height: 110px;
    display: flex;
    align-items: flex-end;
  }

  &__bar {
    width: 100%;
    background: $c-gold;
    border-radius: $radius-sm $radius-sm 0 0;
    transition: height 0.2s;
  }

  &__val {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__date {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}
</style>
