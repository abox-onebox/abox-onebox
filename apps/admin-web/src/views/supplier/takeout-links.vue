<template>
  <div class="page-container">
    <h2 class="page-container__title">外卖平台店铺链接配置（美团 / 淘宝闪购 / 京东）</h2>
    <p class="page-container__meta">
      原型 P33 · 模块 M34 · 接口：<b>扩展</b>（§6.4 原 D 系列未定义，按原型补齐并登记为扩展）·
      <code>PUT /admin/suppliers/:id/takeout-links</code> · 落点
      <code>ab_supplier.takeout_links</code>（JSON）
    </p>

    <!-- C8 是这一页最容易被误解的地方：可跳转 ≠ 合作商家 -->
    <el-alert type="warning" :closable="false" class="note">
      <template #title>
        <b>能跳转 ≠ 是合作伙伴</b> —— 本页配置的 6 家备选供应商外卖店铺，用户端只做<b>跳转</b>，
        <b>不参与平台结算</b>（无供价、无集散、无佣金）。 C8
        口径：平台<b>永不下发「哪些是备选商家」</b>这类名单，避免被解读为平台为第三方背书。
      </template>
    </el-alert>

    <!-- ─────────────── 供应商选择（路由带 supplierId 时自动选中） ─────────────── -->
    <div class="toolbar">
      <span class="toolbar__label">供应商</span>
      <el-select
        v-model="supplierId"
        class="toolbar__select"
        placeholder="选择要配置的供应商"
        filterable
        @change="onSupplierChange"
      >
        <el-option v-for="s in suppliers" :key="s.id" :label="s.name" :value="s.id" />
      </el-select>
      <div class="toolbar__right">
        <el-button @click="goSuppliers">返回供应商名录</el-button>
      </div>
    </div>

    <el-empty v-if="!supplierId" description="请先选择一家供应商，再配置其外卖平台店铺链接" />

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
        <span class="sub">已配置 {{ takeout.configuredCount }} / 3 个平台</span>
      </div>

      <!-- ─────────────── 三平台表单 ─────────────── -->
      <div class="cards">
        <div v-for="link in takeout.links" :key="link.platform" class="card">
          <div class="card__head">
            <span class="card__name">{{ link.platformLabel }}</span>
            <el-tag size="small" :type="link.configured ? 'success' : 'info'">
              {{ link.configured ? '已入驻' : '未入驻' }}
            </el-tag>
          </div>

          <p class="field-hint">
            未入驻是合法状态 —— 留空保存即视为该平台没有店铺，端上会显示灰色入口而不是隐藏整行
            （「缺京东」这件事必须看得见）。
          </p>

          <div class="field">
            <label class="field__label">店铺链接</label>
            <el-input
              v-model="forms[link.platform].url"
              placeholder="https://…（留空=未入驻）"
              :disabled="!canManage"
            />
          </div>

          <div class="field">
            <label class="field__label">店铺标识</label>
            <el-input
              v-model="forms[link.platform].shopId"
              placeholder="运营核对用（选填）"
              :disabled="!canManage"
            />
          </div>

          <div class="field">
            <label class="field__label">推荐入口</label>
            <el-radio-group v-model="recommended" :disabled="!canManage">
              <el-radio :value="link.platform">设为默认推荐</el-radio>
              <el-radio value="">不推荐</el-radio>
            </el-radio-group>
            <p class="field-hint">
              只影响用户端默认跳转哪个平台。<AbIcon name="warn-tri" size="16" />
              若把推荐平台的链接清空，服务端会<b>自动撤销推荐</b>
              （推荐一个不存在的店铺比没有推荐更糟）。
            </p>
          </div>
        </div>
      </div>

      <div class="actions">
        <el-tooltip
          :disabled="canManage"
          content="仅管理员 / 超级管理员可配置外卖链接"
          placement="top"
        >
          <span>
            <el-button type="primary" :loading="submitting" :disabled="!canManage" @click="submit">
              保存外卖链接
            </el-button>
          </span>
        </el-tooltip>
        <span class="sub">
          只提交改动过的平台（未改动的回传原值即可，服务端不动它）—— 传空字符串表示清空该平台。
        </span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  fetchAdminSuppliers,
  fetchSupplierDetail,
  setTakeoutLinks,
  type SupplierRow,
  type TakeoutOut,
} from '@/api/supplier';
import { ApiError } from '@/api/request';

const route = useRoute();
const router = useRouter();

const suppliers = ref<SupplierRow[]>([]);
const current = ref<SupplierRow | null>(null);
const supplierId = ref<number | undefined>(
  route.query.supplierId ? Number(route.query.supplierId) : undefined,
);

const loading = ref(false);
const submitting = ref(false);
const canManage = ref(false);

const takeout = reactive<TakeoutOut>({
  links: [],
  recommended: null,
  configuredCount: 0,
});

/** 三个平台各自一份表单 —— 固定 key，不用动态属性访问 */
const forms = reactive<Record<string, { url: string; shopId: string }>>({
  meituan: { url: '', shopId: '' },
  taobao: { url: '', shopId: '' },
  jd: { url: '', shopId: '' },
});

/** 空串 = 不推荐（不传 `recommended` 而非传 null，语义更明确） */
const recommended = ref<string>('');

const recommendedKey = computed(() => recommended.value || undefined);

