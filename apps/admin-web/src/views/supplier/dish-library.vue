<template>
  <div class="page-container">
    <h2 class="page-container__title">菜品库（主荤 / 半荤 / 素菜 / 汤品 / 主食）</h2>
    <p class="page-container__meta">
      原型 P33 · 模块 M34 · 接口：<b>扩展</b>（不占 D 号，D33 已被财务占用）·
      <code>GET/POST /admin/dishes</code> · <code>PUT /admin/dishes/:id</code> ·
      <code>POST /admin/dishes/batch-status</code> · 数据源 <code>ab_dish</code> · 路径
      <code>/supplier/dish-library</code>
    </p>

    <!--
      ⚠️ 路径隔离：本页是**平台端**（运营看全部供应商的菜品与供价），落在
        `/supplier/dish-library`。
        不要挪回 `/supplier/dishes` —— 那是《目录结构 v2.0》§10.2 分配给**商家端**
        P23「我的菜品」（M22-01）的路径（`views/supplier/dishes.vue`），
        且在 `admin-role.ts` 的 `SUPPLIER_MENU_KEYS` 里注册给 role=supplier。
        两角色共用同一 admin-web，路径一撞就会出现「商家点进平台页、调 /admin/* 接口拿 10003」。
        商家端「我的菜品」将来走 `/supplier/dishes` + `/supplier/*` 接口（主体是商家自己）。
    -->

    <!-- 供价是本批次最容易被误读的一个数：它是成本，不是售价 -->
    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>「供价」是逐菜协商的采购成本，不是售价</b> —— 售价 ￥25.80 全平台锁定； 结算按 C9
        逐项相加（供价 + 场地费 + 打包人工 + 配送费 + 团长佣金 → 毛利为结果值）。
        改这里的价格会直接改变毛利，但<b>不改变用户看到的价格</b>。
      </template>
    </el-alert>

    <el-alert v-if="notes.category" type="warning" :closable="false" class="note">
      <template #title> <b>档位口径提醒</b>：{{ notes.category }} </template>
    </el-alert>

    <!-- ─────────────── KPI（同一过滤条件的全量，翻页不跳） ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">菜品总数</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">上架中</span>
        <span class="stats__value stats__value--ok">{{ summary.onSaleCount }}</span>
        <span class="stats__sub">可在套餐编排中选用</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已下架</span>
        <span class="stats__value">{{ summary.offSaleCount }}</span>
        <span class="stats__sub">含证照过期被联动下架</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">均价（供价）</span>
        <span class="stats__value stats__value--warn">{{ fenToCny(summary.avgPriceFen) }}</span>
        <span class="stats__sub">按可售菜品口径</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">累计销量</span>
        <span class="stats__value">{{ summary.totalSaleCount }}</span>
        <span class="stats__sub">份</span>
      </div>
    </div>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-select
        v-model="query.supplierId"
        placeholder="供应商"
        clearable
        filterable
        style="width: 180px"
        @change="reload(1)"
      >
        <el-option
          v-for="o in page.supplierOptions"
          :key="String(o.value)"
          :label="o.label"
          :value="Number(o.value)"
        />
      </el-select>

      <el-select
        v-model="query.category"
        placeholder="档位"
        clearable
        style="width: 120px"
        @change="reload(1)"
      >
        <el-option
          v-for="o in page.categoryOptions"
          :key="String(o.value)"
          :label="o.label"
          :value="String(o.value)"
        />
      </el-select>

      <el-select
        v-model="query.status"
        placeholder="状态"
        clearable
        style="width: 110px"
        @change="reload(1)"
      >
        <el-option label="上架中" :value="1" />
        <el-option label="已下架" :value="0" />
      </el-select>

      <el-input
        v-model="query.keyword"
        placeholder="菜品名 / 描述"
        clearable
        style="width: 200px"
        @keyup.enter="reload(1)"
        @clear="reload(1)"
      />

      <div class="toolbar__right">
        <el-button v-if="selectedIds.length" :disabled="!canManage" @click="openBatch(1)">
          批量上架（{{ selectedIds.length }}）
        </el-button>
        <el-button
          v-if="selectedIds.length"
          type="warning"
          plain
          :disabled="!canManage"
          @click="openBatch(0)"
        >
          批量下架（{{ selectedIds.length }}）
        </el-button>
        <el-button :loading="loading" @click="reload(1)">查询</el-button>
        <el-tooltip
          :disabled="canManage"
          content="仅管理员 / 超级管理员可维护菜品（供价决定毛利）"
          placement="top"
        >
          <span>
            <el-button type="primary" :disabled="!canManage" @click="openCreate"
              >新增菜品</el-button
            >
          </span>
        </el-tooltip>
      </div>
    </div>

    <!-- ─────────────── 菜品表 ─────────────── -->
    <el-table
      v-loading="loading"
      :data="rows"
      class="table"
      stripe
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="44" :selectable="isSelectable" />

      <el-table-column label="菜品" min-width="190">
        <template #default="{ row }">
          <div class="stack">
            <span class="strong">{{ asRow(row).name }}</span>
            <span class="sub">{{ asRow(row).description || '无描述' }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="档位" width="96">
        <template #default="{ row }">
          <el-tag size="small" type="info" effect="plain">{{ asRow(row).categoryLabel }}</el-tag>
        </template>
      </el-table-column>

      <el-table-column label="供应商" min-width="150">
        <template #default="{ row }">
          <span>{{ displayOr(asRow(row).supplierName) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="供价" width="110" align="right">
        <template #default="{ row }">
          <span class="strong">{{ fenToCny(asRow(row).costPriceFen) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="销量 / 评分" width="130">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ asRow(row).saleCount }} 份</span>
            <span class="sub">评分 {{ asRow(row).rating }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="asRow(row).status === 1 ? 'success' : 'info'">
            {{ asRow(row).statusLabel }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="!canManage" @click="openEdit(asRow(row))">
            编辑
          </el-button>
          <el-button
            link
            :type="asRow(row).status === 1 ? 'warning' : 'success'"
            :disabled="!canManage"
            @click="toggleStatus(asRow(row))"
          >
            {{ asRow(row).status === 1 ? '下架' : '上架' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      class="pager"
      layout="total, sizes, prev, pager, next"
      :total="total"
      :page-sizes="[20, 50, 100]"
      @current-change="load"
      @size-change="reload(1)"
    />

    <!-- ─────────────── 新增 / 编辑弹窗 ─────────────── -->
    <el-dialog
      v-model="editVisible"
      :title="editForm.id ? '编辑菜品' : '新增菜品'"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="editForm" label-width="100px">
        <el-form-item label="供应商" required>
          <el-select
            v-model="editForm.supplierId"
            placeholder="选择供应商"
            filterable
            :disabled="!!editForm.id"
            style="width: 100%"
          >
            <el-option
              v-for="o in page.supplierOptions"
              :key="String(o.value)"
              :label="o.label"
              :value="Number(o.value)"
            />
          </el-select>
          <p v-if="editForm.id" class="field-hint">
            菜品归属不可改 —— 换供应商等于换一个成本主体，历史结算会指向错的人。
          </p>
        </el-form-item>

        <el-form-item label="菜品名" required>
          <el-input
            v-model="editForm.name"
            maxlength="64"
            show-word-limit
            placeholder="如：红烧肉"
          />
        </el-form-item>

        <el-form-item label="档位" required>
          <el-select v-model="editForm.category" placeholder="选择档位" style="width: 100%">
            <el-option
              v-for="o in page.categoryOptions"
              :key="String(o.value)"
              :label="o.label"
              :value="String(o.value)"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="供价（元）" required>
          <el-input v-model="editForm.costPriceYuan" placeholder="如：7.50" style="width: 160px">
            <template #append>元</template>
          </el-input>
          <span class="unit-tip">= {{ fenToCny(costPriceFenPreview) }}</span>
          <p class="field-hint">C9 逐菜协商价。此价计入结算成本项，直接决定平台毛利。</p>
        </el-form-item>

        <el-form-item label="描述">
          <el-input
            v-model="editForm.description"
            type="textarea"
            :rows="2"
            maxlength="200"
            show-word-limit
          />
        </el-form-item>

        <el-form-item label="图片地址">
          <el-input v-model="editForm.imageUrl" placeholder="https://…" />
        </el-form-item>

        <el-form-item label="状态">
          <el-radio-group v-model="editForm.status">
            <el-radio :value="1">上架中</el-radio>
            <el-radio :value="0">已下架</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- ─────────────── 批量上下架弹窗 ─────────────── -->
    <el-dialog
      v-model="batchVisible"
      :title="batchForm.status === 1 ? '批量上架' : '批量下架'"
      width="460px"
      :close-on-click-modal="false"
    >
      <div class="dialog-body">
        <p class="dialog-line">
          将对选中的 <b>{{ selectedIds.length }}</b> 个菜品执行
          <b>{{ batchForm.status === 1 ? '上架' : '下架' }}</b
          >。
        </p>
        <p class="dialog-hint">
          结果里会分别回带 <code>changed</code> 与 <code>skipped</code> ——
          <b>skipped 不是失败</b>：目标态与现状相同（已上架的再上架）会被跳过， 这是幂等，不是报错。
        </p>
        <el-input
          v-model="batchForm.reason"
          :placeholder="batchForm.status === 1 ? '变更原因（选填）' : '下架原因（必填，便于回溯）'"
          type="textarea"
          :rows="2"
          maxlength="128"
        />
      </div>

      <template #footer>
        <el-button @click="batchVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitBatch">确认执行</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  batchDishStatus,
  createDish,
  fetchAdminDishes,
  updateDish,
  type DishRow,
  type Option,
} from '@/api/supplier';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny, yuanToFen } from '@/utils/format';

const route = useRoute();

const loading = ref(false);
const submitting = ref(false);
const rows = ref<DishRow[]>([]);
const total = ref(0);
const selectedIds = ref<number[]>([]);

const summary = reactive({
  totalCount: 0,
  onSaleCount: 0,
  offSaleCount: 0,
  avgPriceFen: 0,
  totalSaleCount: 0,
});

const page = reactive<{
  categoryOptions: Option[];
  supplierOptions: Option[];
  actions: { canManage: boolean };
}>({
  categoryOptions: [],
  supplierOptions: [],
  actions: { canManage: false },
});

const notes = reactive<Record<string, string>>({});

const canManage = computed(() => page.actions.canManage);

/** 入口来自「供应商名录 → 菜品库」时带 supplierId，直接落到筛选上 */
const query = reactive({
  supplierId: route.query.supplierId ? Number(route.query.supplierId) : undefined,
  category: undefined as string | undefined,
  status: undefined as number | undefined,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const editVisible = ref(false);
const editForm = reactive({
  id: 0,
  supplierId: undefined as number | undefined,
  name: '',
  category: '',
  costPriceYuan: '',
  description: '',
  imageUrl: '',
  status: 1,
});

const costPriceFenPreview = computed(() => yuanToFen(editForm.costPriceYuan));

const batchVisible = ref(false);
const batchForm = reactive({ status: 0, reason: '' });

/** el-table 插槽的 row 是宽松 DefaultRow，入口断言一次，避免 `as` 扩散到模板 */
function asRow(raw: unknown): DishRow {
  return raw as DishRow;
}

/** 归属供应商的菜品才可批量操作 —— 未挂供应商的行没有成本主体，改动无意义 */
function isSelectable(raw: unknown): boolean {
  return Number(asRow(raw).supplierId) > 0;
}

function onSelectionChange(sel: unknown[]): void {
  selectedIds.value = sel.map((r) => Number(asRow(r).id));
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchAdminDishes({
      supplierId: query.supplierId,
      category: query.category,
      status: query.status,
      keyword: query.keyword || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list;
    total.value = res.total;
    Object.assign(summary, res.summary);
    page.categoryOptions = res.categoryOptions;
    page.supplierOptions = res.supplierOptions;
    page.actions = res.actions;
    Object.keys(notes).forEach((k) => delete notes[k]);
    Object.assign(notes, res.notes ?? {});
    selectedIds.value = [];
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '加载菜品库失败');
  } finally {
    loading.value = false;
  }
}

function reload(pageNo = 1): void {
  query.page = pageNo;
  void load();
}

function openCreate(): void {
  editForm.id = 0;
  editForm.supplierId = query.supplierId;
  editForm.name = '';
  editForm.category = page.categoryOptions[0] ? String(page.categoryOptions[0].value) : 'main';
  editForm.costPriceYuan = '';
  editForm.description = '';
  editForm.imageUrl = '';
  editForm.status = 1;
  editVisible.value = true;
}

function openEdit(row: DishRow): void {
  editForm.id = row.id;
  editForm.supplierId = row.supplierId;
  editForm.name = row.name;
  editForm.category = row.category ?? 'main';
  // 元串由服务端给（避免端上 `/100` 再 `toFixed` 丢精度）
  editForm.costPriceYuan = row.costPriceYuan;
  editForm.description = row.description ?? '';
  editForm.imageUrl = row.imageUrl ?? '';
  editForm.status = row.status;
  editVisible.value = true;
}

async function submitEdit(): Promise<void> {
  if (!editForm.supplierId) {
    ElMessage.warning('请先选择供应商');
    return;
  }
  if (!editForm.name.trim()) {
    ElMessage.warning('请填写菜品名');
    return;
  }
  if (!editForm.category) {
    ElMessage.warning('请选择档位');
    return;
  }
  const fen = yuanToFen(editForm.costPriceYuan);
  if (!editForm.costPriceYuan || fen <= 0) {
    ElMessage.warning('供价必须大于 0');
    return;
  }

  submitting.value = true;
  try {
    if (editForm.id) {
      await updateDish(editForm.id, {
        name: editForm.name.trim(),
        category: editForm.category,
        costPriceFen: fen,
        description: editForm.description || undefined,
        imageUrl: editForm.imageUrl || undefined,
        status: editForm.status,
      });
      ElMessage.success('菜品已更新');
    } else {
      await createDish({
        supplierId: editForm.supplierId,
        name: editForm.name.trim(),
        category: editForm.category,
        costPriceFen: fen,
        description: editForm.description || undefined,
        imageUrl: editForm.imageUrl || undefined,
        status: editForm.status,
      });
      ElMessage.success('菜品已创建');
    }
    editVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    submitting.value = false;
  }
}

function openBatch(status: number): void {
  batchForm.status = status;
  batchForm.reason = '';
  batchVisible.value = true;
}

async function submitBatch(): Promise<void> {
  if (batchForm.status === 0 && batchForm.reason.trim().length < 2) {
    ElMessage.warning('批量下架必须填写原因（≥2 字）');
    return;
  }
  submitting.value = true;
  try {
    const res = await batchDishStatus({
      ids: selectedIds.value,
      status: batchForm.status,
      reason: batchForm.reason || undefined,
    });
    ElMessage.success(
      `已处理 ${res.changed} 个，跳过 ${res.skipped} 个（跳过＝目标态已一致，非失败）`,
    );
    batchVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '批量操作失败');
  } finally {
    submitting.value = false;
  }
}

async function toggleStatus(row: DishRow): Promise<void> {
  const toOff = row.status === 1;
  try {
    await updateDish(row.id, { status: toOff ? 0 : 1 });
    ElMessage.success(toOff ? '已下架' : '已上架');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '操作失败');
  }
}

onMounted(() => {
  void load();
});
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;

  code {
    padding: 1px 4px;
    background: rgba(0, 0, 0, 0.05);
    border-radius: 3px;
  }
}

.note {
  margin-bottom: $space-3;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: $space-3;
  margin-bottom: $space-3;
}

.stats__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 150px;
  padding: $space-2 $space-3;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
}

.stats__label {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.stats__value {
  font-size: 20px;
  font-weight: 700;
}

.stats__value--ok {
  color: #5b7c3a;
}

.stats__value--warn {
  color: #c9a876;
}

.stats__sub {
  color: $c-text-weak;
  font-size: 11px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-3;
}

.toolbar__right {
  margin-left: auto;
  display: flex;
  gap: $space-2;
}

.table {
  width: 100%;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.strong {
  font-weight: 600;
}

.sub {
  color: $c-text-weak;
  font-size: 11px;
}

.pager {
  margin-top: $space-3;
  justify-content: flex-end;
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: $space-2;
}

.dialog-line {
  margin: 0;
}

.dialog-hint,
.field-hint {
  margin: 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}

.field-hint {
  margin-top: 4px;
}

.unit-tip {
  margin-left: $space-2;
  color: $c-text-weak;
  font-size: $fs-caption;
}
</style>
