<template>
  <div class="page-container">
    <h2 class="page-container__title">套餐模板库</h2>
    <p class="page-container__meta">
      模块：M31-04 · 原型 P29 · 接口：D6 模板库 / D7 存为模板 · 落库
      <code>ab_set_meal</code> + <code>ab_set_meal_item</code>
    </p>

    <el-form :inline="true" class="filters" @submit.prevent>
      <el-form-item label="套餐名">
        <el-input v-model="query.keyword" placeholder="模糊匹配" clearable style="width: 180px" />
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="query.status" placeholder="全部" clearable style="width: 120px">
          <el-option label="启用" :value="1" />
          <el-option label="停用" :value="0" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="reload(1)">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
      </el-form-item>
      <el-form-item class="filters__right">
        <el-button type="primary" plain @click="goCreate">新建套餐</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="detail">
            <p class="detail__title">菜品明细（一饭四菜）</p>
            <div class="detail__items">
              <div v-for="item in row.items" :key="`${item.slot}-${item.dishId}`" class="item">
                <el-tag size="small" effect="plain" class="item__slot">{{ item.slotLabel }}</el-tag>
                <span class="item__name">{{ item.name ?? `菜品 ${item.dishId}` }}</span>
                <span class="item__sup">供应商 #{{ item.supplierId ?? '—' }}</span>
              </div>
              <span v-if="!row.items.length" class="muted">该套餐没有菜品明细</span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="id" label="ID" width="72" />
      <el-table-column label="套餐名" min-width="160">
        <template #default="{ row }">
          <span class="name">{{ row.name ?? '—' }}</span>
          <div v-if="row.oneLiner" class="name__sub">{{ row.oneLiner }}</div>
        </template>
      </el-table-column>
      <el-table-column label="售价" width="100">
        <template #default="{ row }">{{ fenToCny(row.priceFen) }}</template>
      </el-table-column>
      <el-table-column label="成本（供价和）" width="120">
        <template #default="{ row }">{{ fenToCny(row.costPriceFen) }}</template>
      </el-table-column>
      <el-table-column label="菜品数" width="90">
        <template #default="{ row }">{{ row.dishCount }}</template>
      </el-table-column>
      <el-table-column label="在用分配" width="100">
        <template #default="{ row }">
          <el-tag v-if="row.usedCount" size="small" type="success" effect="plain">
            {{ row.usedCount }}
          </el-tag>
          <span v-else class="muted">0</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 1 ? 'success' : 'info'">
            {{ row.statusText }}
          </el-tag>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无套餐模板，点右上「新建套餐」开始" />
      </template>
    </el-table>

    <el-pagination
      class="pager"
      background
      layout="total, prev, pager, next, sizes"
      :total="total"
      :current-page="query.page"
      :page-size="query.pageSize"
      :page-sizes="[10, 20, 50, 100]"
      @current-change="reload"
      @size-change="onSizeChange"
    />

    <p class="hint">
      <strong>「在用分配」</strong>= 该模板被多少个<strong>未取消</strong>的套餐分配引用 ——
      模板库里最有用的一列：数字为 0 的模板可以直接停用清理；数字大的改动前请先想清楚影响面。
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 套餐模板库（D6）· 原型 P29
 *
 * ⚠️ 本页是**只读**列表：D6 契约只提供查询，`usedCount` 由服务端按「未取消的分配」
 *    聚合得出（不是前端数出来的）。套餐的**新建**走 D7（`/meal/edit` 页）——
 *    「一饭四菜」需要一边选菜一边看成本，塞进弹窗里体验会很差。
 */
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import { fetchMealTemplates } from '@/api/meal';
import type { SetMealTemplateRow } from '@/api/meal';
import { ApiError } from '@/api/request';
import { fenToCny } from '@/utils/format';

const router = useRouter();

const loading = ref(false);
const rows = ref<SetMealTemplateRow[]>([]);
const total = ref(0);

const query = reactive({
  keyword: '',
  status: undefined as number | undefined,
  page: 1,
  pageSize: 20,
});

async function reload(page?: number): Promise<void> {
  if (page) query.page = page;
  loading.value = true;
  try {
    const res = await fetchMealTemplates({
      keyword: query.keyword || undefined,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list;
    total.value = res.total;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '套餐模板加载失败');
  } finally {
    loading.value = false;
  }
}

function onSizeChange(size: number): void {
  query.pageSize = size;
  void reload(1);
}

function resetQuery(): void {
  query.keyword = '';
  query.status = undefined;
  void reload(1);
}

function goCreate(): void {
  void router.push('/meal/edit');
}

onMounted(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.filters {
  margin-bottom: $space-2;

  &__right {
    margin-left: auto;
  }
}

.pager {
  margin-top: $space-4;
  justify-content: flex-end;
}

.name {
  font-weight: 600;

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.muted {
  color: $c-text-weak;
}

.detail {
  padding: $space-3 $space-4;

  &__title {
    margin: 0 0 $space-2;
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__items {
    display: flex;
    flex-wrap: wrap;
    gap: $space-2 $space-4;
  }
}

.item {
  display: flex;
  align-items: center;
  gap: $space-1;

  &__slot {
    flex: none;
  }

  &__name {
    font-weight: 600;
  }

  &__sup {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.hint {
  margin: $space-3 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}
</style>
