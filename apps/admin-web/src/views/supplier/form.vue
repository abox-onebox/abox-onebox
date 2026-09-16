<template>
  <div class="page-container">
    <h2 class="page-container__title">
      {{ isEdit ? '编辑供应商' : '新增供应商' }}
      <span v-if="isEdit && detail" class="page-container__title-sub">{{
        detail.supplier.name
      }}</span>
    </h2>
    <p class="page-container__meta">
      模块：M34-01/03/04 · 原型 P33 · 接口：D24 新增 / D25 编辑 / D27 类型 / D28 结算账户 ·
      <code>ab_supplier</code> · 路径 <code>/supplier/form</code>
    </p>

    <!--
      ⚠️ 路径隔离：本页是**平台端** P33 的新增/编辑表单，落在 `/supplier/form`。
        不要挪回 `/supplier/edit` —— 那是《目录结构 v2.0》§10.2 分配给**商家端**
        P24「上架申请」/ P26「商家资料」的路径（`views/supplier/edit.vue`），
        且在 `admin-role.ts` 的 `SUPPLIER_MENU_KEYS` 里注册给 role=supplier。
        两角色共用同一 admin-web，路径一撞就会出现「商家点进平台页、调 /admin/* 接口拿 10003」。
    -->

    <el-alert v-if="!canManage" type="warning" :closable="false" class="note">
      <template #title>
        当前账号可查看供应商档案，但<b>新增 / 修改供应商资料收窄到管理员与超级管理员</b> ——
        供应商档案决定「钱付给谁」，属于资金动作。
      </template>
    </el-alert>

    <el-form ref="formRef" :model="form" :rules="rules" label-width="130px" class="form">
      <!-- ─────────── 基本信息 ─────────── -->
      <div class="section">
        <div class="section__title">基本信息</div>

        <el-form-item label="供应商名" prop="name">
          <el-input v-model="form.name" maxlength="128" placeholder="如：三味屋" />
          <div class="hint">
            ⚠️ 演示占位名为「三味屋 / 四季鲜蔬 / 京味小馆 / 老李家」；
            <b>「巡礼之年」是平台主体公司品牌，不得用作供应商名</b>。
          </div>
        </el-form-item>

        <el-form-item label="类型" prop="type">
          <el-radio-group v-model="form.type" :disabled="typeLocked">
            <el-radio v-for="o in typeOptions" :key="o.value" :value="o.value">{{
              o.label
            }}</el-radio>
          </el-radio-group>
          <div v-if="typeLocked" class="hint">
            该供应商名下已有 <b>{{ detail?.supplier.dcCount }}</b> 个集散中心， 不能改为「出餐型」——
            集散中心必须挂在能承担集散的主体下（否则 50008）。
          </div>
        </el-form-item>

        <el-form-item label="联系人" prop="contactName">
          <el-input v-model="form.contactName" maxlength="32" style="width: 220px" />
        </el-form-item>

        <el-form-item label="联系电话" prop="contactPhone">
          <el-input v-model="form.contactPhone" maxlength="11" style="width: 220px" />
        </el-form-item>

        <el-form-item label="主营品类">
          <el-input
            v-model="form.category"
            maxlength="32"
            style="width: 220px"
            placeholder="如：本帮菜"
          />
        </el-form-item>

        <el-form-item label="地址">
          <el-input
            v-model="form.address"
            maxlength="256"
            placeholder="集散型供应商必填（复用其场地做集散）"
          />
        </el-form-item>

        <el-form-item label="每日产能">
          <el-input-number v-model="form.capacityPerDay" :min="0" :max="100000" />
          <span class="unit">份 / 日</span>
        </el-form-item>

        <el-form-item v-if="isEdit" label="合作状态">
          <el-switch
            v-model="form.status"
            :active-value="1"
            :inactive-value="0"
            active-text="合作中"
            inactive-text="已停用"
          />
          <div class="hint">
            本页是供应商启停的<b>唯一入口</b>。停用不会自动下架菜品（菜品上下架在菜品库单独管）；
            但资质未通过或证照过期时，即便启用也不能出餐。
          </div>
        </el-form-item>
      </div>

      <!-- ─────────── 资质与证照 ─────────── -->
      <div class="section">
        <div class="section__title">
          资质与证照
          <span v-if="isEdit && detail" class="section__badge">
            当前：{{ detail.supplier.auditStatusLabel }} · {{ detail.supplier.licenseStateLabel }}
          </span>
        </div>

        <el-form-item label="营业执照">
          <el-input
            v-model="form.businessLicense"
            maxlength="256"
            placeholder="文件 URL 或证件编号（可后置收集）"
          />
        </el-form-item>

        <el-form-item label="食品经营许可证">
          <el-input
            v-model="form.foodLicense"
            maxlength="256"
            placeholder="文件 URL 或证件编号（可后置收集）"
          />
        </el-form-item>

        <el-form-item label="证照有效期">
          <el-date-picker
            v-model="form.licenseExpireAt"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="食品经营许可证到期日"
            style="width: 220px"
          />
          <div class="hint">
            ⚠️ 保存为<b>过去日期</b>时，系统会<b>同时下架该供应商的全部在架菜品</b>并回报数量 （123
            号令：证照过期不得出餐）。通过资质审核也要求此字段未过期。
          </div>
        </el-form-item>

        <el-form-item v-if="isEdit" label="审核信息">
          <div class="readonly">
            <span>状态：{{ detail?.supplier.auditStatusLabel }}</span>
            <span>审核人：{{ displayOr(detail?.supplier.auditedByName) }}</span>
            <span>审核时间：{{ formatDateTime(detail?.supplier.auditedAt) }}</span>
            <span>意见：{{ displayOr(detail?.supplier.auditRemark) }}</span>
          </div>
          <div class="hint">审核动作在名录页的「资质审核」里做，此处只读展示。</div>
        </el-form-item>
      </div>

      <!-- ─────────── 结算账户（D28） ─────────── -->
      <div class="section">
        <div class="section__title">
          结算账户
          <span class="section__badge">C10：人工对公转账，系统不接支付通道</span>
        </div>

        <el-form-item label="付款方式" prop="payeeType">
          <el-radio-group v-model="form.payeeType">
            <el-radio value="corporate">对公转账</el-radio>
            <el-radio value="personal">对私转账</el-radio>
            <el-radio value="cash">现金结算</el-radio>
          </el-radio-group>
        </el-form-item>

        <template v-if="form.payeeType === 'corporate'">
          <el-form-item label="开户行">
            <el-input v-model="form.bankName" maxlength="64" style="width: 260px" />
          </el-form-item>
          <el-form-item label="银行账号">
            <el-input v-model="form.bankAccount" maxlength="64" style="width: 260px" />
            <div class="hint">
              ⚠️ 账号保存后<b>任何接口都不会回传原文</b>（连本页也只显示脱敏号）——
              付款登记时由财务线下核对，避免账号在日志或截图里泄露。
              <template v-if="isEdit && detail?.bank.bankAccountMasked">
                当前：{{ detail.bank.bankAccountMasked }}
              </template>
            </div>
          </el-form-item>
        </template>

        <el-form-item label="发票抬头">
          <el-input v-model="form.invoiceTitle" maxlength="128" style="width: 320px" />
          <div class="hint">与展示名可能不同（开票须用工商全称）。</div>
        </el-form-item>
      </div>

      <div class="actions">
        <el-button @click="goBack">返回</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canManage" @click="submit">
          {{ isEdit ? '保存修改' : '创建供应商' }}
        </el-button>
      </div>
    </el-form>

    <!-- ─────────── 编辑态：只读关联信息 ─────────── -->
    <template v-if="isEdit && detail">
      <div class="section">
        <div class="section__title">关联信息（只读）</div>
        <div class="readonly-grid">
          <div class="ro-item">
            <span class="ro-label">菜品数</span>
            <span class="ro-value">{{ detail.supplier.dishCount }}</span>
          </div>
          <div class="ro-item">
            <span class="ro-label">集散中心</span>
            <span class="ro-value">{{ detail.supplier.dcCount }}</span>
          </div>
          <div class="ro-item">
            <span class="ro-label">本月应付</span>
            <span class="ro-value">{{ fenToCny(detail.supplier.monthShareFen) }}</span>
          </div>
          <div class="ro-item">
            <span class="ro-label">可出餐</span>
            <span class="ro-value">{{ detail.supplier.canServe ? '是' : '否' }}</span>
          </div>
          <div class="ro-item">
            <span class="ro-label">联系电话</span>
            <span class="ro-value">{{ displayOr(detail.contactPhone) }}</span>
          </div>
        </div>

        <div v-if="detail.distributionCenters.length" class="sub-block">
          <div class="sub-block__title">名下集散中心</div>
          <el-table :data="detail.distributionCenters" size="small">
            <el-table-column prop="name" label="名称" min-width="180" />
            <el-table-column prop="address" label="地址" min-width="200" />
            <el-table-column prop="statusLabel" label="状态" width="90" />
          </el-table>
        </div>

        <div v-if="detail.recentShares.length" class="sub-block">
          <div class="sub-block__title">近 30 条应付流水（负行为「应付单算错」的纠错冲销）</div>
          <el-table :data="detail.recentShares" size="small" max-height="260">
            <el-table-column prop="mealDate" label="出餐日" width="110" />
            <el-table-column prop="shareNo" label="应付单号" min-width="150" />
            <el-table-column prop="quantity" label="份数" width="80" align="right" />
            <el-table-column label="单价" width="100" align="right">
              <template #default="{ row }">{{ fenToCny(asShare(row).unitPriceFen) }}</template>
            </el-table-column>
            <el-table-column label="金额" width="110" align="right">
              <template #default="{ row }">
                <span :class="{ neg: asShare(row).amountFen < 0 }">
                  {{ fenToCny(asShare(row).amountFen) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="type" label="类型" width="100" />
          </el-table>
        </div>

        <div v-if="detail.operationLogs.length" class="sub-block">
          <div class="sub-block__title">操作日志</div>
          <el-table :data="detail.operationLogs" size="small">
            <el-table-column prop="action" label="操作" min-width="160" />
            <el-table-column label="时间" width="180">
              <template #default="{ row }">{{ formatDateTime(asLog(row).createdAt) }}</template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';

import {
  createSupplier,
  fetchSupplierDetail,
  updateSupplier,
  type SupplierDetail,
} from '@/api/supplier';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny, formatDateTime } from '@/utils/format';

const route = useRoute();
const router = useRouter();

const formRef = ref<FormInstance>();
const submitting = ref(false);
const canManage = ref(true);
const detail = ref<SupplierDetail | null>(null);

const typeOptions = [
  { value: 'dish', label: '出餐型' },
  { value: 'distribute', label: '集散型' },
  { value: 'both', label: '混合型' },
];

/** `?id=` 存在即编辑态 */
const editId = computed(() => {
  const raw = route.query.id;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
});
const isEdit = computed(() => editId.value !== undefined);

