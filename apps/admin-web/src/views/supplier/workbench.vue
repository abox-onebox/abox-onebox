<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import { fetchWorkbench, type PortalDish, type WorkbenchData } from '@/api/supplier-portal';

/**
 * P21 商家工作台（M21-01 · 《接口规范》S1）
 *
 * 出餐计划 + 按集散中心拆分的配送清单。
 * ⚠️ 截止时间（出餐日当天 09:30）是 **deadline 不是 earliest** ——
 *    提前备好就能提前确认，所以「出餐确认」按钮不是只在当天才出现。
 */
const router = useRouter();
const loading = ref(false);
const date = ref('');
const data = ref<WorkbenchData | null>(null);

const dishes = computed<PortalDish[]>(() => data.value?.dishes ?? []);
const isEmpty = computed(() => data.value?.summary?.empty === true);
const deadline = computed(() => data.value?.deadline);

const STATUS_TEXT: Record<string, string> = {
  pending: '未出餐',
  cooking: '部分送达',
  done: '已全部送达',
};
const statusText = (s: string) => STATUS_TEXT[s] ?? s;
const statusType = (s: string) => (s === 'done' ? 'success' : s === 'cooking' ? 'warning' : 'info');
const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

async function load() {
  loading.value = true;
  try {
    data.value = await fetchWorkbench(date.value || undefined);
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function goConfirm() {
  router.push({ path: '/supplier/cook-confirm', query: date.value ? { date: date.value } : {} });
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="portal-page">
    <el-card shadow="never">
      <div class="head">
        <div>
          <h3>商家工作台</h3>
          <p class="sub">
            {{ data?.supplier?.name ?? '—' }} · {{ data?.supplier?.typeLabel ?? '—' }} ·
            {{ data?.supplier?.statusLabel ?? '—' }}
          </p>
        </div>
        <div class="ops">
          <el-date-picker
            v-model="date"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="出餐日（默认最近一个有计划的）"
            clearable
            @change="load"
          />
          <el-button @click="load">刷新</el-button>
          <el-button type="primary" :disabled="isEmpty" @click="goConfirm">出餐确认</el-button>
        </div>
      </div>
    </el-card>

    <!-- 资质闸门：先提示，别让供应商点了按钮才发现被拦 -->
    <el-alert
      v-if="data && !data.supplier.canServe"
      type="error"
      show-icon
      :closable="false"
      title="当前不能出餐"
      description="资质未通过审核或证照已过期。请联系运营补充资质并重新核验后再确认出餐。"
      style="margin-top: 12px"
    />

    <el-alert
      v-if="deadline"
      :type="deadline.overdue ? 'warning' : 'info'"
      show-icon
      :closable="false"
      style="margin-top: 12px"
      :title="
        deadline.overdue
          ? `已过出餐确认截止时间（${deadline.text}）`
          : `出餐确认截止 ${deadline.text}`
      "
      :description="
        deadline.overdue
          ? '系统不再受理补确认（时间戳必须诚实，对账与追责都以它为准）；请联系运营线下处理。'
          : '截止前完成确认，集散中心才能按路线开始打包。提前备好即可提前确认。'
      "
    />

    <el-row v-if="data && !isEmpty" :gutter="12" style="margin-top: 12px">
      <el-col :span="6">
        <el-card shadow="never" class="kpi">
          <div class="kpi-v">{{ data.summary.planQuantity }}</div>
          <div class="kpi-l">应出餐份数</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="kpi">
          <div class="kpi-v ok">{{ data.summary.confirmedQuantity }}</div>
          <div class="kpi-l">已确认送达</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="kpi">
          <div class="kpi-v warn">{{ data.summary.pendingQuantity }}</div>
          <div class="kpi-l">待确认</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="kpi">
          <div class="kpi-v">{{ data.summary.centerCount }}</div>
          <div class="kpi-l">涉及集散中心</div>
        </el-card>
      </el-col>
    </el-row>

    <el-empty
      v-if="!loading && isEmpty"
      description="当日没有派到生产计划（未开团或截单后尚未生成）"
    />

    <el-card v-for="d in dishes" :key="d.dishId" shadow="never" style="margin-top: 12px">
      <div class="dish-head">
        <div class="dish-title">
          <strong>{{ d.dishName }}</strong>
          <el-tag size="small" type="info" effect="plain" style="margin-left: 8px">
            {{ d.category ?? '—' }}
          </el-tag>
          <el-tag size="small" :type="statusType(d.status)" style="margin-left: 8px">
            {{ statusText(d.status) }}
          </el-tag>
        </div>
        <div class="dish-meta">
          分账单价 {{ money(d.unitPriceFen) }} · 应出 <strong>{{ d.planQuantity }}</strong> 份 ·
          已确认 <strong>{{ d.confirmedQuantity }}</strong> 份
        </div>
      </div>

      <el-table :data="d.centers" size="small" border style="margin-top: 8px">
        <el-table-column prop="centerName" label="集散中心" min-width="180" />
        <el-table-column prop="centerAddress" label="地址" min-width="180" />
        <el-table-column prop="planQuantity" label="应送份数" width="100" align="right" />
        <el-table-column label="实送份数" width="100" align="right">
          <template #default="{ row }">{{ row.actualQuantity ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'confirmed' ? 'success' : 'info'">
              {{ row.status === 'confirmed' ? '已送达' : '待送达' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="确认时间" width="170">
          <template #default="{ row }">{{ row.confirmedAt ?? '—' }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="data" shadow="never" style="margin-top: 12px">
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
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.ops {
  display: flex;
  align-items: center;
  gap: 8px;
}
.kpi {
  text-align: center;
}
.kpi-v {
  font-size: 26px;
  font-weight: 700;
}
.kpi-v.ok {
  color: var(--el-color-success);
}
.kpi-v.warn {
  color: var(--el-color-warning);
}
.kpi-l {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.dish-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dish-meta {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
