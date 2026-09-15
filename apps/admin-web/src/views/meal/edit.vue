<template>
  <div class="page-container">
    <h2 class="page-container__title">新建套餐 / 存为模板</h2>
    <p class="page-container__meta">
      模块：M31-02 / M31-03 · 原型 P28 · 接口：D7 存为模板 · 落库
      <code>ab_set_meal</code> + <code>ab_set_meal_item</code>
    </p>

    <el-row :gutter="20">
      <!-- ─────────────── 左：基本信息 + 选菜 ─────────────── -->
      <el-col :xs="24" :lg="16">
        <el-card shadow="never" class="card">
          <template #header><span class="card__title">基本信息</span></template>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="套餐名" required>
              <el-input
                v-model="form.name"
                maxlength="64"
                placeholder="如：红烧肉套餐"
                show-word-limit
              />
            </el-form-item>
            <el-form-item label="售价">
              <el-input-number
                v-model="form.price"
                :min="0.01"
                :max="9999"
                :precision="2"
                :step="0.1"
                style="width: 200px"
              />
              <span class="tip"> 留空 = 服务端取系统配置售价（C1 锁定 ¥{{ UNIT_PRICE }}） </span>
            </el-form-item>
            <el-form-item label="一句话介绍">
              <el-input
                v-model="form.oneLiner"
                maxlength="128"
                placeholder="招牌红烧肉 · 一饭四菜"
              />
            </el-form-item>
            <el-form-item label="封面图">
              <el-input v-model="form.coverUrl" placeholder="图片 URL（可留空）" />
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never" class="card">
          <template #header>
            <div class="card__header">
              <span class="card__title">一饭四菜 · 选菜</span>
              <el-button link type="primary" @click="clearItems">清空</el-button>
            </div>
          </template>

          <el-alert type="info" :closable="false" show-icon class="card__alert">
            <p>
              <strong>档位</strong>决定它在套餐里的位置：主荤 / 半荤 / 素菜 / 汤 / 主食。
              同一道菜不能重复出现（「两道素菜」须是两道<strong>不同</strong>的素菜）。
            </p>
            <p>
              <strong>供应商与成本无需手填</strong>：提交时由菜品反查
              <code>ab_dish.supplier_id</code>、由菜品供价求和 —— 手填迟早会填出「记着 A 家的菜、
              却算着 B 家的钱」，结算时才发现对不上。
            </p>
          </el-alert>

          <div v-for="slot in slots" :key="slot.value" class="slot">
            <div class="slot__label">
              <span class="slot__name">{{ slot.label }}</span>
              <span v-if="slot.value === 1" class="slot__req">核心</span>
            </div>
            <el-select
              v-model="picked[slot.value]"
              placeholder="选择菜品（可留空表示不配该档）"
              filterable
              clearable
              style="flex: 1"
              :disabled="!dishOptions.length"
            >
              <el-option
                v-for="d in dishOptions"
                :key="d.id"
                :label="`${d.name} · ${d.supplierName ?? '—'} · ¥${fenToYuan(d.costPriceFen)}`"
                :value="d.id"
                :disabled="isDishUsed(d.id, slot.value)"
              />
            </el-select>
            <div class="slot__meta">
              <span
                v-if="picked[slot.value] && dishMap.get(picked[slot.value]!)"
                class="slot__cost"
              >
                ¥{{ fenToYuan(dishMap.get(picked[slot.value]!)?.costPriceFen ?? 0) }}
              </span>
              <span v-else class="muted">—</span>
            </div>
          </div>

          <div v-if="!dishOptions.length && !loadingDishes" class="muted empty">
            菜品库为空或全部下架 —— 菜品由供应商在商家端上架（D23–D32）。
          </div>
        </el-card>
      </el-col>

      <!-- ─────────────── 右：汇总 ─────────────── -->
      <el-col :xs="24" :lg="8">
        <el-card shadow="never" class="card card--sticky">
          <template #header><span class="card__title">成本预览</span></template>

          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="选中一饭四菜">{{ pickedCount }} 项</el-descriptions-item>
            <el-descriptions-item label="成本合计（供价求和）">
              <strong>¥{{ fenToYuan(costTotalFen) }}</strong>
            </el-descriptions-item>
            <el-descriptions-item label="售价">
              {{ form.price ? `¥${form.price.toFixed(2)}` : `¥${UNIT_PRICE.toFixed(2)}（缺省）` }}
            </el-descriptions-item>
            <el-descriptions-item label="参考毛利（仅减供价）">
              <span :class="grossFen >= 0 ? 'ok' : 'bad'">¥{{ fenToYuan(grossFen) }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-alert type="warning" :closable="false" class="card__alert" show-icon>
            C9 结算等式：售价 = 供应商供价 + 场地费 + 打包人工 + 配送费 + 团长佣金 + 平台毛利。
            此处「参考毛利」<strong>只减了供价</strong> —— 场地费 / 打包 / 配送 / 佣金（8–12%）
            尚未扣除，真正的毛利请看财务结算页，不要拿这个数字定售价。
          </el-alert>

          <el-divider />

          <p class="side-note">
            <strong>另存现有套餐</strong
            >：若只想在某个已有套餐上改两道菜，用下面的「基于已有套餐另存」， 不必重新挑一遍。
          </p>
          <el-select
            v-model="form.sourceSetMealId"
            placeholder="不基于任何套餐"
            filterable
            clearable
            style="width: 100%"
            @change="onSourceChange"
          >
            <el-option
              v-for="t in templates"
              :key="t.id"
              :label="`${t.name}（${t.dishCount} 菜）`"
              :value="t.id"
            />
          </el-select>

          <div class="actions">
            <el-button @click="reset">重置</el-button>
            <el-button type="primary" :loading="submitting" @click="submit">
              保存为套餐模板
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
/**
 * 新建套餐 / 存为模板（D7）· 原型 P28
 *
 * ## 页面与接口的对应关系
 * 「一饭四菜」在本页就是**五个档位各选一道菜**（slot 1–5：主荤/半荤/素菜/汤/主食），
 * 提交走 D7 `POST /admin/meal/templates`，落 `ab_set_meal` + `ab_set_meal_item`。
 *
 * ## 两个刻意不放在前端的字段
 * `supplierId` 与 `costPrice` **不由前端提交** —— 服务端按 `dishId` 反查供应商、
 * 按菜品供价求和。前端只显示预览，不参与计算口径。理由见 DTO 注释。
 *
 * ⚠️「参考毛利」不是真毛利：C9 等式里还有场地费/打包人工/配送费/团长佣金四项。
 *    本页只减了供价，所以数字偏乐观 —— UI 上写明了，避免被当成决策依据。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import { createMealTemplate, fetchDishOptions, fetchMealTemplates } from '@/api/meal';
import type { DishOption, SetMealTemplateRow } from '@/api/meal';
import { ApiError } from '@/api/request';
import { UNIT_PRICE } from '@/constants';
import { fenToYuan } from '@/utils/format';

const router = useRouter();

const loadingDishes = ref(false);
const submitting = ref(false);
const dishes = ref<DishOption[]>([]);
const templates = ref<SetMealTemplateRow[]>([]);

const form = reactive({
  name: '',
  price: undefined as number | undefined,
  oneLiner: '',
  coverUrl: '',
  sourceSetMealId: undefined as number | undefined,
});

/** slot → dishId（档位选项由服务端下发，端上不维护第二份映射） */
const picked = reactive<Record<number, number | undefined>>({});

const slots = ref<Array<{ value: number; label: string }>>([
  { value: 1, label: '主荤' },
  { value: 2, label: '半荤' },
  { value: 3, label: '素菜' },
  { value: 4, label: '汤' },
  { value: 5, label: '主食' },
]);

const dishMap = computed(() => new Map(dishes.value.map((d) => [d.id, d])));
/** 已上架菜品（服务端只回 status=1）—— 直接绑定，无需再过滤 */
const dishOptions = computed(() => dishes.value);

const pickedEntries = computed(() =>
  slots.value
    .map((s) => ({ slot: s.value, dishId: picked[s.value] }))
    .filter((e): e is { slot: number; dishId: number } => typeof e.dishId === 'number'),
);
const pickedCount = computed(() => pickedEntries.value.length);
const costTotalFen = computed(() =>
  pickedEntries.value.reduce((sum, e) => sum + (dishMap.value.get(e.dishId)?.costPriceFen ?? 0), 0),
);
const grossFen = computed(() => {
  const priceFen = Math.round((form.price ?? UNIT_PRICE) * 100);
  return priceFen - costTotalFen.value;
});

/** 同一道菜不允许占两个档位 —— D7 服务端会拒，前端先禁掉，别让运营白填 */
function isDishUsed(dishId: number, exceptSlot: number): boolean {
  return slots.value.some((s) => s.value !== exceptSlot && picked[s.value] === dishId);
}

function clearItems(): void {
  for (const s of slots.value) picked[s.value] = undefined;
}

function reset(): void {
  form.name = '';
  form.price = undefined;
  form.oneLiner = '';
  form.coverUrl = '';
  form.sourceSetMealId = undefined;
  clearItems();
}

/** 基于已有套餐另存：把它的菜品明细回填到各档位，便于「改两道菜再存」 */
function onSourceChange(id: number | undefined): void {
  clearItems();
  if (!id) return;
  const tpl = templates.value.find((t) => t.id === id);
  if (!tpl) return;
  for (const item of tpl.items) {
    if (item.slot >= 1 && item.slot <= 5) picked[item.slot] = item.dishId;
  }
  if (!form.name && tpl.name) form.name = `${tpl.name}（副本）`;
}

async function load(): Promise<void> {
  loadingDishes.value = true;
  try {
    const [opt, tpl] = await Promise.all([
      fetchDishOptions({}),
      fetchMealTemplates({ page: 1, pageSize: 100 }),
    ]);
    dishes.value = opt.list;
    if (opt.slots?.length) slots.value = opt.slots;
    templates.value = tpl.list;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '菜品 / 套餐数据加载失败');
  } finally {
    loadingDishes.value = false;
  }
}

