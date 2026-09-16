<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  cookConfirm,
  fetchWorkbench,
  type CookConfirmItem,
  type WorkbenchData,
} from '@/api/supplier-portal';

/**
 * P22 出餐确认（M21-02 · 《接口规范》S2）
 *
 * 交互粒度 = **(菜, 集散中心)** —— 与原型 P22 逐卡勾选一致：
 * 一道菜要分别送到 N 个集散中心，每个中心各自确认。
 *
 * ⚠️ 09:30 是 **deadline 而非 earliest**：提前备好即可提前确认；
 *    过期后服务端 50009 拒绝，端上要先按 `deadline.overdue` 提示，别让用户白发一次请求。
 */
const route = useRoute();
const router = useRouter();

const loading = ref(false);
const submitting = ref(false);
const data = ref<WorkbenchData | null>(null);
const date = ref(String(route.query.date ?? ''));

/** 勾选状态：`dishId:centerId` → true */
const checked = ref<Record<string, boolean>>({});
/** 实送份数：`dishId:centerId` → number（不填 = 足额） */
const actual = ref<Record<string, number | undefined>>({});
/** 备注 */
const remark = ref<Record<string, string>>({});

interface ConfirmRow {
  key: string;
  dishId: number;
  dishName: string;
  distributionCenterId: number;
  centerName: string;
  planQuantity: number;
  status: string;
  confirmedAt: string | null;
}

const rows = computed<ConfirmRow[]>(() => {
  const out: ConfirmRow[] = [];
  for (const d of data.value?.dishes ?? []) {
    for (const c of d.centers) {
      out.push({
        key: `${d.dishId}:${c.distributionCenterId}`,
        dishId: d.dishId,
        dishName: d.dishName,
        distributionCenterId: c.distributionCenterId,
        centerName: c.centerName,
        planQuantity: c.planQuantity,
        status: c.status,
        confirmedAt: c.confirmedAt,
      });
    }
  }
  return out;
});

const pendingRows = computed(() => rows.value.filter((r) => r.status !== 'confirmed'));
const chosen = computed(() => pendingRows.value.filter((r) => checked.value[r.key]));
const overdue = computed(() => data.value?.deadline?.overdue === true);
const canServe = computed(() => data.value?.supplier?.canServe === true);
const blocked = computed(() => overdue.value || !canServe.value);

async function load() {
  loading.value = true;
  try {
    data.value = await fetchWorkbench(date.value || undefined);
    date.value = data.value.date;
    // 默认全选未确认项（最常见的动作是「都送到了」）
    const next: Record<string, boolean> = {};
    for (const r of rows.value) if (r.status !== 'confirmed') next[r.key] = true;
    checked.value = next;
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function toggleAll(v: boolean) {
  const next: Record<string, boolean> = {};
  for (const r of pendingRows.value) next[r.key] = v;
  checked.value = next;
}

async function submit() {
  if (!chosen.value.length) {
    ElMessage.warning('请先勾选要确认的项');
    return;
  }
  const short = chosen.value.filter(
    (r) => actual.value[r.key] !== undefined && Number(actual.value[r.key]) !== r.planQuantity,
  );
  if (short.length) {
    await ElMessageBox.confirm(
      `有 ${short.length} 项实送份数与应送份数不一致，差异会被记录用于对账。确认继续？`,
      '份数差异提示',
      { type: 'warning' },
    );
  }

  const items: CookConfirmItem[] = chosen.value.map((r) => {
    const q = actual.value[r.key];
    const item: CookConfirmItem = {
      dishId: r.dishId,
      distributionCenterId: r.distributionCenterId,
    };
    if (q !== undefined && q !== null && String(q) !== '') item.actualQuantity = Number(q);
    if (remark.value[r.key]) item.remark = remark.value[r.key];
    return item;
  });

  submitting.value = true;
  try {
    const res = await cookConfirm({ date: date.value, items });
    if (res.summary.skipped > 0) {
      ElMessage.info(
        `已提交：新增确认 ${res.summary.confirmed} 项，跳过 ${res.summary.skipped} 项（此前已确认）`,
      );
    } else {
      ElMessage.success(`出餐确认成功：${res.summary.confirmed} 项`);
    }
    if (res.summary.allDone) {
      ElMessage.success('本日出餐任务已全部确认完成，集散中心可以开始打包。');
    }
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '提交失败');
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="portal-page">
    <el-card shadow="never">
      <div class="head">
        <div>
          <h3>出餐确认</h3>
          <p class="sub">
            {{ data?.supplier?.name ?? '—' }} · 出餐日 {{ date || '—' }} · 截止
            {{ data?.deadline?.text ?? '—' }}
          </p>
        </div>
        <div class="ops">
          <el-button @click="router.back()">返回工作台</el-button>
          <el-button @click="load">刷新</el-button>
        </div>
      </div>
    </el-card>

    <el-alert
      v-if="blocked"
      type="error"
      show-icon
      :closable="false"
      style="margin-top: 12px"
      :title="overdue ? '已过出餐确认截止时间' : '当前不能出餐（资质或证照问题）'"
      :description="
        overdue
          ? '系统不再受理补确认。请联系运营线下处理 —— 时间戳必须诚实，对账与追责都以它为准。'
          : '请先补齐资质并经运营核验通过。'
      "
    />

    <el-card shadow="never" style="margin-top: 12px">
      <div class="bar">
        <el-checkbox
          :model-value="pendingRows.length > 0 && chosen.length === pendingRows.length"
          :indeterminate="chosen.length > 0 && chosen.length < pendingRows.length"
          :disabled="blocked"
          @change="toggleAll($event as boolean)"
        >
          全选待确认（{{ pendingRows.length }}）
        </el-checkbox>
        <div class="bar-right">
          <span class="hint">实送份数留空 = 足额送达；短送请填实际值并备注原因</span>
          <el-button
            type="primary"
            :loading="submitting"
            :disabled="blocked || !chosen.length"
            @click="submit"
          >
            提交确认（{{ chosen.length }}）
          </el-button>
        </div>
      </div>

      <el-table :data="rows" size="small" border style="margin-top: 8px">
        <el-table-column width="60">
          <template #default="{ row }">
            <el-checkbox
              v-model="checked[row.key]"
              :disabled="blocked || row.status === 'confirmed'"
            />
          </template>
        </el-table-column>
        <el-table-column prop="dishName" label="菜品" min-width="120" />
        <el-table-column prop="centerName" label="集散中心" min-width="180" />
        <el-table-column prop="planQuantity" label="应送份数" width="100" align="right" />
        <el-table-column label="实送份数" width="130">
          <template #default="{ row }">
            <el-input-number
              v-model="actual[row.key]"
              :min="0"
              :max="99999"
              size="small"
              controls-position="right"
              placeholder="足额"
              :disabled="blocked || row.status === 'confirmed'"
            />
          </template>
        </el-table-column>
        <el-table-column label="备注" width="180">
          <template #default="{ row }">
            <el-input
              v-model="remark[row.key]"
              size="small"
              placeholder="如：短送原因"
              :disabled="blocked || row.status === 'confirmed'"
            />
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'confirmed' ? 'success' : 'info'">
              {{ row.status === 'confirmed' ? '已确认' : '待确认' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="确认时间" width="170">
          <template #default="{ row }">{{ row.confirmedAt ?? '—' }}</template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && !rows.length" description="当日没有需要确认的出餐明细" />
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
  gap: 8px;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.bar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