function auditTag(status: string): 'info' | 'success' | 'danger' {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  return 'info';
}

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

function applyTakeout(out: TakeoutOut): void {
  takeout.links = out.links;
  takeout.recommended = out.recommended;
  takeout.configuredCount = out.configuredCount;
  for (const l of out.links) {
    const slot = forms[l.platform];
    if (slot) {
      slot.url = l.url ?? '';
      slot.shopId = l.shopId ?? '';
    }
  }
  recommended.value = out.recommended ?? '';
}

async function loadDetail(id: number): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchSupplierDetail(id);
    current.value = res.supplier;
    applyTakeout(res.takeout);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '加载供应商详情失败');
  } finally {
    loading.value = false;
  }
}

function onSupplierChange(id: number): void {
  // 换供应商时把 id 同步进地址栏，刷新后仍停在同一个对象上
  void router.replace({ path: '/supplier/takeout-links', query: { supplierId: String(id) } });
}

watch(supplierId, (id) => {
  if (id) void loadDetail(id);
});

async function submit(): Promise<void> {
  if (!supplierId.value) return;

  const payload: {
    meituan?: { url?: string | null; shopId?: string | null };
    taobao?: { url?: string | null; shopId?: string | null };
    jd?: { url?: string | null; shopId?: string | null };
    recommended?: string;
  } = {};

  for (const key of ['meituan', 'taobao', 'jd'] as const) {
    const f = forms[key];
    if (!f) continue;
    const url = f.url.trim();
    // 有链接才有意义；空串显式表达「清空该平台」
    payload[key] = { url: url || null, shopId: f.shopId.trim() || null };
  }

  const key = recommendedKey.value;
  if (key) payload.recommended = key;

  submitting.value = true;
  try {
    const out = await setTakeoutLinks(supplierId.value, payload);
    applyTakeout(out);
    ElMessage.success(`已保存，当前已入驻 ${out.configuredCount} / 3 个平台`);
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

// 桌面固定宽度（原为行内 `style="width: 260px"`）；窄屏由下方 S8 段改为 100%
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

.cards {
  display: grid;
  // ⚠️ 用 `min(320px, 100%)` 而不是裸 `320px`：320px 视口下可用宽度只剩约 292px，
  //    裸 320px 会让网格轨道**溢出容器**（横向滚动 / 卡片被裁）。`min()` 让轨道可收缩。
  grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr));
  gap: $space-3;
}

.card {
  padding: $space-3;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
}

.card__head {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-2;
}

.card__name {
  font-size: 15px;
  font-weight: 600;
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

.actions {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-top: $space-4;
}

.strong {
  font-weight: 600;
}

.sub {
  color: $c-text-weak;
  font-size: 11px;
}

.field-hint {
  margin: 4px 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}

/**
 * ── S8 · 窄屏（关键路径 1 / 2：供应商配外卖链接）──
 *
 * 祖先 `.ab-layout.is-narrow` 由 `layouts/default-layout.vue` 挂上
 * （唯一真源 = `composables/use-narrow.ts` 的 `NARROW_MAX`）。
 * ⚠️ 此处**故意不写 `@media`** —— 写第二份断点就与真源错开，而门禁看不见。
 */
.ab-layout.is-narrow {
  .toolbar {
    align-items: stretch;
  }

  // S9 补记：§9.3 的「拇指可达」此前只落在 `.el-button` 上 —— 390px 实测：工具栏下拉 32px、
  // **卡片里的链接输入框 32px**（后者连门禁视野都不在，最危险）。
  // EP 2.14 的控件高度**不统一**：输入框走 `--el-input-height: var(--el-component-size)`，
  // 而 `.el-select__wrapper` 里**写死** `min-height: 32px`（不吃任何变量）
  // ⇒ 直接命中两个 wrapper 本体，别绕变量。
  // ⚠️ 只给容器 `min-height` 会得到「外框 44 / 控件 32」—— 机械过检但观感已坏。
  //
  // ⚠️⚠️ 必须挂在**本地元素类名**（`.toolbar` / `.cards`）之下，**不能**直接挂在
  //      `.ab-layout.is-narrow` 之下：scoped CSS 把作用域属性加到 `:deep()` 前最后一个
  //      复合选择器上 —— 挂根节点会编译成 `.ab-layout.is-narrow[data-v-x] …`，
  //      而 `.ab-layout` 是 layout 组件的节点、拿不到本组件的 data-v ⇒ **规则整条失效**
  //      （现象＝下拉悄悄退回 32px，而门禁与构建全绿。实测踩过一次）。
  .toolbar,
  .cards {
    :deep(.el-select__wrapper),
    :deep(.el-input__wrapper) {
      min-height: 44px;
    }
  }

  // 供应商选择器占满整行（固定 260px 会把「返回供应商名录」挤下去）
  .toolbar__select {
    width: 100%;
  }

  .toolbar__right {
    width: 100%;
    margin-left: 0;

    :deep(.el-button) {
      width: 100%;
      min-height: 44px; // 移动端触摸目标
    }
  }

  // 三平台卡片：窄屏一列到底，不在 320px 视口下硬挤并排
  .cards {
    grid-template-columns: 1fr;
  }

  // 保存区：按钮与说明纵排，按钮满宽（拇指可达）
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
