<template>
  <div class="page-container">
    <h2 class="page-container__title">门店实拍 / 证照照片配置（方案B 照片墙）</h2>
    <p class="page-container__meta">
      原型 P33 · 模块 M34 · 接口：<b>扩展</b>（与外卖链接同属供应商维度运营自助配置）·
      <code>POST /admin/uploads</code>（通用上传）+
      <code>PUT /admin/suppliers/:id/photos</code>（整组替换）· 落点
      <code>ab_supplier.store_photos</code>（JSON 数组 {url,category,caption}）
    </p>

    <!-- 合规与上线阻塞：照片墙真能看见，依赖这两条外部前置，写在这里比写在代码注释里更显性 -->
    <el-alert type="warning" :closable="false" class="note">
      <template #title>
        <b>端上可见性的两条前置（非代码）</b> —— 本页只负责把图存进
        <code>store_photos</code>，但小程序「门店实拍」网格真正显示远程图，还须： <b>①</b> 域名
        <code>xunlizhinian.cn</code> 完成 ICP 备案； <b>②</b> 小程序后台配置
        <code>downloadFile</code> 合法域名白名单。 备案 / 白名单未就绪时，端上图片会
        404，但版式不崩（无图整块不渲染）。
        <br />
        合规侧：123 / 124 号令要求平台公示入网商户证照与门店实拍，本页上传的图正是为此 ——
        「能上传」即是「在履行公示义务」，与外卖链接的「仅跳转」性质不同。
      </template>
    </el-alert>

    <!-- ─────────────── 供应商选择（路由带 supplierId 时自动选中） ─────────────── -->
    <div class="toolbar">
      <span class="toolbar__label">供应商</span>
      <el-select
        v-model="supplierId"
        class="toolbar__select"
        placeholder="选择要配置实拍的供应商"
        filterable
        @change="onSupplierChange"
      >
        <el-option v-for="s in suppliers" :key="s.id" :label="s.name" :value="s.id" />
      </el-select>
      <div class="toolbar__right">
        <el-button @click="goSuppliers">返回供应商名录</el-button>
      </div>
    </div>

    <el-empty v-if="!supplierId" description="请先选择一家供应商，再维护其门店实拍照片" />

    <template v-else>
      <!-- ─────────────── 供应商快照（避免改错对象） ─────────────── -->
      <div v-if="current" class="snapshot">
        <span class="strong">{{ current.name }}</span>
        <el-tag size="small" :type="auditTag(current.auditStatus)">{{
          current.auditStatusLabel
        }}</el-tag>
        <el-tag size="small" :type="current.canServe ? 'success' : 'info'">
          {{ current.canServe ? '可出餐' : '不可出餐' }}
        </el-tag>
        <span class="snapshot__spacer" />
        <span class="sub">已配置 {{ photos.length }} 张照片</span>
      </div>

      <!-- ─────────────── 上传 + 照片网格 ─────────────── -->
      <div class="actions actions--top">
        <el-tooltip
          :disabled="canManage"
          content="仅管理员 / 超级管理员可上传与配置实拍"
          placement="top"
        >
          <span>
            <el-button
              type="primary"
              :loading="uploading"
              :disabled="!canManage || uploading"
              @click="pickFiles"
            >
              {{ uploading ? `上传中 ${uploadedCount}/${pendingCount}` : '上传实拍' }}
            </el-button>
          </span>
        </el-tooltip>
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          multiple
          class="hidden"
          @change="onPick"
        />
        <span class="sub upload-hint">
          支持多选图片（JPG / PNG / WEBP / GIF / BMP / HEIC 等）；单个 ≤ 10MB，单次最多 20 张
          （与后端上限一致，超出会被忽略）。选多张会依次上传并追加；分类与说明可在每张图下方单独设置。
        </span>
      </div>

      <el-empty v-if="!photos.length" description="还没有照片，点上方「上传实拍」添加" />

      <div v-else class="grid">
        <div v-for="(p, i) in photos" :key="i" class="card">
          <div class="card__thumb">
            <img :src="p.url" class="card__img" alt="门店实拍" loading="lazy" />
          </div>

          <div class="field">
            <label class="field__label">分类</label>
            <el-select
              v-model="p.category"
              class="field__select"
              placeholder="未分类"
              :disabled="!canManage"
              clearable
            >
              <el-option v-for="c in categoryOptions" :key="c" :label="c" :value="c" />
            </el-select>
          </div>

          <div class="field">
            <label class="field__label">说明（选填）</label>
            <el-input
              v-model="p.caption"
              placeholder="如：前厅就餐区"
              :disabled="!canManage"
              maxlength="40"
              show-word-limit
            />
          </div>

          <div class="card__ops">
            <el-button link type="primary" :disabled="!canManage || i === 0" @click="move(i, -1)">
              上移
            </el-button>
            <el-button
              link
              type="primary"
              :disabled="!canManage || i === photos.length - 1"
              @click="move(i, 1)"
            >
              下移
            </el-button>
            <el-button link type="danger" :disabled="!canManage" @click="remove(i)">
              删除
            </el-button>
          </div>
        </div>
      </div>

      <div class="actions">
        <el-tooltip
          :disabled="canManage"
          content="仅管理员 / 超级管理员可保存实拍配置"
          placement="top"
        >
          <span>
            <el-button type="primary" :loading="submitting" :disabled="!canManage" @click="submit">
              保存照片墙
            </el-button>
          </span>
        </el-tooltip>
        <span class="sub">
          整组替换：所见即所得，改动（增 / 删 / 调整顺序 / 改说明）后整体回传；
          保存即覆盖该供应商全部实拍，传空列表 = 清空照片墙。
        </span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  fetchAdminSuppliers,
  fetchSupplierDetail,
  setStorePhotos,
  uploadAdminFile,
  type SupplierRow,
} from '@/api/supplier';
import type { SupplierPhoto } from '@abox/shared-types';
import { ApiError } from '@/api/request';

