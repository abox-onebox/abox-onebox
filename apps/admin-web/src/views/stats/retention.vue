<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">留存分析</h2>
    <p class="page-container__meta">
      原型页 / 模块：P35 · M36-04 ｜ 按「首单所在自然周」分群 ｜ 统计基准：<strong>出餐日</strong>
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
            区间 {{ data.range.startDate }} ~ {{ data.range.endDate }}
          </span>
          <el-button :loading="loading" @click="reload">刷新</el-button>
        </div>
      </div>
    </el-card>

    <template v-if="data">
      <div class="kpi-grid">
        <div class="kpi">
          <div class="kpi__label">活跃用户</div>
          <div class="kpi__value">{{ s.activeUserCount }}</div>
          <div class="kpi__sub">区间内有过有效订单</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">新客</div>
          <div class="kpi__value">{{ s.newUserCount }}</div>
          <div class="kpi__sub">首单落在本区间内</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">回流</div>
          <div class="kpi__value">{{ s.returningUserCount }}</div>
          <div class="kpi__sub">首单早于本区间</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">复购率</div>
          <div class="kpi__value">{{ pct(s.repeatRate) }}</div>
          <div class="kpi__sub">
            {{ s.repeatUserCount }} / {{ s.activeUserCount }}（区间内 ≥2 单）
          </div>
        </div>
      </div>

      <el-card shadow="never" class="block">
        <template #header><span>首单分群留存（次周）</span></template>
        <el-table :data="data.cohorts" size="small">
          <el-table-column label="首单周" min-width="180">
            <template #default="{ row }">{{ row.cohortStart }} ~ {{ row.cohortEnd }}</template>
          </el-table-column>
          <el-table-column prop="newUserCount" label="新客数" width="100" align="right" />
          <el-table-column label="次周留存" width="110" align="right">
            <template #default="{ row }">
              <!-- 按**字段是否为 null** 渲染，不按 `observable` 渲染：两者语义不同 -->
              <span v-if="row.retainedWeek1 !== null">{{ row.retainedWeek1 }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="次周留存率" width="120" align="right">
            <template #default="{ row }">
              <span v-if="row.retentionRate1 !== null">{{ pct(row.retentionRate1) }}</span>
              <el-tag v-else-if="!row.observable" size="small" type="info" effect="plain">
                观察中
              </el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无分群数据" /></template>
        </el-table>
        <p class="note">
          <strong>观察窗口未走完的群不下发留存率</strong>（标「观察中」）——
          此时若照算，低留存只反映「数据还没长出来」，会让运营误判新客质量。
        </p>
        <p class="note">
          当周 0 新客的群显示「—」：分母是 0，比率无意义 —— <strong>「—」不是 0%</strong>，
          两者在运营眼里是天差地别的两件事。
        </p>
        <p class="note">{{ data.note }}</p>
      </el-card>
    </template>

    <el-empty v-else-if="!loading" description="暂无数据" />
  </div>
</template>

<script setup lang="ts">
// 留存分析 —— D50 /admin/stats/retention（原型 P35 · M36-04）
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchRetention, STATS_RANGE_OPTIONS } from '@/api/stats';
import type { StatsRangeValue, StatsRetentionResult } from '@/api/stats';

const loading = ref(false);
const range = ref<StatsRangeValue>('30d');
const data = ref<StatsRetentionResult | null>(null);

const s = computed(() => data.value?.summary ?? ({} as StatsRetentionResult['summary']));

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`;

async function reload() {
  loading.value = true;
  try {
    // 留存天然需要更长观察窗，故本页默认 30 日（其余看板默认 7 日）
    data.value = await fetchRetention({ range: range.value });
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

.muted {
  color: $c-text-weak;
}

.note {
  margin: $space-2 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}
</style>
