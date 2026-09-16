<template>
  <div class="page-container">
    <h2 class="page-container__title">供应商管理 · 名录与资质（C9 逐菜协商价）</h2>
    <p class="page-container__meta">
      模块：M34-01/02/03/04 · 原型 P33 · 接口：D23 名录 / D24 新增 / D25 编辑 / D26 资质审核 / D27
      类型 / D28 结算账户 · 数据源 <code>ab_supplier</code> + <code>ab_distribution_center</code>
    </p>

    <!-- 两个最容易搞混的口径，都放在首屏显式说明，避免运营用自己的理解去推断系统行为 -->
    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>资质审核 ≠ 停用，两者正交</b> ——
        「资质审核」回答<i>它有没有合规经营资格</i>（监管口径），
        「合作状态」回答<i>平台要不要继续跟它合作</i>（经营口径）。
        <b>驳回资质不会自动把商家下架</b>，需在编辑页显式停用。
      </template>
    </el-alert>

    <el-alert v-if="summary.expiredCount > 0" type="warning" :closable="false" class="note">
      <template #title>
        <b>资质过期联动</b>：{{ summary.expiredCount }} 家供应商的食品经营许可证已过期 ——
        系统在保存证照有效期时会<b>自动下架其关联菜品</b>（123 号令：证照过期不得出餐）。
        点上方筛选「已过期」优先处理。
      </template>
    </el-alert>

    <!-- ─────────────── KPI（同一过滤条件的全量，翻页不跳） ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">供应商总数</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
        <span class="stats__sub">自营下均为半成品供货方（无类型之分）</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">可出餐</span>
        <span class="stats__value stats__value--ok">{{ summary.canServeCount }}</span>
        <span class="stats__sub">合作中 ∧ 资质通过 ∧ 证照未过期</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">资质 30 天内到期</span>
        <span class="stats__value stats__value--warn">{{ summary.expiringCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">资质已过期</span>
        <span class="stats__value stats__value--danger">{{ summary.expiredCount }}</span>
        <span class="stats__sub">已联动下架关联菜品</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">待审核</span>
        <span class="stats__value stats__value--warn">{{ summary.auditPendingCount }}</span>
        <span class="stats__sub"
          >通过 {{ summary.auditApprovedCount }} · 驳回 {{ summary.auditRejectedCount }}</span
        >
      </div>
    </div>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-select
        v-model="query.auditStatus"
        placeholder="审核状态"
        clearable
        style="width: 130px"
        @change="reload()"
      >
        <el-option
          v-for="o in page.auditStatusOptions"
          :key="String(o.value)"
          :label="o.label"
          :value="String(o.value)"
        />
      </el-select>

      <el-select
        v-model="query.licenseState"
        placeholder="证照有效期"
        clearable
        style="width: 140px"
        @change="reload()"
      >
        <el-option label="有效" value="normal" />
        <el-option label="30 天内到期" value="expiring" />
        <el-option label="已过期" value="expired" />
        <el-option label="未登记" value="unknown" />
      </el-select>

      <el-select
        v-model="query.status"
        placeholder="合作状态"
        clearable
        style="width: 120px"
        @change="reload()"
      >
        <el-option
          v-for="o in page.statusOptions"
          :key="String(o.value)"
          :label="o.label"
          :value="Number(o.value)"
        />
      </el-select>

      <el-input
        v-model="query.keyword"
        placeholder="名称 / 联系人 / 手机号 / 集散中心名"
        clearable
        style="width: 240px"
        @keyup.enter="reload(1)"
        @clear="reload(1)"
      />

      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload(1)">查询</el-button>
        <el-button @click="goCenters">集散中心配置</el-button>
        <el-button @click="goDishes">菜品库</el-button>
        <el-tooltip
          :disabled="canManage"
          content="仅管理员 / 超级管理员可维护供应商（决定钱付给谁）"
          placement="top"
        >
          <span>
            <el-button type="primary" :disabled="!canManage" @click="goEdit()"
              >新增供应商</el-button
            >
          </span>
        </el-tooltip>
      </div>
    </div>

    <!-- ─────────────── 名录 ─────────────── -->
    <el-table v-loading="loading" :data="rows" class="table" stripe>
      <el-table-column label="供应商" min-width="180">
        <template #default="{ row }">
          <div class="stack">
            <span class="strong">{{ asRow(row).name }}</span>
            <span class="sub">
              {{ asRow(row).category || '未标注品类' }} ·
              {{ asRow(row).capacityPerDay ? `${asRow(row).capacityPerDay} 份/日` : '产能未登记' }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="联系人" min-width="150">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ asRow(row).contactName }}</span>
            <!-- 列表只给脱敏号：详情页才展示真实号码 -->
            <span class="sub">{{ displayOr(asRow(row).contactPhoneMasked) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="菜品数" width="90" align="center">
        <template #default="{ row }">
          <span>{{ asRow(row).dishCount }}</span>
        </template>
      </el-table-column>

      <el-table-column label="本月应付" width="120" align="right">
        <template #default="{ row }">{{ fenToCny(asRow(row).monthShareFen) }}</template>
      </el-table-column>

      <el-table-column label="资质有效期" min-width="170">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(asRow(row).licenseExpireAt) }}</span>
            <el-tag size="small" :type="licenseTag(asRow(row).licenseState)">
              {{ asRow(row).licenseStateLabel }}
              <template v-if="asRow(row).licenseDaysLeft !== null">
                （{{ asRow(row).licenseDaysLeft }} 天）
              </template>
            </el-tag>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="审核" width="120">
        <template #default="{ row }">
          <div class="stack">
            <el-tag size="small" :type="auditTag(asRow(row).auditStatus)">
              {{ asRow(row).auditStatusLabel }}
            </el-tag>
            <span class="sub">{{ displayOr(asRow(row).auditedByName) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="合作" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="asRow(row).status === 1 ? 'success' : 'info'">
            {{ asRow(row).statusLabel }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="可出餐" width="86" align="center">
        <template #default="{ row }">
          <span :class="asRow(row).canServe ? 'ok' : 'muted'">
            {{ asRow(row).canServe ? '是' : '否' }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="goEdit(asRow(row).id)">编辑</el-button>
          <el-button link type="primary" :disabled="!canManage" @click="openAudit(asRow(row))">
            资质审核
          </el-button>
          <el-button link type="primary" :disabled="!canManage" @click="goTakeout(asRow(row).id)">
            外卖链接
          </el-button>
          <el-button
            link
            :type="asRow(row).status === 1 ? 'danger' : 'success'"
            :disabled="!canManage"
            @click="toggleStatus(asRow(row))"
          >
            {{ asRow(row).status === 1 ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      :page-sizes="[20, 50, 100]"
      layout="total, sizes, prev, pager, next"
      class="pager"
      @current-change="load"
      @size-change="reload(1)"
    />

    <!-- ─────────────── D26 资质审核弹窗 ─────────────── -->
    <el-dialog v-model="auditVisible" title="资质审核" width="560px">
      <div v-if="current" class="dialog-body">
        <p class="dialog-line">
          <b>{{ current.name }}</b> · 当前审核状态：{{ current.auditStatusLabel }}
        </p>
        <p class="dialog-hint">
          核验营业执照与食品经营许可证。⚠️ 通过审核<b>要求登记未过期的证照有效期</b> ——
          没有它，「证照过期不得出餐」无从判定，平台就是明知故犯。
        </p>

        <el-form label-width="120px">
          <el-form-item label="审核结论" required>
            <el-radio-group v-model="auditForm.result">
              <el-radio value="approved">通过</el-radio>
              <el-radio value="rejected">驳回</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="证照有效期">
            <el-date-picker
              v-model="auditForm.licenseExpireAt"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="食品经营许可证到期日"
              style="width: 100%"
            />
            <div class="field-hint">
              通过审核必填（库中已有则可不填）；填写的日期<b>已在过去则无法通过</b>。
            </div>
          </el-form-item>

          <el-form-item label="审核意见" :required="auditForm.result === 'rejected'">
            <el-input
              v-model="auditForm.remark"
              type="textarea"
              :rows="3"
              maxlength="256"
              show-word-limit
              placeholder="驳回时必填（≥2 字），会作为答复商家的依据"
            />
          </el-form-item>
        </el-form>

        <el-alert type="warning" :closable="false">
          <template #title>
            审核<b>不会改变合作状态</b>：{{
              current.status === 1 ? '目前为「合作中」' : '目前为「已停用」'
            }}， 审核后依然如此。若要下架商家，请回到列表用「停用」。
          </template>
        </el-alert>
      </div>

      <template #footer>
        <el-button @click="auditVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitAudit">提交审核</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  auditSupplier,
  fetchAdminSuppliers,
  updateSupplier,
  type Option,
  type SupplierRow,
  type SuppliersQuery,
  type SuppliersSummary,
} from '@/api/supplier';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny } from '@/utils/format';

const router = useRouter();

const loading = ref(false);
const submitting = ref(false);
const rows = ref<SupplierRow[]>([]);
const total = ref(0);

const summary = reactive<SuppliersSummary>({
  totalCount: 0,
  activeCount: 0,
  suspendedCount: 0,
  // ⚠️ M4-0：`dishCount` / `distributeCount` / `bothCount` / `dcTotalCount` 已随
  //    类型停用与场所归属摘除一并删除（服务端不再下发）。
  auditPendingCount: 0,
  auditApprovedCount: 0,
  auditRejectedCount: 0,
  expiringCount: 0,
  expiredCount: 0,
  canServeCount: 0,
});

/** 枚举选择器由服务端下发（含真实品类去重），端上不维护第二份中文映射 */
const page = reactive<{
  auditStatusOptions: Option[];
  statusOptions: Option[];
  actions: { canManage: boolean };
}>({
  auditStatusOptions: [],
  statusOptions: [],
  actions: { canManage: false },
});

const canManage = computed(() => page.actions.canManage);

const query = reactive({
  auditStatus: undefined as string | undefined,
  licenseState: undefined as string | undefined,
  status: undefined as number | undefined,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const current = ref<SupplierRow | null>(null);
const auditVisible = ref(false);
const auditForm = reactive({
  result: 'approved' as 'approved' | 'rejected',
  licenseExpireAt: undefined as string | undefined,
  remark: '',
});

/** el-table 插槽的 row 是宽松 DefaultRow，入口断言一次，避免 `as` 扩散到模板 */
function asRow(raw: unknown): SupplierRow {
  return raw as SupplierRow;
}

// ⚠️ M4-0 删除 `typeTag()`：类型列与类型筛选已移除（供应商类型停用，
//    自营下只有「半成品供货方」一种角色）。

function auditTag(status: string): 'info' | 'success' | 'danger' {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  return 'info';
}

function licenseTag(state: string): 'info' | 'success' | 'warning' | 'danger' {
  if (state === 'expired') return 'danger';
  if (state === 'expiring') return 'warning';
  if (state === 'normal') return 'success';
  return 'info';
}

function buildParams(): SuppliersQuery {
  return {
    auditStatus: query.auditStatus,
    licenseState: query.licenseState,
    status: query.status,
    keyword: query.keyword || undefined,
    page: query.page,
    pageSize: query.pageSize,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchAdminSuppliers(buildParams());
    rows.value = res.list;
    total.value = res.total;
    Object.assign(summary, res.summary);
    page.auditStatusOptions = res.auditStatusOptions;
    page.statusOptions = res.statusOptions;
    page.actions = res.actions;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '加载供应商名录失败');
  } finally {
    loading.value = false;
  }
}

function reload(pageNo = 1): void {
  query.page = pageNo;
  void load();
}

function openAudit(row: SupplierRow): void {
  current.value = row;
  auditForm.result = 'approved';
  auditForm.licenseExpireAt = row.licenseExpireAt ?? undefined;
  auditForm.remark = '';
  auditVisible.value = true;
}

async function submitAudit(): Promise<void> {
  if (!current.value) return;
  if (auditForm.result === 'rejected' && auditForm.remark.trim().length < 2) {
    ElMessage.warning('驳回资质必须填写审核意见（≥2 字）');
    return;
  }
  submitting.value = true;
  try {
    const res = await auditSupplier(current.value.id, {
      result: auditForm.result,
      licenseExpireAt: auditForm.licenseExpireAt,
      remark: auditForm.remark || undefined,
    });
    ElMessage.success(`审核完成：${res.auditStatusLabel}`);
    auditVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '审核失败');
  } finally {
    submitting.value = false;
  }
}

/**
 * 启停走 D25（供应商模块没有单独的停用接口）。
 *
 * ⚠️ 停用**不会**顺带下架菜品：菜品上下架在菜品库单独管（那是供应能力的表达，
 *    这与「证照过期强制下架」不同 —— 后者是合规硬性的，前者是经营判断）。
 */
async function toggleStatus(row: SupplierRow): Promise<void> {
  const toSuspend = row.status === 1;
  try {
    await ElMessageBox.confirm(
      toSuspend
        ? `停用「${row.name}」后，它将不再出现在套餐编排的可选供应商中（历史结算与档案保留）。`
        : `启用「${row.name}」后，若其资质仍未通过或证照已过期，依然不能出餐（canServe 仍为否）。`,
      toSuspend ? '停用供应商' : '启用供应商',
      { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await updateSupplier(row.id, { status: toSuspend ? 0 : 1 });
    ElMessage.success(toSuspend ? '已停用' : '已启用');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '操作失败');
  }
}

function goEdit(id?: number): void {
  void router.push({ path: '/supplier/form', query: id ? { id: String(id) } : {} });
}

function goTakeout(id: number): void {
  void router.push({ path: '/supplier/takeout-links', query: { supplierId: String(id) } });
}

function goDishes(): void {
  void router.push('/supplier/dish-library');
}

function goCenters(): void {
  void router.push('/supplier/distribution-center');
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
  color: #c44536;
}

.stats__value--danger {
  color: #c44536;
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

.ok {
  color: #5b7c3a;
  font-weight: 600;
}

.muted {
  color: $c-text-weak;
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
</style>
