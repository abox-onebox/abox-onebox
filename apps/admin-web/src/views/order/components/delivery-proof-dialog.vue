<script setup lang="ts">
/**
 * Q3 送达凭证 —— 后台「代传 / 查看 / 撤销」
 *
 * ⚠️ 为什么必须**先传图再挂单**：上传是**通用能力**（商品图 / 证照都走
 *    `POST /admin/uploads`），「这张图属于哪张配送单」才是配送域的事。
 *    合成一个 multipart 端点会把上传模块绑死在配送语义上
 *   （详见 `modules/media/media.controller.ts` 的设计说明）。
 *
 * ⛔ 类型中文一律读服务端下发的 `kindText` —— 端上不维护第二份映射，
 *    两套映射迟早会说不一样的话（与 `statusText` 同纪律）。
 *
 * ⛔ 撤销是**软删**：行仍保留。「这张凭证曾经存在、被谁撤了」本身是审计事实，
 *    真到举证那天被追问的往往正是这一条，硬删会让「传了又撤」彻底蒸发。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage, type UploadRequestOptions } from 'element-plus';

import {
  addDeliveryProof,
  fetchDeliveryProofs,
  revokeDeliveryProof,
  uploadDeliveryMedia,
  type DeliveryProofCreateBody,
  type DeliveryProofItem,
  type DeliveryProofListResult,
} from '@/api/delivery';
import { ApiError } from '@/api/request';
import { displayOr, formatDateTime } from '@/utils/format';

const props = defineProps<{
  modelValue: boolean;
  deliveryId: number | null;
  /** 标题下的上下文（楼群 + 发货日），避免运营点错单还看不出来 */
  subtitle: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

const loading = ref(false);
const uploading = ref(false);
const data = ref<DeliveryProofListResult | null>(null);
/** 勾上会连已撤销的一起显示（举证时可能要看谁撤过） */
const withRevoked = ref(false);

const kind = ref<NonNullable<DeliveryProofCreateBody['kind']>>('photo');
const remark = ref('');

const KIND_OPTIONS = [
  { value: 'photo', label: '现场照' },
  { value: 'sign', label: '签收单' },
  { value: 'other', label: '其它' },
] as const;

const title = computed(() =>
  props.deliveryId === null ? '送达凭证' : `送达凭证 · 配送单 #${props.deliveryId}`,
);

async function load(): Promise<void> {
  if (props.deliveryId === null) return;
  loading.value = true;
  try {
    data.value = await fetchDeliveryProofs(props.deliveryId, withRevoked.value ? 'all' : 'alive');
  } catch (e) {
    data.value = null;
    ElMessage.error(e instanceof ApiError ? e.message : '凭证列表加载失败');
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.modelValue, props.deliveryId] as const,
  ([open]) => {
    if (open) void load();
  },
  { immediate: true },
);

watch(withRevoked, () => void load());

/** 自定义上传：先拿 url，再挂到本配送单（两步，不能省） */
async function onUpload(opts: UploadRequestOptions): Promise<void> {
  if (props.deliveryId === null) return;
  const file = opts.file as File;
  uploading.value = true;
  try {
    const { url } = await uploadDeliveryMedia(file);
    await addDeliveryProof(props.deliveryId, {
      url,
      kind: kind.value,
      ...(remark.value.trim() ? { remark: remark.value.trim() } : {}),
    });
    remark.value = '';
    ElMessage.success('已上传并挂到本配送单');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : `上传失败：${file.name}`);
  } finally {
    uploading.value = false;
  }
}

async function onRevoke(item: DeliveryProofItem): Promise<void> {
  if (props.deliveryId === null) return;
  try {
    await revokeDeliveryProof(props.deliveryId, item.id);
    ElMessage.success('已撤销（记录仍保留，可追溯）');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '撤销失败');
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="700px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p class="pf__sub">{{ subtitle }}</p>

    <!-- 上传区：类型 + 备注，避免几张图传上去分不清哪张是什么 -->
    <div class="pf__up">
      <el-select v-model="kind" size="small" class="pf__kind">
        <el-option v-for="o in KIND_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-input
        v-model="remark"
        size="small"
        class="pf__remark"
        placeholder="备注（可选，如「3 号楼前台签收」）"
        maxlength="100"
        clearable
      />
      <el-upload class="pf__btn" accept="image/*" :show-file-list="false" :http-request="onUpload">
        <el-button type="primary" size="small" :loading="uploading">选择图片上传</el-button>
      </el-upload>
    </div>

    <el-alert v-if="!loading && data && !data.list.length" type="info" :closable="false">
      <template #title>这张配送单还没有任何送达凭证。</template>
    </el-alert>

    <div v-loading="loading" class="pf__list">
      <div v-for="item in data?.list ?? []" :key="item.id" class="pf__item">
        <a :href="item.url" target="_blank" rel="noopener" class="pf__img">
          <img :src="item.url" alt="送达凭证" />
        </a>
        <div class="pf__meta">
          <p class="pf__line">
            <el-tag size="small" :type="item.revokedAt ? 'info' : 'success'">
              {{ item.kindText }}
            </el-tag>
            <el-tag v-if="item.revokedAt" size="small" type="danger">已撤销</el-tag>
          </p>
          <p class="pf__line pf__line--dim">
            上传 {{ formatDateTime(item.createdAt) }}
            <template v-if="item.revokedAt"> · 撤销 {{ formatDateTime(item.revokedAt) }}</template>
          </p>
          <p v-if="item.remark" class="pf__line">{{ item.remark }}</p>
          <p class="pf__line pf__line--dim">上传人 #{{ displayOr(item.uploadedBy, '未知') }}</p>
        </div>
        <el-button v-if="!item.revokedAt" link type="danger" size="small" @click="onRevoke(item)">
          撤销
        </el-button>
      </div>
    </div>

    <div class="pf__foot">
      <el-checkbox v-model="withRevoked">显示已撤销</el-checkbox>
      <span class="pf__count">
        有效 <b>{{ data?.aliveCount ?? 0 }}</b> 张
        <template v-if="data && data.count !== data.aliveCount">
          （当前列表 {{ data.count }} 张）
        </template>
      </span>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.pf__sub {
  margin: 0 0 12px;
  color: var(--el-text-color-secondary);
  font-size: $fs-caption;
}
.pf__up {
  display: flex;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-3;
}
.pf__kind {
  width: 110px;
}
.pf__remark {
  flex: 1;
}
.pf__list {
  margin-top: $space-2;
  max-height: 380px;
  overflow-y: auto;
}
.pf__item {
  display: flex;
  gap: $space-2;
  align-items: flex-start;
  padding: $space-2 0;
  border-bottom: 1px solid var(--el-border-color-lighter);

  &:last-child {
    border-bottom: none;
  }
}
.pf__img {
  flex: 0 0 96px;
  height: 72px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: $radius-sm;
  background: var(--el-fill-color-lighter);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}
.pf__meta {
  flex: 1;
  min-width: 0;
}
.pf__line {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  margin: 0 0 4px;
  font-size: $fs-caption;
  line-height: 1.6;

  &--dim {
    color: var(--el-text-color-secondary);
  }
}
.pf__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: $space-2;
  padding-top: $space-2;
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: $fs-caption;
  color: var(--el-text-color-secondary);
}
.pf__count b {
  color: var(--el-text-color-primary);
}
</style>