/** 名下已有集散中心 → 不允许降级为纯出餐型（服务端 50008 的界面预演，少跑一趟白路） */
const typeLocked = computed(() => (detail.value?.supplier.dcCount ?? 0) > 0);

const form = reactive({
  name: '',
  type: 'dish' as string,
  contactName: '',
  contactPhone: '',
  category: '',
  address: '',
  capacityPerDay: 0 as number | undefined,
  businessLicense: '',
  foodLicense: '',
  licenseExpireAt: undefined as string | undefined,
  payeeType: 'corporate' as string,
  bankName: '',
  bankAccount: '',
  invoiceTitle: '',
  status: 1,
});

const rules: FormRules = {
  name: [
    { required: true, message: '请填写供应商名', trigger: 'blur' },
    { min: 2, max: 128, message: '长度 2–128 字', trigger: 'blur' },
  ],
  type: [{ required: true, message: '请选择类型', trigger: 'change' }],
  contactName: [
    { required: true, message: '请填写联系人', trigger: 'blur' },
    { min: 2, max: 32, message: '长度 2–32 字', trigger: 'blur' },
  ],
  contactPhone: [
    { required: true, message: '请填写联系电话', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '请填写 11 位手机号', trigger: 'blur' },
  ],
  payeeType: [{ required: true, message: '请选择付款方式', trigger: 'change' }],
};

