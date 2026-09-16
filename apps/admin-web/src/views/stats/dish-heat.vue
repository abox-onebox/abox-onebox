<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">菜品热度</h2>
    <p class="page-container__meta">
      原型页 / 模块：P35 · M36-03 ｜ 按份数降序 ｜ 统计基准：<strong>出餐日</strong>
    </p>

    <el-card shadow="never" class="block">
      <div class="toolbar">
        <el-radio-group v-model="range" @change="reload">
          <el-radio-button v-for="o in STATS_RANGE_OPTIONS" :key="o.value" :value="o.value">
            {{ o.label }}
          </el-radio-button>
        </el-radio-group>
        <div class="toolbar__right">
          <el-select v-model="topN" style="width: 120px" @change="reload">
            <el-option v-for="n in TOP_N_OPTIONS" :key="n" :label="`TOP ${n}`" :value="n" />
          </el-select>
          <el-button :loading="loading" @click="reload">刷新</el-button>
        </div>
      </div>
      <div v-if="data" class="summary">
        区间 {{ data.range.startDate }} ~ {{ data.range.endDate }} ｜ 共
        <strong>{{ data.dishCount }}</strong> 个菜品 / <strong>{{ data.totalQuantity }}</strong> 份
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header
        ><span>菜品份数排行（TOP {{ data?.topN ?? topN }}）</span></template
      >
      <el-table :data="data?.items ?? []" size="small">
        <el-table-column type="index" label="#" width="56" />
        <el-table-column prop="dishName" label="菜品" min-width="140" />
        <el-table-column prop="supplierName" label="供应商" min-width="120" />
        <el-table-column prop="quantity" label="份数" width="90" align="right" />
        <el-table-column prop="orderCount" label="订单数" width="90" align="right" />
        <el-table-column label="占比" min-width="200">
          <template #default="{ row }">
            <div class="share">
              <el-progress
                :percentage="Number((row.share * 100).toFixed(1))"
                :show-text="false"
                :stroke-width="8"
              />
              <span class="share__text">{{ pct(row.share) }}</span>
            </div>
          </template>
        </el-table-column>
        <template #empty><el-empty description="区间内无订单" /></template>
      </el-table>
      <p class="note">
        口径：一份套餐含多个菜品（一饭四菜），统计时<strong>每个菜品各计一次订单份数</strong> ——
        即「这份饭里这个菜被送出了多少次」。占比分母是区间内<strong>全部</strong>菜品份数
        {{ data?.totalQuantity ?? 0 }}，不是 TOP N 之和（按 TOP N
        之和算会让排行末位的占比凭空变大）。
      </p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
// 菜品热度 —— D49 /admin/stats/dish-heat（原型 P35 · M36-03）
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchDishHeat, STATS_RANGE_OPTIONS, TOP_N_OPTIONS } from '@/api/stats';
import type { StatsDishHeatResult, StatsRangeValue } from '@/api/stats';

const loading = ref(false);
const range = ref<StatsRangeValue>('7d');
const topN = ref(10);
const data = ref<StatsDishHeatResult | null>(null);

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`;

async function reload() {
  loading.value = true;
  try {
    data.value = await fetchDishHeat({ range: range.value, topN: topN.value });
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

.summary {
  margin-top: $space-2;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.share {
  display: flex;
  align-items: center;
  gap: $space-2;

  :deep(.el-progress) {
    flex: 1;
  }

  &__text {
    width: 52px;
    text-align: right;
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.note {
  margin: $space-3 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}
</style>
