<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="520px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="!supplierId" class="sad__empty">未指定供应商</div>

    <template v-else>
      <el-alert type="warning" :closable="false" class="sad__note">
        <template #title>
          本表单是<b>整份覆盖</b>：提交后以本次填写为准。银行账号<b>留空 = 清空</b>，
          不是「保持原值」。
        </template>
      </el-alert>

      <el-form v-loading="loading" label-width="96px">
        <el-form-item label="付款方式" required>
          <el-radio-group v-model="form.payeeType">
            <el-radio value="corporate">对公转账</el-radio>
            <el-radio value="personal">对私转账</el-radio>
            <el-radio value="cash">现金结算</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-if="form.payeeType === 'corporate'" label="开户行" required>
          <el-input v-model="form.bankName" maxlength="64" placeholder="例如：招商银行北京分行" />
        </el-form-item>

        <el-form-item v-if="form.payeeType === 'corporate'" label="银行账号">
          <el-input v-model="form.bankAccount" maxlength="64" placeholder="留空 = 清空已登记账号" />
          <div class="sad__tip">
            保存后<b>任何接口都不回传原文</b>，本弹窗也只能看到脱敏号 ——
            付款由财务线下核对。<template v-if="masked">当前：{{ masked }}</template>
          </div>
        </el-form-item>

        <el-form-item label="发票抬头">
          <el-input v-model="form.invoiceTitle" maxlength="128" placeholder="工商全称（可留空）" />
        </el-form-item>
      </el-form>
    </template>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!supplierId" @click="submit">
        保存结算账户
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * D28 对公结算账户（补 admin:coverage 缺口 #42）
 *
 * ⭐⭐ 为什么单独做一个弹窗，而不是把字段塞回「编辑供应商」表单：
 *      `views/supplier/form.vue` 里**原本就有**开户行 / 账号 / 发票抬头三个输入框，
 *      但 `submit()` 只把 `payeeType` 传给了 D25 `update`，那三个字段**从未被提交**
 *      —— 是「能填、填了静默丢失」。把它们接到 D25 也不行：D25 不写这三列。
 *      ⇒ 记账路径只有 D28，故入口必须挂在 D28 上（form.vue 那三个框改为只读展示）。
 *
 * ⭐⭐ 为什么强调「整份覆盖、留空=清空」：
 *      `SupplierAdminService.setSettleAccount` 是 `dto.bankAccount ?? null` ——
 *      省略与显式留空**效果相同（清空）**。而账号一旦被清空，付款就没有落点，
 *      且服务端**不回传原文**，事后无法从页面恢复。故此处必须让「留空」的后果
 *      在**提交前**被看见（对公 + 已登记 + 本次留空 ⇒ 二次确认）。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import { fetchSupplierDetail, setSettleAccount } from '@/api/supplier';
import { ApiError } from '@/api/request';

const props = defineProps<{
  modelValue: boolean;
  supplierId: number | null;
  supplierName: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'saved'): void;
}>();

const loading = ref(false);
const saving = ref(false);
const masked = ref<string | null>(null);
const form = ref({ payeeType: 'corporate', bankName: '', bankAccount: '', invoiceTitle: '' });

const title = computed(() =>
  props.supplierId === null
    ? '结算账户'
    : `结算账户 · ${props.supplierName || `#${props.supplierId}`}`,
);

async function load(): Promise<void> {
  if (props.supplierId === null) return;
  loading.value = true;
  try {
    const res = await fetchSupplierDetail(props.supplierId);
    const b = res.bank;
    masked.value = b.bankAccountMasked ?? null;
    form.value = {
      payeeType: b.payeeType || 'corporate',
      bankName: b.bankName ?? '',
      // 账号原文服务端不回传 ⇒ 永远从空开始（与 form.vue 同纪律）
      bankAccount: '',
      invoiceTitle: b.invoiceTitle ?? '',
    };
  } catch (e) {
    masked.value = null;
    ElMessage.error(e instanceof ApiError ? e.message : '结算账户加载失败');
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.modelValue, props.supplierId] as const,
  ([open]) => {
    if (open) void load();
  },
  { immediate: true },
);

async function submit(): Promise<void> {
  if (props.supplierId === null) return;
  const id = props.supplierId;
  const f = form.value;

  if (f.payeeType === 'corporate' && !f.bankName.trim()) {
    ElMessage.warning('对公转账必须填写开户行');
    return;
  }

  // 已登记账号 + 本次留空 = 清空 ⇒ 提交前必须让这个后果被看见（见头注）
  if (f.payeeType === 'corporate' && masked.value && !f.bankAccount.trim()) {
    try {
      await ElMessageBox.confirm(
        `本次未填写账号，提交后将清空已登记的 ${masked.value}。账号不回传原文，清空后无法从页面恢复。确认清空？`,
        '确认清空银行账号',
        { type: 'warning', confirmButtonText: '确认清空', cancelButtonText: '返回补填' },
      );
    } catch {
      return;
    }
  }

  saving.value = true;
  try {
    const res = await setSettleAccount(id, {
      payeeType: f.payeeType,
      bankName: f.bankName.trim() || undefined,
      bankAccount: f.bankAccount.trim() || undefined,
      invoiceTitle: f.invoiceTitle.trim() || undefined,
    });
    masked.value = res.bankAccountMasked ?? null;
    f.bankAccount = '';
    ElMessage.success('结算账户已保存');
    emit('update:modelValue', false);
    emit('saved');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败，请稍后重试');
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.sad__note {
  margin-bottom: $space-3;
}

.sad__tip {
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.5;
}

.sad__empty {
  color: $c-text-weak;
}
</style>