async function submit(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写套餐名');
    return;
  }
  if (!pickedEntries.value.length) {
    ElMessage.warning('至少选择一道菜');
    return;
  }

  submitting.value = true;
  try {
    const res = await createMealTemplate({
      name: form.name.trim(),
      price: form.price,
      oneLiner: form.oneLiner || undefined,
      coverUrl: form.coverUrl || undefined,
      items: pickedEntries.value.map((e) => ({ dishId: e.dishId, slot: e.slot })),
    });
    ElMessage.success(`套餐 #${res.id}「${res.name}」已保存`);
    await router.push('/meal/template');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    submitting.value = false;
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
}

.card {
  margin-bottom: $space-4;
  border-color: $c-border;

  &--sticky {
    position: sticky;
    top: $space-3;
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__title {
    font-weight: 600;
  }

  &__alert {
    margin-bottom: $space-3;

    :deep(p) {
      margin: 0 0 4px;
      line-height: 1.7;

      &:last-child {
        margin-bottom: 0;
      }
    }
  }
}

.slot {
  display: flex;
  align-items: center;
  gap: $space-2;
  padding: $space-1 0;

  &__label {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 64px;
    flex: none;
  }

  &__name {
    font-weight: 600;
  }

  &__req {
    padding: 0 4px;
    border-radius: $radius-sm;
    background: rgba(201, 168, 118, 0.25);
    color: $c-text;
    font-size: $fs-caption;
  }

  &__meta {
    width: 72px;
    flex: none;
    text-align: right;
  }

  &__cost {
    color: $c-warning;
    font-weight: 600;
  }
}

.empty {
  padding: $space-3 0;
  text-align: center;
}

.tip {
  margin-left: $space-2;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.side-note {
  margin: 0 0 $space-2;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: $space-2;
  margin-top: $space-4;
}

.muted {
  color: $c-text-weak;
}

.ok {
  color: $c-success;
  font-weight: 600;
}

.bad {
  color: $c-warning;
  font-weight: 600;
}
</style>
