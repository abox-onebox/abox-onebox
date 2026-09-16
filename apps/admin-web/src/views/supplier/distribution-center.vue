<template>
  <div class="page-container">
    <h2 class="page-container__title">集散中心配置（C4 · ABox 自有持证场所）</h2>
    <p class="page-container__meta">
      原型 P33 · 模块 M34-05 · 接口：D29 名录 / D30 新增 / D31 编辑 / D32 停用软删 · 路径
      <code>/admin/distribution-centers</code> · 数据源 <code>ab_distribution_center</code>
    </p>

    <!-- ⭐ 自营口径（M4-0）：本表语义 + 「默认 0 = 未登记」的诚实标注 -->
    <el-alert type="warning" :closable="false" class="note">
      <template #title>
        <b>集散中心 = ABox 自有加工 / 出餐场所</b>（半成品在此热加工后打包配送），
        <b>不归属任何合作供应商</b> —— 自营前的「所属供应商」字段已停用，新增 / 编辑不再收取。
      </template>
      <div class="note__body">
        <b>场地费与打包人工默认 ￥0.00 的含义是「未登记」，不是「免费」。</b>
        它们是 ABox 自身履约成本（不出付款单），未登记时毛利会被<b>系统性高估</b>；
        请按实际发生额登记。场地必须是 ABox <b>自有持证场所</b>：证照地址 = 线上店铺地址 =
        实际出餐地址，三者不一致会直接踩红线。
      </div>
    </el-alert>

    <!-- ─────────────── KPI（同一过滤条件的全量，翻页不跳） ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">集散中心总数</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">启用中</span>
        <span class="stats__value stats__value--ok">{{ summary.activeCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已停用</span>
        <span class="stats__value">{{ summary.suspendedCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">场地费合计 / 份</span>
        <span class="stats__value">{{ fenToCny(summary.totalRiceFeeFen) }}</span>
        <span class="stats__sub">仅计启用中的中心</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">打包费合计 / 份</span>
        <span class="stats__value">{{ fenToCny(summary.totalPackFeeFen) }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">服务楼群数</span>
        <span class="stats__value">{{ summary.servedGroupCount }}</span>
        <span class="stats__sub">去重后</span>
      </div>
    </div>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-select
        v-model="query.status"
        placeholder="状态"
        clearable
        style="width: 110px"
        @change="reload(1)"
      >
        <el-option
          v-for="o in page.statusOptions"
          :key="String(o.value)"
          :label="o.label"
          :value="Number(o.value)"
        />
      </el-select>

      <el-select
        v-model="query.groupId"
        placeholder="服务楼群"
        clearable
        filterable
        style="width: 190px"
        @change="reload(1)"
      >
        <el-option
          v-for="o in page.groupOptions"
          :key="String(o.value)"
          :label="o.label"
          :value="Number(o.value)"
        />
      </el-select>

      <el-input
        v-model="query.keyword"
        placeholder="名称 / 地址 / 联系人"
        clearable
        style="width: 200px"
        @keyup.enter="reload(1)"
        @clear="reload(1)"
      />

      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload(1)">查询</el-button>
        <el-button @click="goSuppliers">返回供应商名录</el-button>
        <el-tooltip
          :disabled="canManage"
          content="仅管理员 / 超级管理员可维护集散中心（场地费计入结算成本）"
          placement="top"
        >
          <span>
            <el-button type="primary" :disabled="!canManage" @click="openCreate"
              >新增集散中心</el-button
            >
          </span>
        </el-tooltip>
      </div>
    </div>

    <!-- ─────────────── 名录 ─────────────── -->
    <el-table v-loading="loading" :data="rows" class="table" stripe>
      <el-table-column label="集散中心" min-width="180">
        <template #default="{ row }">
          <div class="stack">
            <span class="strong">{{ asRow(row).name }}</span>
            <span class="sub">{{ asRow(row).address }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="联系人" width="150">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(asRow(row).contactName) }}</span>
            <span class="sub">{{ displayOr(asRow(row).contactPhone) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="场地费 / 份" width="120" align="right">
        <template #default="{ row }">
          <span :class="{ zero: asRow(row).riceFeeFen === 0 }">{{
            fenToCny(asRow(row).riceFeeFen)
          }}</span>
          <span v-if="asRow(row).riceFeeFen === 0" class="sub">默认</span>
        </template>
      </el-table-column>

      <el-table-column label="打包费 / 份" width="120" align="right">
        <template #default="{ row }">
          <span :class="{ zero: asRow(row).packFeeFen === 0 }">{{
            fenToCny(asRow(row).packFeeFen)
          }}</span>
        </template>
      </el-table-column>

      <el-table-column label="服务楼群" min-width="170">
        <template #default="{ row }">
          <div v-if="asRow(row).serviceGroupCount" class="tags">
            <el-tag
              v-for="(n, i) in asRow(row).serviceGroupNames.slice(0, 3)"
              :key="i"
              size="small"
              type="info"
              effect="plain"
            >
              {{ n }}
            </el-tag>
            <span v-if="asRow(row).serviceGroupCount > 3" class="sub">
              +{{ asRow(row).serviceGroupCount - 3 }}
            </span>
          </div>
          <span v-else class="sub">未绑定楼群（不可被套餐编排选用）</span>
        </template>
      </el-table-column>

      <el-table-column label="历史应付" width="140">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ asRow(row).shareCount }} 笔</span>
            <span class="sub">{{ fenToCny(asRow(row).shareAmountFen) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="96">
        <template #default="{ row }">
          <el-tag size="small" :type="asRow(row).status === 1 ? 'success' : 'info'">
            {{ asRow(row).statusLabel }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="176" fixed="right">
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
            {{ asRow(row).status === 1 ? '停用' : '启用' }}
          </el-button>
          <el-tooltip
            :disabled="asRow(row).canDelete"
            :content="deleteBlockReason(asRow(row))"
            placement="top"
          >
            <span>
              <el-button
                link
                type="danger"
                :disabled="!canManage || !asRow(row).canDelete"
                @click="remove(asRow(row))"
              >
                删除
              </el-button>
            </span>
          </el-tooltip>
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
      :title="editForm.id ? '编辑集散中心' : '新增集散中心'"
      width="580px"
      :close-on-click-modal="false"
    >
      <el-form :model="editForm" label-width="112px">
        <el-form-item label="名称" required>
          <el-input v-model="editForm.name" maxlength="64" placeholder="如：望京 SOHO 集散点" />
        </el-form-item>

        <!-- ⚠️ M4-0 删除「所属供应商」字段：场所属 ABox 自有，不归属供应商
             （`ab_distribution_center.supplier_id` 已停用为历史字段） -->

        <el-form-item label="地址" required>
          <el-input v-model="editForm.address" maxlength="128" placeholder="详细到门牌号" />
        </el-form-item>

        <el-form-item label="联系人">
          <el-input v-model="editForm.contactName" maxlength="32" style="width: 160px" />
        </el-form-item>

        <el-form-item label="联系电话">
          <el-input v-model="editForm.contactPhone" maxlength="20" style="width: 200px" />
        </el-form-item>

        <el-form-item label="场地费（元）">
          <el-input v-model="editForm.riceFeeYuan" placeholder="0.00" style="width: 160px">
            <template #append>元</template>
          </el-input>
          <p class="field-hint">
            默认 0 = <b>未登记</b>（不是免费）。留 0 会让经营毛利被高估，请按实际摊销额登记。
          </p>
        </el-form-item>

        <el-form-item label="打包费（元）">
          <el-input v-model="editForm.packFeeYuan" placeholder="0.00" style="width: 160px">
            <template #append>元</template>
          </el-input>
        </el-form-item>

        <el-form-item label="服务楼群">
          <el-select
            v-model="editForm.serviceGroups"
            multiple
            filterable
            placeholder="可多选；不选则不会被套餐选用"
            style="width: 100%"
          >
            <el-option
              v-for="o in page.groupOptions"
              :key="String(o.value)"
              :label="o.label"
              :value="Number(o.value)"
            />
          </el-select>
          <p class="field-hint">
            <b>整体替换语义</b>：提交时以本次选择为准 —— 清空即解绑全部楼群（不是「增量追加」）。
          </p>
        </el-form-item>

        <el-form-item v-if="editForm.id" label="状态">
          <el-radio-group v-model="editForm.status">
            <el-radio :value="1">启用中</el-radio>
            <el-radio :value="0">已停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  createDistributionCenter,
  deleteDistributionCenter,
  fetchDistributionCenters,
  updateDistributionCenter,
  type DistributionCenterRow,
  type Option,
} from '@/api/supplier';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny, yuanToFen } from '@/utils/format';

const router = useRouter();

const loading = ref(false);
const submitting = ref(false);
const rows = ref<DistributionCenterRow[]>([]);
const total = ref(0);

const summary = reactive({
  totalCount: 0,
  activeCount: 0,
  suspendedCount: 0,
  totalRiceFeeFen: 0,
  totalPackFeeFen: 0,
  servedGroupCount: 0,
});

const page = reactive<{
  statusOptions: Option[];
  groupOptions: Option[];
  actions: { canManage: boolean };
}>({
  statusOptions: [],
  groupOptions: [],
  actions: { canManage: false },
});

const canManage = computed(() => page.actions.canManage);

const query = reactive({
  status: undefined as number | undefined,
  groupId: undefined as number | undefined,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const editVisible = ref(false);
const editForm = reactive({
  id: 0,
  name: '',
  address: '',
  contactName: '',
  contactPhone: '',
  riceFeeYuan: '0.00',
  packFeeYuan: '0.00',
  serviceGroups: [] as number[],
  status: 1,
});

/** el-table 插槽的 row 是宽松 DefaultRow，入口断言一次，避免 `as` 扩散到模板 */
function asRow(raw: unknown): DistributionCenterRow {
  return raw as DistributionCenterRow;
}

/** 删除被禁时的理由 —— 直接把服务端的两道前置讲清楚，而不是让运营猜 */
function deleteBlockReason(row: DistributionCenterRow): string {
  if (row.shareCount > 0) {
    return `已有 ${row.shareCount} 笔历史应付（${fenToCny(row.shareAmountFen)}），删除后对账链会断 —— 请改用「停用」。`;
  }
  if (row.assignCount > 0) {
    return `已被 ${row.assignCount} 个套餐编排引用，删除会导致套餐指向空值 —— 请先解除引用或改用「停用」。`;
  }
  return '不可删除';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchDistributionCenters({
      status: query.status,
      groupId: query.groupId,
      keyword: query.keyword || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list;
    total.value = res.total;
    Object.assign(summary, res.summary);
    page.statusOptions = res.statusOptions;
    page.groupOptions = res.groupOptions;
    page.actions = res.actions;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '加载集散中心失败');
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
  editForm.name = '';
  editForm.address = '';
  editForm.contactName = '';
  editForm.contactPhone = '';
  editForm.riceFeeYuan = '0.00';
  editForm.packFeeYuan = '0.00';
  editForm.serviceGroups = [];
  editForm.status = 1;
  editVisible.value = true;
}

function openEdit(row: DistributionCenterRow): void {
  editForm.id = row.id;
  editForm.name = row.name;
  editForm.address = row.address;
  editForm.contactName = row.contactName ?? '';
  editForm.contactPhone = row.contactPhone ?? '';
  editForm.riceFeeYuan = row.riceFeeYuan;
  editForm.packFeeYuan = row.packFeeYuan;
  editForm.serviceGroups = [...row.serviceGroups];
  editForm.status = row.status;
  editVisible.value = true;
}

async function submitEdit(): Promise<void> {
  if (!editForm.name.trim()) {
    ElMessage.warning('请填写名称');
    return;
  }
  if (!editForm.address.trim()) {
    ElMessage.warning('请填写地址');
    return;
  }

  const payload = {
    name: editForm.name.trim(),
    address: editForm.address.trim(),
    contactName: editForm.contactName || undefined,
    contactPhone: editForm.contactPhone || undefined,
    riceFeeFen: yuanToFen(editForm.riceFeeYuan),
    packFeeFen: yuanToFen(editForm.packFeeYuan),
    serviceGroups: editForm.serviceGroups,
    status: editForm.status,
  };

  submitting.value = true;
  try {
    if (editForm.id) {
      await updateDistributionCenter(editForm.id, payload);
      ElMessage.success('集散中心已更新');
    } else {
      await createDistributionCenter(payload);
      ElMessage.success('集散中心已创建');
    }
    editVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    submitting.value = false;
  }
}

async function toggleStatus(row: DistributionCenterRow): Promise<void> {
  const toSuspend = row.status === 1;
  try {
    await ElMessageBox.confirm(
      toSuspend
        ? `停用「${row.name}」后，它将不再出现在套餐编排的集散可选列表中，但历史应付与对账记录保留。`
        : `启用「${row.name}」后即可被套餐编排选用。`,
      toSuspend ? '停用集散中心' : '启用集散中心',
      { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await updateDistributionCenter(row.id, { status: toSuspend ? 0 : 1 });
    ElMessage.success(toSuspend ? '已停用' : '已启用');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '操作失败');
  }
}

async function remove(row: DistributionCenterRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将删除「${row.name}」。该操作是软删（deleted_at），仅对无历史应付且未被套餐引用的集散中心可用。`,
      '删除集散中心',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await deleteDistributionCenter(row.id);
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    // 50002 存在历史结算：服务端拒绝，这里如实转述而不是笼统「操作失败」
    ElMessage.error(e instanceof ApiError ? e.message : '删除失败');
  }
}

function goSuppliers(): void {
  void router.push('/supplier/list');
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

.tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.strong {
  font-weight: 600;
}

.sub {
  color: $c-text-weak;
  font-size: 11px;
}

.zero {
  color: $c-text-weak;
}

.pager {
  margin-top: $space-3;
  justify-content: flex-end;
}

.field-hint {
  margin: 4px 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}
</style>
