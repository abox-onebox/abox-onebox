<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">页面停留</h2>
    <p class="page-container__meta">
      原型页 / 模块：P35 · M36-05 ｜ 数据来源：匿名埋点 `ab_page_track` ｜ 统计基准：<strong>{{
        data?.anchorLabel ?? '访问日'
      }}</strong>
      <strong>（不是发货日 —— 与其余看板页口径不同）</strong>
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
          <div class="kpi__label">访问次数</div>
          <div class="kpi__value">{{ data.summary.visits }}</div>
          <div class="kpi__sub">成功上报的停留事件条数</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">覆盖页面</div>
          <div class="kpi__value">{{ data.summary.pageCount }}</div>
          <div class="kpi__sub">已按路径归一（H5 与小程序合并）</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">平均每次停留</div>
          <div class="kpi__value">{{ msText(data.summary.avgMs) }}</div>
          <div class="kpi__sub">累计 {{ msText(data.summary.totalMs) }}</div>
        </div>
      </div>

      <el-card shadow="never" class="block">
        <template #header><span>页面排行（按访问次数）</span></template>
        <el-table :data="data.pages" size="small">
          <el-table-column prop="page" label="页面" min-width="200" />
          <el-table-column prop="visits" label="访问次数" width="110" align="right" />
          <el-table-column label="占比" width="100" align="right">
            <template #default="{ row }">{{ pct(row.share) }}</template>
          </el-table-column>
          <el-table-column label="平均停留" width="120" align="right">
            <template #default="{ row }">{{ msText(row.avgMs) }}</template>
          </el-table-column>
          <el-table-column label="中位停留" width="120" align="right">
            <template #default="{ row }">{{ msText(row.medianMs) }}</template>
          </el-table-column>
          <el-table-column label="最长停留" width="120" align="right">
            <template #default="{ row }">{{ msText(row.maxMs) }}</template>
          </el-table-column>
          <template #empty><el-empty description="本区间没有停留数据" /></template>
        </el-table>
        <p class="note">
          中位停留比平均停留更抗干扰：后台挂机一次（最长停留那列会看到）能把平均值拉高， 中位数不会
          —— <strong>判断「用户一般看多久」看中位列</strong>。
        </p>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header><span>分日趋势</span></template>
        <el-table :data="data.daily" size="small">
          <el-table-column prop="date" label="日期" width="140" />
          <el-table-column prop="visits" label="访问次数" width="120" align="right" />
          <el-table-column label="平均停留" width="140" align="right">
            <template #default="{ row }">{{ msText(row.avgMs) }}</template>
          </el-table-column>
          <template #empty><el-empty description="本区间没有停留数据" /></template>
        </el-table>
        <p class="note">
          区间内没有数据的日子<strong>不出行</strong> —— 「没数据」不能被画成 0，
          那会被读成「当天用户停留 0 秒」。
        </p>
      </el-card>

      <el-alert
        v-if="data.droppedRows > 0"
        class="block"
        type="warning"
        :closable="false"
        :title="`本区间有 ${data.droppedRows} 条记录因时刻或时长非法被剔除`"
      >
        <span class="note"
          >被剔除的行<strong>不参与</strong>任何统计（不是按 0 计入）——
          否则一个坏值会把平均值拉偏。</span
        >
      </el-alert>

      <p class="note">{{ data.note }}</p>
    </template>

    <el-empty v-else-if="!loading" description="暂无数据" />
  </div>
</template>

<script setup lang="ts">
// 页面停留 —— D77 /admin/stats/page-duration（原型 P35 · M36-05）
//
// ⚠️ 端上**不复制口径**：区间、聚合、占比全部取服务端（`StatsService.pageDuration`）。
//    这里只做两件事：把毫秒渲染成人能读的时长，以及把服务端下发的口径说明原样展示。
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchPageDuration, STATS_RANGE_OPTIONS } from '@/api/stats';
import type { StatsPageDurationResult, StatsRangeValue } from '@/api/stats';

const loading = ref(false);
const range = ref<StatsRangeValue>('7d');
const data = ref<StatsPageDurationResult | null>(null);

/** 毫秒 → 人读时长（<1s 给毫秒，<60s 给秒，其余给「分 + 秒」） */
const msText = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} 分 ${s} 秒`;
};

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`;

async function reload() {
  loading.value = true;
  try {
    data.value = await fetchPageDuration({ range: range.value });
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

.note {
  margin: $space-2 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}
</style>