function asShare(raw: unknown): { unitPriceFen: number; amountFen: number } {
  return raw as { unitPriceFen: number; amountFen: number };
}

function asLog(raw: unknown): { createdAt: string | null } {
  return raw as { createdAt: string | null };
}

async function loadDetail(): Promise<void> {
  if (!editId.value) return;
  try {
    const res = await fetchSupplierDetail(editId.value);
    detail.value = res;
    const s = res.supplier;
    form.name = s.name;
    form.type = s.type;
    form.contactName = s.contactName;
    form.contactPhone = res.contactPhone ?? '';
    form.category = s.category ?? '';
    form.licenseExpireAt = s.licenseExpireAt ?? undefined;
    form.payeeType = res.bank.payeeType;
    form.bankName = res.bank.bankName ?? '';
    // ⚠️ 不回填账号原文（服务端不回传）：留空 = 不修改，填写 = 覆盖
    form.bankAccount = '';
    form.invoiceTitle = res.bank.invoiceTitle ?? '';
    form.status = s.status;
    form.capacityPerDay = s.capacityPerDay ?? undefined;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '加载供应商详情失败');
  }
}

async function submit(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;

  // 对公必须有账户：与服务层同一条规则（此处预校验，省一次往返）
  if (form.payeeType === 'corporate' && (!form.bankName || !form.bankAccount) && !isEdit.value) {
    ElMessage.warning('对公转账必须填写开户行与银行账号（对私/现金可不填）');
    return;
  }

  submitting.value = true;
  try {
    if (isEdit.value && editId.value) {
      const res = await updateSupplier(editId.value, {
        name: form.name,
        type: form.type,
        contactName: form.contactName,
        contactPhone: form.contactPhone,
        category: form.category || undefined,
        address: form.address || undefined,
        capacityPerDay: form.capacityPerDay,
        businessLicense: form.businessLicense || undefined,
        foodLicense: form.foodLicense || undefined,
        licenseExpireAt: form.licenseExpireAt,
        payeeType: form.payeeType,
        status: form.status,
      });
      // 副作用必须显式告知：否则运营会以为菜品「自己消失了」
      if (res.unpublishedDishCount > 0) {
        ElMessage.warning(
          `已保存。因证照有效期已过期，联动下架了 ${res.unpublishedDishCount} 道在架菜品`,
        );
      } else {
        ElMessage.success('已保存');
      }
    } else {
      const res = await createSupplier({
        name: form.name,
        type: form.type,
        contactName: form.contactName,
        contactPhone: form.contactPhone,
        category: form.category || undefined,
        address: form.address || undefined,
        capacityPerDay: form.capacityPerDay,
        businessLicense: form.businessLicense || undefined,
        foodLicense: form.foodLicense || undefined,
        licenseExpireAt: form.licenseExpireAt,
        payeeType: form.payeeType,
      });
      ElMessage.success(`已创建（#${res.id}）· 资质状态：待审核`);
      await router.replace({ path: '/supplier/form', query: { id: String(res.id) } });
    }
    await loadDetail();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    submitting.value = false;
  }
}

