<template>
  <div class="page-container">
    <h2 class="page-container__title">系统配置</h2>
    <p class="page-container__meta">
      原型页 / 模块：P36 · M37 ｜ 接口：D57 读取 / D58 批量更新（整批原子 · 写日志 · 二次确认）
    </p>

    <!-- ⭐ 履约成本未登记 → 经营毛利只能是上限值（与 D47 看板同一判据） -->
    <el-alert
      v-if="meta?.settlementCost.warning"
      type="warning"
      :closable="false"
      show-icon
      class="block"
    >
      <template #title>经营毛利当前是「上限值」</template>
      <p class="block__text">{{ meta.settlementCost.warning }}</p>
    </el-alert>

    <el-alert type="info" :closable="false" show-icon class="block">
      <template #title>配置口径</template>
      <p class="block__text">{{ meta?.note }}</p>
    </el-alert>

    <div class="toolbar">
      <span class="toolbar__stat">
        共 {{ meta?.wiringSummary.total ?? 0 }} 项 ｜ 已接线 {{ meta?.wiringSummary.live ?? 0 }} ｜
        未接线 {{ meta?.wiringSummary.unwired ?? 0 }}（只作口径记录）
      </span>
      <el-button :disabled="!dirtyCount || saving" @click="resetAll">放弃修改</el-button>
      <el-button type="primary" :loading="saving" :disabled="!dirtyCount" @click="save">
        保存{{ dirtyCount ? `（${dirtyCount} 项）` : '' }}
      </el-button>
    </div>

    <el-card v-for="g in groups" :key="g.group" shadow="never" class="group">
      <template #header>
        <div class="group__head">
          <span class="group__title">{{ g.label }}</span>
          <el-tag size="small" type="info" effect="plain">{{ g.items.length }} 项</el-tag>
        </div>
      </template>

      <p class="group__desc">{{ g.description }}</p>

      <div
        v-for="item in g.items"
        :key="item.key"
        class="row"
        :class="{ 'row--dirty': isDirty(item) }"
      >
        <div class="row__info">
          <div class="row__title">
            <span class="row__label">{{ item.label }}</span>
            <el-tag v-if="item.wiring === 'unwired'" size="small" type="warning" effect="plain">
              未接线 · 改了不生效
            </el-tag>
            <el-tag v-else-if="item.wiring === 'policy'" size="small" type="info" effect="plain">
              策略标识
            </el-tag>
            <el-tag v-if="item.registered === false" size="small" type="danger" effect="plain">
              未登记
            </el-tag>
            <el-tag v-if="isDirty(item)" size="small" type="success" effect="plain">已修改</el-tag>
          </div>

          <p class="row__desc">{{ item.description }}</p>
          <p v-if="item.unwiredReason" class="row__warn">{{ item.unwiredReason }}</p>

          <p class="row__meta">
            <span>影响：{{ item.consumedBy }}</span>
            <span v-if="rangeText(item)">｜ 取值：{{ rangeText(item) }}</span>
            <span>｜ {{ valueSourceText(item) }}</span>
          </p>
          <p class="row__key">{{ item.key }}</p>
        </div>

        <div class="row__control">
          <el-select
            v-if="item.editable && item.valueType === 'enum'"
            v-model="draft[item.key]"
            class="control"
            :disabled="saving"
          >
            <el-option
              v-for="o in item.options ?? []"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>

          <el-input
            v-else-if="item.editable"
            v-model="draft[item.key]"
            class="control"
            :disabled="saving"
          >
            <template v-if="item.unit" #append>{{ item.unit }}</template>
          </el-input>

          <!-- 未接线 / 策略标识：只读展示，不留一个点了报错的假输入框 -->
          <div v-else class="row__readonly">
            {{ item.value || '（空）'
            }}<span v-if="item.unit" class="row__unit">{{ item.unit }}</span>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 系统配置（D57 读 / D58 批量写）· 见《接口规范 v1.0》§6.7
 *
 * ## 三条设计决定
 * 1. **文案与范围全部来自服务端**（`config.specs.ts` 是唯一真相）。
 *    本页不写「这些配置项叫什么名字」，只按 `valueType` 选控件、按 `editable` 置灰 ——
 *    否则运营看到的名字、与代码里读的键，迟早对不上。
 * 2. **只读项保留展示**：`wiring='unwired'` 的项（遗留口径记录，如
 *    `distribution_center.*`）改了不生效，但不能删 —— 它们记录了「这个参数定的是多少」。
 *    页面如实标注原因，而不是给一个「看起来能改、改完没反应」的输入框。
 *    ⚠️ 分组名与项数**不在本页硬编码**（服务端 `config.specs.ts` 是唯一真相）：
 *    2026-09-17 缺陷 #49 接线后，5 个时刻类配置从「未接线」组移到新增的「业务时刻」组，
 *    本页无需任何改动即正确渲染 —— 这正是「文案与范围全部来自服务端」的价值。
 * 3. **保存前二次确认（D58 要求）**：弹窗逐项列出「前 → 后」。
 *    配置是**全局口径**，改售价 / 费率类会立刻影响全平台计算，
 *    不做确认等于默许误触。
 *
 * ⚠️ 前端**不复制**服务端校验规则（min/max 只作提示）。判定权威在服务端：
 *    它要拦白名单外的键、不可写的键、以及清空数字框这类危险输入。
 */
