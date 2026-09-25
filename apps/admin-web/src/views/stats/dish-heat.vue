<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">菜品热度</h2>
    <p class="page-container__meta">
      原型页 / 模块：P35 · M36-03 ｜ 统计基准：<strong>出餐日</strong> ｜ 口味评价为 P1-U2 增补（D69
      · 同页第二 Tab）
    </p>

    <el-tabs v-model="tab" class="tabs" @tab-change="onTabChange">
      <!-- Tab 1 · 菜品热度（D49 · 既有内容不动） -->
      <el-tab-pane label="菜品热度" name="heat">
        <el-card shadow="never" class="block">
          <div class="toolbar">
            <el-radio-group v-model="range" @change="reloadHeat">
              <el-radio-button v-for="o in STATS_RANGE_OPTIONS" :key="o.value" :value="o.value">
                {{ o.label }}
              </el-radio-button>
            </el-radio-group>
            <div class="toolbar__right">
              <el-select v-model="topN" style="width: 120px" @change="reloadHeat">
                <el-option v-for="n in TOP_N_OPTIONS" :key="n" :label="`TOP ${n}`" :value="n" />
              </el-select>
              <el-button :loading="loading" @click="reloadHeat">刷新</el-button>
            </div>
          </div>
          <div v-if="data" class="summary">
            区间 {{ data.range.startDate }} ~ {{ data.range.endDate }} ｜ 共
            <strong>{{ data.dishCount }}</strong> 个菜品 /
            <strong>{{ data.totalQuantity }}</strong> 份
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
      </el-tab-pane>

      <!-- Tab 2 · 口味评价（D69 · P1-U2） -->
      <el-tab-pane label="口味评价" name="rating">
        <el-card shadow="never" class="block">
          <div class="toolbar">
            <el-radio-group v-model="ratingRange" @change="reloadRating">
              <el-radio-button v-for="o in STATS_RANGE_OPTIONS" :key="o.value" :value="o.value">
                {{ o.label }}
              </el-radio-button>
            </el-radio-group>
            <div class="toolbar__right">
              <el-button :loading="ratingLoading" @click="reloadRating">刷新</el-button>
            </div>
          </div>
          <div v-if="rating" class="summary">
            区间 {{ rating.range.startDate }} ~ {{ rating.range.endDate }} ｜ 共
            <strong>{{ rating.totalRatings }}</strong> 条评价 /
            <strong>{{ rating.dishCount }}</strong> 个菜品 ｜ 红线阈值：本月被投诉
            <strong>{{ rating.redLineThreshold }}</strong> 次标红
          </div>
        </el-card>

        <el-card v-if="rating" shadow="never" class="block">
          <template #header><span>本周最差三道菜（P1 验收口径）</span></template>
          <template v-if="rating.worstThree.length">
            <div class="worst">
              <div v-for="(w, i) in rating.worstThree" :key="w.dishId" class="worst__item">
                <span class="worst__rank">{{ i + 1 }}</span>
                <span class="worst__name">{{ w.dishName }}</span>
                <span class="worst__count">{{ w.badCount }} 次投诉</span>
              </div>
            </div>
          </template>
          <el-empty v-else description="区间内没有差评 —— 无「最差」可排" :image-size="60" />
          <p class="note">
            排序：区间内投诉次数降序（同投诉次数时差评率越高越靠前）。样本只有一两条时请结合
            「被评次数」判断 —— 一条差评的菜与十条差评的菜不是同一回事。
          </p>
        </el-card>

        <el-card shadow="never" class="block">
          <template #header><span>菜品红黑榜（按投诉次数降序）</span></template>
          <el-table :data="rating?.items ?? []" size="small" :row-class-name="rowClass">
            <el-table-column type="index" label="#" width="56" />
            <el-table-column prop="dishName" label="菜品" min-width="130" />
            <el-table-column prop="supplierName" label="供应商" min-width="110" />
            <el-table-column prop="ratedCount" label="被评" width="70" align="right" />
            <el-table-column prop="goodCount" label="好吃" width="70" align="right" />
            <el-table-column prop="okCount" label="一般" width="70" align="right" />
            <el-table-column prop="badCount" label="不好" width="70" align="right" />
            <el-table-column label="差评率" width="90" align="right">
              <template #default="{ row }">{{ pct(row.badRate) }}</template>
            </el-table-column>
            <el-table-column label="本月投诉" width="120" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.redLine" type="danger" size="small" effect="dark">
                  红线 {{ row.monthBadCount }} 次
                </el-tag>
                <span v-else>{{ row.monthBadCount }} 次</span>
              </template>
            </el-table-column>
            <el-table-column label="最近差评原因" min-width="180">
              <template #default="{ row }">
                <span v-if="row.recentReasons.length">{{ row.recentReasons.join('；') }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="区间内无评价 —— 上线前无真实用餐属预期，不是故障" />
            </template>
          </el-table>
          <p class="note">
            口径：用户在订单详情页<strong>逐菜三键</strong>（好吃 / 一般 / 不好，可选填原因），
            一次提交即定稿不可改；只有已送达 / 已完成的订单可评。菜品与供应商名取
            <strong>评价落库时的快照</strong>（此后改名不影响历史行）。区间与红线均按
            <strong>出餐日</strong>计；「本月投诉」按区间终点锚所在自然月。
          </p>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
// 菜品热度页 —— D49 /admin/stats/dish-heat（原型 P35 · M36-03）
//            + D69 /admin/stats/dish-rating（P1-U2 口味红黑榜 · 同页第二 Tab）
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchDishHeat, fetchDishRating, STATS_RANGE_OPTIONS, TOP_N_OPTIONS } from '@/api/stats';
import type { StatsDishHeatResult, StatsDishRatingResult, StatsRangeValue } from '@/api/stats';

const loading = ref(false);
const range = ref<StatsRangeValue>('7d');
const topN = ref(10);
const data = ref<StatsDishHeatResult | null>(null);

const tab = ref('heat');
const ratingLoading = ref(false);
const ratingRange = ref<StatsRangeValue>('7d');
const rating = ref<StatsDishRatingResult | null>(null);

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`;

/** 红线行整行淡红底（除 tag 外再给一层「扫一眼就能看见」的信号） */
const rowClass = ({ row }: { row: StatsDishRatingResult['items'][number] }) =>
  row.redLine ? 'row-redline' : '';

async function reloadHeat() {
  loading.value = true;
  try {
    data.value = await fetchDishHeat({ range: range.value, topN: topN.value });
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function reloadRating() {
  ratingLoading.value = true;
  try {
    rating.value = await fetchDishRating({ range: ratingRange.value });
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    ratingLoading.value = false;
  }
}

/** Tab 懒加载：口味评价首次切入才拉数（viewer 常只看热度，省一次请求） */
function onTabChange(name: string | number) {
  if (name === 'rating' && !rating.value) void reloadRating();
}

onMounted(() => void reloadHeat());
</script>

<style lang="scss" scoped>
.tabs {
  margin-top: $space-2;
}

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

.worst {
  display: flex;
  gap: $space-3;
  flex-wrap: wrap;

  &__item {
    display: flex;
    align-items: center;
    gap: $space-2;
    padding: $space-2 $space-3;
    background: $c-surface-2;
    border-radius: $radius-sm;
  }

  &__rank {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: $c-gold-deep;
    color: #fff;
    font-size: $fs-caption;
  }

  &__name {
    font-weight: 600;
  }

  &__count {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.muted {
  color: $c-text-weak;
}

.note {
  margin: $space-3 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}

:deep(.row-redline) {
  background: $c-warn-bg;
}
</style>
