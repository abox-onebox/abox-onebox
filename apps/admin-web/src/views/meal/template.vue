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
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row as SetMealTemplateRow)"
            >编辑</el-button
          >
          <el-button link type="primary" @click="toggleStatus(row as SetMealTemplateRow)">
            {{ row.status === 1 ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无套餐模板，点右上「新建套餐」开始" />
      </template>
    </el-table>

    <!-- ⭐ M5-15：D7b 编辑模板。此前模板库只增不改 —— 建错了只能"再建一条"，
         模板库只涨不消、`usedCount` 只增不减，运营面对一堆近乎同名的套餐无从选择。 -->
    <el-dialog
      v-model="dialogOpen"
      title="编辑套餐模板"
      width="620px"
      :close-on-click-modal="false"
    >
      <el-alert v-if="frozen" type="warning" :closable="false" show-icon class="dialog__alert">
        <template #title>
          该套餐已排进 <b>{{ editing?.usedCount }}</b> 个出餐计划，<b>菜品与售价已冻结</b>：
          改构成会让供应商按<strong>旧构成</strong>推出来的备料量与菜单对不上，
          改售价会让同一天同一份饭出现两个展示价。名称 / 介绍 / 上下架状态仍可改；
          要换菜请用「新建套餐」按这个模板另存一条再改。
        </template>
      </el-alert>

      <el-form label-width="88px">
        <el-form-item label="套餐名">
          <el-input v-model="editForm.name" maxlength="64" show-word-limit />
        </el-form-item>
        <el-form-item label="售价（元）">
          <el-input-number
            v-model="editForm.price"
            :min="0.01"
            :max="9999"
            :precision="2"
            :step="0.1"
            :disabled="frozen"
          />
        </el-form-item>
        <el-form-item label="一句话介绍">
          <el-input v-model="editForm.oneLiner" maxlength="128" placeholder="留空则不显示" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="editForm.status">
            <el-radio :label="1">启用</el-radio>
            <el-radio :label="0">停用</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="菜品构成">
          <div class="edit-slots">
            <div v-for="slot in editSlots" :key="slot.value" class="edit-slot">
              <span class="edit-slot__name">{{ slot.label }}</span>
              <el-select
                v-model="editPicked[slot.value]"
                :placeholder="`选择${slot.label}`"
                filterable
                clearable
                :disabled="frozen"
                style="flex: 1"
              >
                <el-option
                  v-for="d in dishOptions"
                  :key="d.id"
                  :label="`${d.name} · ${d.supplierName ?? '—'}`"
                  :value="d.id"
                  :disabled="isDishUsedInEdit(d.id, slot.value)"
                />
              </el-select>
            </div>
            <p class="edit-slots__note">
              主食米饭由集散中心统一供米（¥2/份）· 不建菜品项，故不在此列。
            </p>
          </div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>

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
      模板库里最有用的一列。⭐ 它同时决定**能改什么**：为 0 时可改名称 / 售价 / 菜品构成； 大于 0
      时该套餐已进入某天的出餐计划，**菜品与售价冻结**（服务端拒以 `30019`）， 只能改名称 / 介绍 /
      上下架状态，要换菜请用「新建套餐」另存一条再改。
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 套餐模板库（D6 + **D7b 编辑**）· 原型 P29
 *
 * ⚠️ D6 只提供查询，`usedCount` 由服务端按「**未取消的分配**」聚合得出（不是前端数出来的）。
 *    套餐的**新建**走 D7（`/meal/edit` 页）——「一饭四菜」需要一边选菜一边看成本，
 *    塞进弹窗里体验会很差。
 *
 * ⭐ M5-15 新增 D7b 编辑：此前本页**只读**，模板**只增不改** ——
 *    建错的模板（菜选错、名字打错、想下架）无法修正，唯一出路是再建一条新的，
 *    于是模板库只涨不消、`usedCount` 只增不减，运营面对一堆近乎同名的套餐无从选择。
 *
 * ⚠️ 编辑的两级可变性由**服务端**裁定（`30019`），前端按 `usedCount` 预先禁用
 *    构成与售价两个入口 —— 前端禁用只是体验，真正的闸门在 `updateTemplate`。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';

import { fetchDishOptions, fetchMealTemplates, updateMealTemplate } from '@/api/meal';
import type { DishOption, SetMealTemplateRow, UpdateTemplatePayload } from '@/api/meal';
import { ApiError } from '@/api/request';
import { SET_MEAL_COMPOSITION, SET_MEAL_SLOT_LABEL } from '@abox/shared-utils';
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

// ---------------------------------------------------------------- D7b 编辑

const dialogOpen = ref(false);
const saving = ref(false);
const editing = ref<SetMealTemplateRow | null>(null);
const dishOptions = ref<DishOption[]>([]);

const editForm = reactive({
  name: '',
  price: 0,
  oneLiner: '',
  status: 1,
});

/** 可编辑的菜位（= 「一饭四菜」的四个档位，主食档不入列） */
const editSlots = [1, 2, 3, 4].map((v) => ({
  value: v,
  label: SET_MEAL_SLOT_LABEL[v] ?? String(v),
}));
const editPicked = reactive<Record<number, number | undefined>>({});

/** 已排期 ⇒ 构成与售价冻结（与服务端 `MEAL_TEMPLATE_IN_USE` 同一判据） */
const frozen = computed(() => (editing.value?.usedCount ?? 0) > 0);

function isDishUsedInEdit(dishId: number, exceptSlot: number): boolean {
  return editSlots.some((s) => s.value !== exceptSlot && editPicked[s.value] === dishId);
}

async function openEdit(row: SetMealTemplateRow): Promise<void> {
  editing.value = row;
  editForm.name = row.name ?? '';
  editForm.price = Number((row.priceFen / 100).toFixed(2));
  editForm.oneLiner = row.oneLiner ?? '';
  editForm.status = row.status;
  for (const s of editSlots) editPicked[s.value] = undefined;
  for (const item of row.items) {
    if (editSlots.some((s) => s.value === item.slot)) editPicked[item.slot] = item.dishId;
  }
  dialogOpen.value = true;

  if (!dishOptions.value.length) {
    try {
      const opt = await fetchDishOptions({});
      dishOptions.value = opt.list;
    } catch (e) {
      ElMessage.error(e instanceof ApiError ? e.message : '菜品库加载失败');
    }
  }
}

async function saveEdit(): Promise<void> {
  const row = editing.value;
  if (!row) return;
  if (!editForm.name.trim()) {
    ElMessage.warning('请填写套餐名');
    return;
  }

  const payload: UpdateTemplatePayload = {
    name: editForm.name.trim(),
    // 空串 → null = 清空（服务端语义：不传=不改 / 传 null=清空）
    oneLiner: editForm.oneLiner.trim() || null,
    status: editForm.status,
  };

  if (!frozen.value) {
    const empty = editSlots.filter((s) => editPicked[s.value] === undefined);
    if (empty.length) {
      ElMessage.warning(
        `还差 ${empty.map((s) => s.label).join(' / ')} —— ${SET_MEAL_COMPOSITION.rule}`,
      );
      return;
    }
    payload.price = editForm.price;
    payload.items = editSlots.map((s) => ({ slot: s.value, dishId: editPicked[s.value]! }));
  }

  saving.value = true;
  try {
    await updateMealTemplate(row.id, payload);
    ElMessage.success(`套餐 #${row.id} 已更新`);
    dialogOpen.value = false;
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

/** 上下架：不受「已排期」闸门限制 —— 下架只是从编排页选择器里消失 */
async function toggleStatus(row: SetMealTemplateRow): Promise<void> {
  const next = row.status === 1 ? 0 : 1;
  const verb = next === 1 ? '启用' : '停用';
  try {
    await ElMessageBox.confirm(
      next === 0 && row.usedCount > 0
        ? `该套餐已被 ${row.usedCount} 个出餐计划引用：停用只影响「新建分配时的候选列表」，已排期的照常出餐。确认${verb}？`
        : `确认${verb}「${row.name ?? `#${row.id}`}」？`,
      `${verb}套餐`,
      { type: 'warning', confirmButtonText: `确认${verb}`, cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await updateMealTemplate(row.id, { status: next });
    ElMessage.success(`已${verb}`);
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : `${verb}失败`);
  }
}

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

// ---------------------------------------------------------------- 编辑弹窗（D7b）

.dialog__alert {
  margin-bottom: $space-3;

  :deep(.el-alert__title) {
    line-height: 1.7;
  }
}

.edit-slots {
  width: 100%;

  &__note {
    margin: $space-1 0 0;
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.7;
  }
}

.edit-slot {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-1;

  &__name {
    width: 48px;
    flex: none;
    font-weight: 600;
  }
}
</style>