import { computed, h, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import { fetchSystemConfigs, updateSystemConfigs } from '@/api/system';
import type { ConfigItemView, ConfigListView } from '@/api/system';
import { ApiError } from '@/api/request';

const loading = ref(false);
const saving = ref(false);
const meta = ref<ConfigListView['meta'] | null>(null);
const groups = ref<ConfigListView['groups']>([]);

/** 编辑草稿：`key → 当前输入值`（初始 = 服务端值） */
const draft = reactive<Record<string, string>>({});

const allItems = computed<ConfigItemView[]>(() => groups.value.flatMap((g) => g.items));

const dirtyItems = computed(() => allItems.value.filter(isDirty));
const dirtyCount = computed(() => dirtyItems.value.length);

function isDirty(item: ConfigItemView): boolean {
  return (draft[item.key] ?? item.value) !== item.value;
}

/** 取值范围的展示文案（服务端给 min/max，端上只负责拼） */
function rangeText(item: ConfigItemView): string {
  if (item.maxLength !== undefined) return `最多 ${item.maxLength} 字`;
  if (item.min === undefined && item.max === undefined) return '';
  const unit = item.unit ?? '';
  if (item.min !== undefined && item.max !== undefined) return `${item.min} – ${item.max}${unit}`;
  if (item.min !== undefined) return `≥ ${item.min}${unit}`;
  return `≤ ${item.max}${unit}`;
}

/** 「这个值从哪来」—— 库内没有的键说明当前走的是代码兜底值 */
function valueSourceText(item: ConfigItemView): string {
  if (item.valueSource === 'fallback') return '尚未落库 · 当前取代码兜底值';
  if (item.untouched) return '沿用初始值 · 未调整过';
  return item.updatedAt ? `最近更新 ${item.updatedAt}` : '已登记';
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchSystemConfigs();
    groups.value = res.groups;
    meta.value = res.meta;

    // 重置草稿（含放弃修改、保存后刷新两条路径）
    for (const key of Object.keys(draft)) delete draft[key];
    for (const item of allItems.value) draft[item.key] = item.value;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '系统配置加载失败');
  } finally {
    loading.value = false;
  }
}

function resetAll(): void {
  for (const item of allItems.value) draft[item.key] = item.value;
  ElMessage.info('已放弃未保存的修改');
}

async function save(): Promise<void> {
  const changes = dirtyItems.value.map((item) => ({
    item,
    key: item.key,
    before: item.value,
    value: draft[item.key] ?? '',
  }));
  if (!changes.length) return;

  // 二次确认：逐项「前 → 后」。用 VNode 而非 HTML 字符串 —— 配置值里可能含尖括号，
  // 拼 HTML 就等于把运营的输入当代码渲染（Vue 会自动转义文本节点）。
  const confirmed = await ElMessageBox.confirm(
    h(
      'div',
      { class: 'confirm' },
      changes.map((c) =>
        h('div', { class: 'confirm__line' }, `${c.item.label}：${c.before} → ${c.value}`),
      ),
    ),
    `确认更新 ${changes.length} 项系统配置？`,
    {
      type: 'warning',
      confirmButtonText: '确认更新',
      cancelButtonText: '取消',
      customClass: 'config-confirm',
    },
  )
    .then(() => true)
    .catch(() => false);

  if (!confirmed) return;

  saving.value = true;
  try {
    const res = await updateSystemConfigs(changes.map((c) => ({ key: c.key, value: c.value })));
    ElMessage.success(res.note);
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(reload);
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-4;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.block {
  margin-bottom: $space-3;

  &__text {
    margin: 0;
    line-height: 1.7;
  }
}

.toolbar {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-bottom: $space-3;

  &__stat {
    flex: 1;
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.group {
  margin-bottom: $space-4;
  border-color: $c-border;

  &__head {
    display: flex;
    align-items: center;
    gap: $space-2;
  }

  &__title {
    font-size: $fs-h2;
    color: $c-text;
  }

  &__desc {
    margin: 0 0 $space-3;
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.7;
  }
}

.row {
  display: flex;
  align-items: flex-start;
  gap: $space-4;
  padding: $space-3 0;
  border-top: 1px solid $c-border;

  &:first-of-type {
    border-top: none;
  }

  &--dirty {
    background: rgba(201, 168, 118, 0.12);
    border-radius: $radius-sm;
    padding-left: $space-2;
    padding-right: $space-2;
  }

  &__info {
    flex: 1;
    min-width: 0;
  }

  &__title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: $space-1;
  }

  &__label {
    font-size: $fs-body;
    color: $c-text;
  }

  &__desc {
    margin: $space-1 0 0;
    color: $c-text;
    font-size: $fs-caption;
    line-height: 1.7;
  }

  &__warn {
    margin: $space-1 0 0;
    color: $c-warning;
    font-size: $fs-caption;
    line-height: 1.7;
  }

  &__meta {
    margin: $space-1 0 0;
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.7;
  }

  &__key {
    margin: $space-1 0 0;
    color: $c-text-weak;
    font-size: $fs-caption;
    font-family: Consolas, Monaco, monospace;
    opacity: 0.7;
  }

  &__control {
    flex: 0 0 auto;
    padding-top: $space-1;
  }

  &__readonly {
    min-width: 140px;
    padding: $space-1 $space-2;
    border: 1px dashed $c-border;
    border-radius: $radius-sm;
    background: $c-bg;
    color: $c-text-weak;
    font-size: $fs-body;
    text-align: right;
  }

  &__unit {
    margin-left: $space-1;
    font-size: $fs-caption;
  }
}

.control {
  width: 240px;
}
</style>