const CATEGORY_OPTIONS = ['营业执照', '门头', '大厅', '后厨', '仓库', '其它'];

// 与后端对齐的硬上限（前端先于上传拦一道，给出明确提示）
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 后端 FileInterceptor limits.fileSize = 10MB
const MAX_PHOTOS = 20; // 后端 SetStorePhotosDto @ArrayMaxSize(20)
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;

const route = useRoute();
const router = useRouter();

const suppliers = ref<SupplierRow[]>([]);
const current = ref<SupplierRow | null>(null);
const supplierId = ref<number | undefined>(
  Array.isArray(route.query.supplierId)
    ? Number(route.query.supplierId[0])
    : route.query.supplierId
      ? Number(route.query.supplierId)
      : undefined,
);

const loading = ref(false);
const submitting = ref(false);
const canManage = ref(false);

const photos = ref<SupplierPhoto[]>([]);
const categoryOptions = CATEGORY_OPTIONS;

// 上传状态
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const pendingCount = ref(0);
const uploadedCount = ref(0);

const auditTag = (status: string): 'info' | 'success' | 'danger' => {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  return 'info';
};

/** 供应商下拉：一次拉全量（供应商数量是小体量主数据，不是订单） */
async function loadSuppliers(): Promise<void> {
  try {
    const res = await fetchAdminSuppliers({ page: 1, pageSize: 100 });
    suppliers.value = res.list;
    canManage.value = res.actions.canManage;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '加载供应商列表失败');
  }
}

async function loadDetail(id: number): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchSupplierDetail(id);
    current.value = res.supplier;
    photos.value = (res.photos ?? []).map((p) => ({
      url: p.url,
      category: p.category ?? null,
      caption: p.caption ?? null,
    }));
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '加载供应商详情失败');
  } finally {
    loading.value = false;
  }
}

function onSupplierChange(id: number): void {
  // 换供应商时把 id 同步进地址栏，刷新后仍停在同一个对象上
  void router.replace({ path: '/supplier/store-photos', query: { supplierId: String(id) } });
}

watch(supplierId, (id) => {
  if (id) void loadDetail(id);
});

function pickFiles(): void {
  fileInput.value?.click();
}

async function onPick(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  // 清空 value，保证选同一文件也能再次触发 change
  input.value = '';
  if (!files.length) return;
  if (!supplierId.value) {
    ElMessage.warning('请先选择供应商');
    return;
  }

  // ── 上传前校验：类型 / 大小 / 总数 ──
  const okFiles: File[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    const isImage =
      (typeof f.type === 'string' && f.type.startsWith('image/')) || IMAGE_EXT_RE.test(f.name);
    if (!isImage) {
      rejected.push(`${f.name}（非图片）`);
      continue;
    }
    if (f.size > MAX_FILE_SIZE) {
      rejected.push(`${f.name}（超过 10MB）`);
      continue;
    }
    okFiles.push(f);
  }

  // 总数不超过后端 @ArrayMaxSize(20)，超出部分丢弃并提示
  const remaining = MAX_PHOTOS - photos.value.length;
  let toUpload = okFiles;
  if (okFiles.length > remaining) {
    toUpload = okFiles.slice(0, Math.max(remaining, 0));
    rejected.push(`已达上限 ${MAX_PHOTOS} 张，超出部分未上传`);
  }

  // 把被拒的文件一次性告知，而不是静默吞掉
  if (rejected.length) {
    ElMessage.warning(`已忽略 ${rejected.length} 个文件：${rejected.join('；')}`);
  }
  if (!toUpload.length) {
    uploading.value = false;
    return;
  }

  uploading.value = true;
  pendingCount.value = toUpload.length;
  uploadedCount.value = 0;
  let ok = 0;
  try {
    for (const f of toUpload) {
      const { url } = await uploadAdminFile(f);
      photos.value.push({ url, category: null, caption: null });
      uploadedCount.value += 1;
      ok += 1;
    }
    if (ok > 0) ElMessage.success(`已上传 ${ok} 张，记得点「保存照片墙」才会写入`);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '上传失败（部分可能已上传）');
  } finally {
    uploading.value = false;
  }
}

