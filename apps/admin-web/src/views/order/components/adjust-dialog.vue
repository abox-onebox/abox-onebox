<template>
  <el-dialog
    :model-value="modelValue"
    title="手动改单"
    width="560px"
    @update:model-value="emit('update:modelValue', $event)"
    @closed="reset"
  >
    <el-descriptions :column="2" border size="small" class="dialog__head">
      <el-descriptions-item label="订单号">{{ order?.orderNo }}</el-descriptions-item>
      <el-descriptions-item label="出餐日">{{ order?.mealDate }}</el-descriptions-item>
      <el-descriptions-item label="当前状态">{{ order?.statusText }}</el-descriptions-item>
      <el-descriptions-item label="当前金额">
        {{ fenToCny(order?.totalAmountFen) }}
      </el-descriptions-item>
    </el-descriptions>

    <el-alert
      v-if="blockReason"
      type="warning"
      :closable="false"
      show-icon
      :title="blockReason"
      class="dialog__alert"
    />

    <el-form label-width="90px" class="dialog__form">
      <el-form-item label="改单动作">
        <el-radio-group v-model="form.action" :disabled="!!blockReason">
          <el-radio value="change_quantity">改份数</el-radio>
          <el-radio value="change_building">改取餐楼</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-form-item v-if="form.action === 'change_quantity'" label="目标份数" required>
        <el-input-number v-model="form.quantity" :min="1" :max="100" />
        <span class="dialog__tip">
          当前 {{ order?.quantity }} 份 · 单份 {{ fenToCny(order?.unitPriceFen) }}
        </span>
      </el-form-item>

      <el-form-item v-else label="目标办公楼" required>
        <el-select v-model="form.buildingId" filterable placeholder="选择办公楼">
          <el-option v-for="b in sameGroupBuildings" :key="b.id" :label="b.name" :value="b.id" />
        </el-select>
        <span class="dialog__tip">
          仅可选与原楼同楼群（{{ order?.groupName }}）的办公楼 —— 跨楼群换楼等于同时换掉套餐与集散
        </span>
      </el-form-item>

      <el-form-item label="改单原因" required>
        <el-input
          v-model="form.reason"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="必填 —— 会写入操作日志的前后值快照"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!!blockReason" @click="submit">
        确认改单
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  fetchOrderFilterOptions,
  manualAdjustOrder,
  type AdminOrderRow,
  type OrderFilterOptions,
} from '@/api/order';
import { ApiError } from '@/api/request';
import { fenToCny } from '@/utils/format';

/**
 * 手动改单弹窗（D10）
 *
 * 抽成组件而不是在两个页面各写一份：**改单的校验规则必须只有一处**。
 * 上一批（套餐矩阵）把「新建 / 编辑」共用一个弹窗也是同一个理由 ——
 * 两处各写一份，迟早出现「列表页拦住了、详情页放行了」。
 *
 * `blockReason` 优先取服务端给的 `actions.adjustBlockReason`（详情页有）；
 * 列表页没有该字段时由 `order` 的状态在端上做一次同口径的粗判，
 * 真正的一致性由服务端 D10 的 `30014/30003` 兜底。
 */
const props = defineProps<{
  modelValue: boolean;
  order: AdminOrderRow | null;
  /** 服务端下发的不可改原因（详情页传；列表页不传则本地粗判） */
  blockReason?: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'saved'): void;
}>();

const saving = ref(false);
const options = ref<OrderFilterOptions>({ groups: [], buildings: [], leaders: [], statuses: [] });

const form = reactive({
  action: 'change_quantity' as 'change_quantity' | 'change_building',
  quantity: 1,
  buildingId: undefined as number | undefined,
  reason: '',
});

/** 端上粗判：已支付订单改份数需走退款重下单 —— 与 D10 服务端口径一致 */
const localBlockReason = computed(() => {
  const o = props.order;
  if (!o) return null;
  if (o.status === 'pending_pay') return null;
  if (o.status === 'paid' && form.action === 'change_quantity') {
    return '订单已支付：改份数涉及补收或退款（支付通道动作，一期不支持）。请先强制退款，让用户重新下单';
  }
  if (o.status === 'paid') return null;
  return `当前状态「${o.statusText}」不支持改单`;
});

const blockReason = computed(() =>
  props.blockReason !== undefined ? props.blockReason : localBlockReason.value,
);

const sameGroupBuildings = computed(() => {
  const gid = props.order?.groupId;
  if (!gid) return [];
  return options.value.buildings.filter((b) => b.groupId === gid);
});

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    form.action = 'change_quantity';
    form.quantity = props.order?.quantity ?? 1;
    form.buildingId = undefined;
    form.reason = '';
    if (!options.value.buildings.length) {
      try {
        options.value = await fetchOrderFilterOptions();
      } catch {
        // 下拉失败不挡改单：份数改单用不到楼栋列表
      }
    }
  },
);

function reset(): void {
  form.reason = '';
}

async function submit(): Promise<void> {
  const o = props.order;
  if (!o) return;
  if (form.reason.trim().length < 2) {
    ElMessage.warning('请填写改单原因（至少 2 个字）');
    return;
  }
  if (form.action === 'change_building' && !form.buildingId) {
    ElMessage.warning('请选择目标办公楼');
    return;
  }

  saving.value = true;
  try {
    const res = await manualAdjustOrder({
      orderNo: o.orderNo,
      action: form.action,
      quantity: form.action === 'change_quantity' ? form.quantity : undefined,
      buildingId: form.action === 'change_building' ? form.buildingId : undefined,
      reason: form.reason.trim(),
    });
    emit('update:modelValue', false);
    await ElMessageBox.alert(res.tips || '改单成功', res.changed ? '改单成功' : '无变化', {
      confirmButtonText: '知道了',
    });
    emit('saved');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '改单失败');
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.dialog {
  &__head {
    margin-bottom: $space-2;
  }

  &__alert {
    margin-bottom: $space-3;
  }

  &__tip {
    margin-left: $space-2;
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}
</style>
