<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchPackingTasks, type PackingCenter, type PackingData } from '@/api/supplier-portal';

/**
 * 集散中心打包任务（《接口规范》S3 · 原型 P22 的下游）
 *
 * 闸门语义：该中心当日**所有**菜品均已确认送达，才 `ready=true`。
 * 未到齐时列出 `blockers` —— 未到齐就开包，会包出缺菜的餐。
 *
 * ⚠️ 非集散型主体返回 `visible=false`（HTTP 200）：**「你没有这项任务」是正常状态**，
 *    不是错误，所以这里走空态而不是报错。
 */
const loading = ref(false);
const date = ref('');
const data = ref<PackingData | null>(null);

const centers = computed<PackingCenter[]>(() => data.value?.centers ?? []);
const visible = computed(() => data.value?.visible === true);

async function load() {
  loading.value = true;
  try {
    data.value = await fetchPackingTasks(date.value || undefined);
    if (data.value?.date) date.value = data.value.date;
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="portal-page">
    <el-card shadow="never">
      <div class="head">
        <div>
          <h3>集散中心打包任务</h3>
          <p class="sub">按路线分装并安排配送 · 出餐日 {{ date || '—' }}</p>
        </div>
        <div class="ops">
          <el-date-picker
            v-model="date"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="出餐日"
            clearable
            @change="load"
          />
          <el-button @click="load">刷新</el-button>
        </div>
      </div>
    </el-card>

    <!-- 非集散型主体：这是正常状态，不是错误 -->
    <el-empty v-if="!loading && !visible" :description="data?.reason ?? '当前主体没有打包任务'" />

    <template v-for="c in centers" :key="c.centerId">
      <el-card shadow="never" style="margin-top: 12px">
        <div class="center-head">
          <div>
            <strong>{{ c.centerName }}</strong>
            <span class="sub" style="margin-left: 8px">{{ c.centerAddress }}</span>
            <span v-if="c.contactName" class="sub" style="margin-left: 8px">
              · {{ c.contactName }} {{ c.contactPhone ?? '' }}
            </span>
          </div>
          <el-tag :type="c.ready ? 'success' : 'warning'" size="small">
            {{ c.ready ? '可开始打包' : '未到齐，暂不可开包' }}
          </el-tag>
        </div>

        <!-- 闸门：欠哪些 -->
        <el-alert
          v-if="!c.ready"
          type="warning"
          show-icon
          :closable="false"
          style="margin-top: 8px"
          title="以下菜品尚未确认送达，请先催供应商"
          :description="
            c.blockers
              .map((b) => `${b.supplierName}·${b.dishName}（${b.planQuantity} 份）`)
              .join('、')
          "
        />

        <el-row :gutter="12" style="margin-top: 12px">
          <el-col :span="6">
            <el-card shadow="never" class="kpi">
              <div class="kpi-v">{{ c.summary.batchQuantity }}</div>
              <div class="kpi-l">打包份数</div>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card shadow="never" class="kpi">
              <div class="kpi-v">{{ c.summary.routeCount }}</div>
              <div class="kpi-l">配送路线</div>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card shadow="never" class="kpi">
              <div class="kpi-v">{{ c.summary.stopCount }}</div>
              <div class="kpi-l">配送站点（楼栋）</div>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card shadow="never" class="kpi">
              <div class="kpi-v">{{ c.summary.confirmedDishCount }}/{{ c.summary.dishCount }}</div>
              <div class="kpi-l">到位菜品</div>
            </el-card>
          </el-col>
        </el-row>

        <h4 style="margin: 16px 0 8px">配送路线</h4>
        <el-table :data="c.routes" size="small" border>
          <el-table-column prop="routeNo" label="路线" width="80" />
          <el-table-column prop="groupName" label="楼群" min-width="140" />
          <el-table-column prop="quantity" label="份数" width="90" align="right" />
          <el-table-column label="站点（楼栋）" min-width="320">
            <template #default="{ row }">
              <el-tag
                v-for="s in row.stops"
                :key="s.buildingId"
                size="small"
                effect="plain"
                style="margin: 2px 4px 2px 0"
              >
                {{ s.buildingName }}
              </el-tag>
              <span v-if="!row.stops.length" class="sub">未配置楼栋</span>
            </template>
          </el-table-column>
        </el-table>

        <h4 style="margin: 16px 0 8px">菜品到位情况</h4>
        <el-table :data="c.dishes" size="small" border>
          <el-table-column prop="supplierName" label="供应商" min-width="120" />
          <el-table-column prop="dishName" label="菜品" min-width="120" />
          <el-table-column label="采购单价" width="110" align="right">
            <template #default="{ row }">{{ money(row.unitPriceFen) }}</template>
          </el-table-column>
          <el-table-column prop="planQuantity" label="应送份数" width="100" align="right" />
          <el-table-column label="实送份数" width="100" align="right">
            <template #default="{ row }">{{ row.actualQuantity ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'confirmed' ? 'success' : 'warning'">
                {{ row.status === 'confirmed' ? '已送达' : '在途' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="确认时间" width="170">
            <template #default="{ row }">{{ row.confirmedAt ?? '—' }}</template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-card v-if="visible && data?.notes" shadow="never" style="margin-top: 12px">
      <el-descriptions title="口径说明" :column="1" size="small" border>
        <el-descriptions-item v-for="(v, k) in data.notes" :key="k" :label="String(k)">
          {{ v }}
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<style scoped>
.portal-page {
  padding: 4px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.head h3 {
  margin: 0 0 4px;
}
.sub {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.ops {
  display: flex;
  align-items: center;
  gap: 8px;
}
.center-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.kpi {
  text-align: center;
}
.kpi-v {
  font-size: 24px;
  font-weight: 700;
}
.kpi-l {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