function move(i: number, dir: -1 | 1): void {
  const j = i + dir;
  if (j < 0 || j >= photos.value.length) return;
  const arr = photos.value;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function remove(i: number): void {
  photos.value.splice(i, 1);
}

async function submit(): Promise<void> {
  if (!supplierId.value) return;

  // 下发前再过滤一次坏图（url 为空），避免把脏数据写回
  const payload: SupplierPhoto[] = photos.value
    .filter((p) => !!p.url && p.url.trim().length > 0)
    .map((p) => ({ url: p.url, category: p.category ?? null, caption: p.caption ?? null }));

  submitting.value = true;
  try {
    const out = await setStorePhotos(supplierId.value, payload);
    photos.value = out.photos.map((p) => ({
      url: p.url,
      category: p.category ?? null,
      caption: p.caption ?? null,
    }));
    ElMessage.success(`已保存，当前共 ${out.photos.length} 张照片`);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    submitting.value = false;
  }
}

function goSuppliers(): void {
  void router.push('/supplier/list');
}

onMounted(async () => {
  await loadSuppliers();
  if (supplierId.value) await loadDetail(supplierId.value);
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

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-3;
}

.toolbar__label {
  color: $c-text-weak;
  font-size: $fs-caption;
}

// 桌面固定宽度；窄屏由下方 S8 段改为 100%
.toolbar__select {
  width: 260px;
}

.toolbar__right {
  margin-left: auto;
  display: flex;
  gap: $space-2;
}

.snapshot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-3;
  padding: $space-2 $space-3;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
}

.snapshot__spacer {
  margin-left: auto;
}

.actions {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-top: $space-4;

  &--top {
    margin-top: 0;
    margin-bottom: $space-3;
  }
}

.hidden {
  display: none;
}

.grid {
  display: grid;
  // 与外卖链接同款 `min()` 防 320px 视口溢出
  grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr));
  gap: $space-3;
}

.card {
  padding: $space-3;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
}

.card__thumb {
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.04);
  margin-bottom: $space-2;
}

.card__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.field {
  margin-top: $space-2;
}

.field__label {
  display: block;
  margin-bottom: 4px;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.field__select {
  width: 100%;
}

.card__ops {
  display: flex;
  justify-content: space-between;
  gap: $space-1;
  margin-top: $space-2;
}

.strong {
  font-weight: 600;
}

.sub {
  color: $c-text-weak;
  font-size: 11px;
}

// 上传约束提示：比普通说明更显眼一点，提醒运营这是硬限制
.upload-hint {
  display: block;
  margin-top: $space-1;
  color: #b45309;
  font-size: 11px;
  line-height: 1.5;
}

/**
 * ── S8 · 窄屏（门店实拍上传关键路径）──
 * 祖先 `.ab-layout.is-narrow` 由 `layouts/default-layout.vue` 挂上。
 * ⚠️ 此处**故意不写 `@media`** —— 写第二份断点就与真源错开，而门禁看不见。
 */
.ab-layout.is-narrow {
  .toolbar {
    align-items: stretch;
  }

  // 只给本地元素类名挂深选择器（scoped 属性加在 :deep() 前最后一个复合选择器上）
  .toolbar,
  .grid {
    :deep(.el-select__wrapper),
    :deep(.el-input__wrapper) {
      min-height: 44px;
    }
  }

  .toolbar__select {
    width: 100%;
  }

  .toolbar__right {
    width: 100%;
    margin-left: 0;

    :deep(.el-button) {
      width: 100%;
      min-height: 44px;
    }
  }

  // 窄屏一列到底
  .grid {
    grid-template-columns: 1fr;
  }

  .actions {
    flex-direction: column;
    align-items: stretch;

    :deep(.el-button) {
      width: 100%;
      min-height: 44px;
    }
  }
}
</style>
