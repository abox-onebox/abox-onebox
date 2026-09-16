<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">楼群 / 办公楼榜单</h2>
    <p class="page-container__meta">
      原型页 / 模块：P35 · M36-02 ｜ 按 GMV 降序 ｜ 统计基准：<strong>出餐日</strong>
    </p>

    <el-card shadow="never" class="block">
      <div class="toolbar">
        <el-radio-group v-model="range" @change="reload">
          <el-radio-button v-for="o in STATS_RANGE_OPTIONS" :key="o.value" :value="o.value">
            {{ o.label }}
          </el-radio-button>
        </el-radio-group>
        <div class="toolbar__right">
          <span v-if="data" class="range-hint">
            区间 {{ data.range.startDate }} ~ {{ data.range.endDate }} ｜ 合计 GMV
            {{ fenToCny(data.totalGmvFen) }}
          </span>
          <el-button :loading="loading" @click="reload">刷新</el-button>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header
        ><span>楼群（{{ data?.groups.length ?? 0 }} 个）</span></template
      >
      <el-table :data="data?.groups ?? []" size="small">
        <el-table-column type="index" label="#" width="56" />
        <el-table-column prop="name" label="楼群" min-width="140" />
        <el-table-column prop="orderCount" label="订单数" width="90" align="right" />
        <el-table-column prop="quantity" label="份数" width="90" align="right" />
        <el-table-column label="GMV" width="120" align="right">
          <template #default="{ row }">{{ fenToCny(row.gmvFen) }}</template>
        </el-table-column>
        <el-table-column label="占比" min-width="180">
          <template #default="{ row }">
            <div class="share">
              <el-progress
                :percentage="Number((row.gmvShare * 100).toFixed(1))"
                :show-text="false"
                :stroke-width="8"
              />
              <span class="share__text">{{ pct(row.gmvShare) }}</span>
            </div>
          </template>
        </el-table-column>
        <template #empty><el-empty description="区间内无订单" /></template>
      </el-table>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header
        ><span>办公楼（{{ data?.buildings.length ?? 0 }} 栋）</span></template
      >
      <el-table :data="data?.buildings ?? []" size="small">
        <el-table-column type="index" label="#" width="56" />
        <el-table-column prop="name" label="办公楼" min-width="140" />
        <el-table-column prop="buildingGroupName" label="所属楼群" min-width="120" />
        <el-table-column prop="orderCount" label="订单数" width="90" align="right" />
        <el-table-column prop="quantity" label="份数" width="90" align="right" />
        <el-table-column label="GMV" width="120" align="right">
          <template #default="{ row }">{{ fenToCny(row.gmvFen) }}</template>
        </el-table-column>
        <el-table-column label="占比" min-width="180">
          <template #default="{ row }">
            <div class="share">
              <el-progress
                :percentage="Number((row.gmvShare * 100).toFixed(1))"
                :show-text="false"
                :stroke-width="8"
              />
              <span class="share__text">{{ pct(row.gmvShare) }}</span>
            </div>
          </template>
        </el-table-column>
        <template #empty><el-empty description="区间内无订单" /></template>
      </el-table>
      <p class="note">
        楼群 / 楼栋被停用或删除后，其历史订单仍会出现在榜单（名称回退为
        <code>楼群#id</code> / <code>楼栋#id</code>）—— 若把这类行藏起来，会出现「分项之和 ≠ 合计
        GMV」。
      </p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
// 楼群 / 办公楼榜单 —— D48 /admin/stats/building-rank（原型 P35 · M36-02）
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchBuildingRank, STATS_RANGE_OPTIONS } from '@/api/stats';
import type { StatsBuildingRankResult, StatsRangeValue } from '@/api/stats';
import { fenToCny } from '@/utils/format';

const loading = ref(false);
const range = ref<StatsRangeValue>('7d');
const data = ref<StatsBuildingRankResult | null>(null);

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`;

async function reload() {
  loading.value = true;
  try {
    data.value = await fetchBuildingRank({ range: range.value });
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