function goBack(): void {
  void router.push('/supplier/list');
}

onMounted(() => {
  void loadDetail();
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

.page-container__title-sub {
  margin-left: $space-2;
  color: $c-text-weak;
  font-size: $fs-h2;
  font-weight: 400;
}

.note {
  margin-bottom: $space-3;
}

.form {
  max-width: 900px;
}

.section {
  margin-bottom: $space-4;
  padding: $space-3;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
}

.section__title {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-3;
  padding-bottom: $space-2;
  font-size: $fs-h2;
  font-weight: 600;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.section__badge {
  color: $c-text-weak;
  font-size: $fs-caption;
  font-weight: 400;
}

.hint {
  margin-top: 4px;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}

.unit {
  margin-left: $space-1;
  color: $c-text-weak;
}

.readonly {
  display: flex;
  flex-wrap: wrap;
  gap: $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.actions {
  display: flex;
  gap: $space-2;
  justify-content: flex-end;
  max-width: 900px;
}

.readonly-grid {
  display: flex;
  flex-wrap: wrap;
  gap: $space-3;
}

.ro-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 120px;
}

.ro-label {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.ro-value {
  font-size: 16px;
  font-weight: 600;
}

.sub-block {
  margin-top: $space-3;
}

.sub-block__title {
  margin-bottom: $space-2;
  font-size: $fs-caption;
  font-weight: 600;
}

.neg {
  font-weight: 700;
  color: $c-warning;
}
</style>
