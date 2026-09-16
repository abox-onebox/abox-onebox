<template>
  <div class="page-container">
    <h2 class="page-container__title">办公楼管理 · 办公楼列表</h2>
    <p class="page-container__meta">
      模块：M33-01 · 原型 P37 视图 2 · 接口：D13 列表 / D14 新增 / D15 编辑 · 数据源
      <code>ab_building</code>
    </p>

    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b
          >营业中 {{ summary.activeCount }} / 待开通 {{ summary.preparingCount }} / 已暂停
          {{ summary.suspendedCount }}</b
        >
        —— 只有<b>营业中</b>且<b>已归群</b>的楼栋能开团（当前 {{ summary.canOrderCount }} 栋）；
        未归群的楼无法分配套餐，用户端会显示「该办公楼今日未开团」。
      </template>
    </el-alert>

    <!-- ─────────────── 汇总（按当前过滤条件的全量，不受分页影响） ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">办公楼总数</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">可开团</span>
        <span class="stats__value stats__value--ok">{{ summary.canOrderCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">覆盖人数（估算）</span>
        <span class="stats__value">{{ summary.populationTotal }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已配团长 / 空缺</span>
        <span class="stats__value stats__value--small">
          {{ summary.leaderAssignedCount }} /
          <span :class="{ 'stats__value--warn': summary.leaderVacantCount > 0 }">
            {{ summary.leaderVacantCount }}
          </span>
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">集散未覆盖</span>
        <span
          class="stats__value"
          :class="summary.uncoveredCount ? 'stats__value--warn' : 'stats__value--ok'"
        >
          {{ summary.uncoveredCount }}
        </span>
      </div>
    </div>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-select
        v-model="query.groupId"
        placeholder="楼群"
        clearable
        style="width: 160px"
        @change="reload"
      >
        <el-option v-for="g in options.groups" :key="g.value" :label="g.label" :value="g.value" />
      </el-select>

      <el-select
        v-model="query.status"
        placeholder="状态"
        clearable
        style="width: 130px"
        @change="reload"
      >
        <el-option v-for="s in options.statuses" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>

      <el-select
        v-model="query.gap"
        placeholder="覆盖缺口"
        clearable
        style="width: 170px"
        @change="reload"
      >
        <el-option v-for="g in options.gaps" :key="g.value" :label="g.label" :value="g.value" />
      </el-select>

      <el-select
        v-model="query.leaderState"
        placeholder="团长归属"
        clearable
        style="width: 140px"
        @change="reload"
      >
        <el-option
          v-for="l in options.leaderStates"
          :key="l.value"
          :label="l.label"
          :value="l.value"
        />
      </el-select>

      <el-input
        v-model="query.keyword"
        placeholder="楼名 / 地址"
        clearable
        style="width: 200px"
        @keyup.enter="reload"
        @clear="reload"
      />

      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">查询</el-button>
        <el-tooltip
          :disabled="canManage"
          content="仅管理员 / 超级管理员可改建档（决定哪些楼能开团）"
          placement="top"
        >
          <span>
            <el-button type="primary" :disabled="!canManage" @click="openCreate()">
              + 新建办公楼
            </el-button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <!-- ─────────────── 表格 ─────────────── -->
    <el-table v-loading="loading" :data="rows" size="small" class="table" style="width: 100%">
      <el-table-column prop="id" label="ID" width="64" />

      <el-table-column label="办公楼" min-width="180">
        <template #default="{ row }">
          <div class="stack">
            <span class="strong">{{ row.name }}</span>
            <span class="stack__sub">
              约 {{ row.population ?? '未登记' }} 人<template v-if="row.floorCount">
                · {{ row.floorCount }} 层</template
              >
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="楼群" min-width="130">
        <template #default="{ row }">
          <el-tag v-if="row.groupName" size="small" effect="plain">{{ row.groupName }}</el-tag>
          <el-tag v-else size="small" type="warning" effect="plain">未归群</el-tag>
        </template>
      </el-table-column>

      <el-table-column prop="address" label="地址" min-width="180" show-overflow-tooltip />

      <el-table-column label="主团长" min-width="120">
        <template #default="{ row }">
          <div v-if="row.leaderName" class="stack">
            <span>{{ row.leaderName }}</span>
            <span class="stack__sub">{{ row.leaderLevelLabel }}</span>
          </div>
          <router-link v-else class="link" to="/leader/list">待分配 →</router-link>
        </template>
      </el-table-column>

      <el-table-column label="集散中心" min-width="170">
        <template #default="{ row }">
          <div v-if="row.mainDcName" class="stack">
            <span>{{ row.mainDcName }}</span>
            <span class="stack__sub"
              >{{ row.routeNo ?? '—' }} · 备 {{ row.backupDcName ?? '无' }}</span
            >
          </div>
          <el-tooltip v-else :content="gapHint(row.gap)" placement="top">
            <el-tag size="small" type="warning" effect="plain">{{ row.gapLabel }}</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)" size="small">{{ row.statusLabel }}</el-tag>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="!canManage" @click="openEdit(asRow(row))">
            编辑
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="query.page"
        :page-size="query.pageSize"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="load()"
      />
    </div>

    <p class="footnote">
      ⚠️ 主团长在本页为<b>只读</b>：改团长只有「团长管理 → 任命 /
      转交（D20）」与「变更（D21）」一个入口， 且带<b>撞车确认闸门</b>（20012）——
      本页刻意不提供团长字段，避免绕过闸门造出 「楼上写 A、团长档案写 B」的不一致。
    </p>

    <!-- ─────────────── 新建 / 编辑弹窗 ─────────────── -->
    <el-dialog
      v-model="dialog.visible"
      :title="dialog.isEdit ? `编辑办公楼 · ${dialog.origin?.name ?? ''}` : '新建办公楼'"
      width="640px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" class="dialog__body">
        <el-form-item label="办公楼名称" prop="name">
          <el-input v-model="form.name" placeholder="如：国贸三期 A 座" maxlength="64" />
        </el-form-item>

        <el-form-item label="地址" prop="address">
          <el-input
            v-model="form.address"
            placeholder="如：建国门外大街 1 号 A 座"
            maxlength="256"
          />
          <div class="dialog__tip">123 号令要求证照地址与线下门店一致，楼址不能留空。</div>
        </el-form-item>

        <el-form-item label="所属楼群" prop="buildingGroupId">
          <el-select
            v-model="form.buildingGroupId"
            placeholder="不选 = 未归群（无法开团）"
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="g in options.groups"
              :key="g.value"
              :label="g.label"
              :value="g.value"
            />
          </el-select>
          <div class="dialog__tip">
            未归群的楼<b>无法分配套餐</b>；编辑时清空本项即把该楼移出原楼群。
          </div>
        </el-form-item>

        <el-form-item label="状态" prop="status">
          <el-select v-model="form.status" style="width: 100%">
            <el-option
              v-for="s in options.statuses"
              :key="s.value"
              :label="s.label"
              :value="s.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="覆盖人数" prop="population">
          <el-input-number v-model="form.population" :min="0" :max="1000000" :step="10" />
          <span class="dialog__tip">运营估算值（非实时统计），用于备料量测算。</span>
        </el-form-item>

        <el-form-item label="楼层数" prop="floorCount">
          <el-input-number v-model="form.floorCount" :min="1" :max="300" />
        </el-form-item>

        <el-form-item label="城市 / 行政区">
          <div class="dialog__inline">
            <el-input v-model="form.city" placeholder="北京" maxlength="32" style="width: 140px" />
            <el-input
              v-model="form.district"
              placeholder="朝阳区"
              maxlength="32"
              style="width: 140px"
            />
          </div>
        </el-form-item>

        <el-form-item label="经纬度">
          <div class="dialog__inline">
            <el-input v-model="form.longitude" placeholder="经度 116.461000" style="width: 170px" />
            <el-input v-model="form.latitude" placeholder="纬度 39.908000" style="width: 170px" />
          </div>
          <div class="dialog__tip">可选；最多 6 位小数（与 DECIMAL(10,6) 对齐）。</div>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="dialog.warnings.length"
        type="warning"
        :closable="false"
        class="dialog__block"
      >
        <template #title>
          <div v-for="(w, i) in dialog.warnings" :key="i" class="warn-line">{{ w }}</div>
        </template>
      </el-alert>

      <template #footer>
        <el-button @click="dialog.visible = false">关闭</el-button>
        <el-button type="primary" :loading="dialog.saving" :disabled="!canManage" @click="submit()">
          {{ dialog.isEdit ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';

import {
  createBuilding,
  fetchBuildings,
  updateBuilding,
  type BuildingRow,
  type BuildingsPage,
  type BuildingWritePayload,
  type Option,
} from '@/api/building';

const loading = ref(false);
const rows = ref<BuildingRow[]>([]);
const total = ref(0);

const summary = ref<BuildingsPage['summary']>({
  totalCount: 0,
  activeCount: 0,
  preparingCount: 0,
  suspendedCount: 0,
  groupCount: 0,
  populationTotal: 0,
  populationUnregisteredCount: 0,
  leaderAssignedCount: 0,
  leaderVacantCount: 0,
  canOrderCount: 0,
  uncoveredCount: 0,
});

const options = reactive<{
  groups: Option[];
  statuses: Option[];
  gaps: Option[];
  leaderStates: Option[];
}>({ groups: [], statuses: [], gaps: [], leaderStates: [] });
const canManage = ref(false);

const query = reactive({
  groupId: undefined as number | undefined,
  status: undefined as number | undefined,
  gap: undefined as string | undefined,
  leaderState: undefined as string | undefined,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const dialog = reactive({
  visible: false,
  isEdit: false,
  saving: false,
  warnings: [] as string[],
  origin: null as BuildingRow | null,
});

const formRef = ref<FormInstance>();
const form = reactive({
  name: '',
  address: '',
  city: '北京',
  district: '',
  population: undefined as number | undefined,
  floorCount: undefined as number | undefined,
  buildingGroupId: undefined as number | undefined,
  status: 1,
  longitude: '',
  latitude: '',
});

const rules: FormRules = {
  name: [
    { required: true, message: '请填写办公楼名称', trigger: 'blur' },
    { min: 2, max: 64, message: '名称 2–64 字', trigger: 'blur' },
  ],
  address: [
    { required: true, message: '请填写地址', trigger: 'blur' },
    { min: 2, max: 256, message: '地址 2–256 字', trigger: 'blur' },
  ],
};

/** 状态 → Tag：营业中绿 / 待开通橙（待动作）/ 已暂停灰（不是错误） */
const statusTag = (s: number) => (s === 1 ? 'success' : s === 2 ? 'warning' : 'info');

/**
 * el-table 插槽给的 `row` 是 element-plus 的 `DefaultRow`（`Record<string, any>`），
 * 直接传给强类型函数会 TS2345。这里做一次显式收窄 —— 与 M3-6 `supplier/list.vue`
 * 的 `asRow()` 同一做法，不在模板里散落 `as` 断言。
 */
const asRow = (raw: unknown) => raw as BuildingRow;

const gapHint = (gap: string) =>
  ({
    no_group: '该楼未归属任何楼群 → 去「楼群划分」把它挂进一个楼群',
    no_center: '所属楼群没有集散中心服务 → 去「集散中心配置」把楼群加进服务范围',
    all_center_disabled: '服务该楼群的集散中心已全部停用 → 恢复其中一个，或改挂其他集散中心',
  })[gap] ?? '';

async function load() {
  loading.value = true;
  try {
    const res = await fetchBuildings({
      groupId: query.groupId,
      status: query.status,
      gap: query.gap,
      leaderState: query.leaderState,
      keyword: query.keyword || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list;
    total.value = res.total;
    summary.value = res.summary;
    options.groups = res.groupOptions;
    options.statuses = res.statusOptions;
    options.gaps = res.gapOptions;
    options.leaderStates = res.leaderStateOptions;
    canManage.value = res.actions.canManage;
  } finally {
    loading.value = false;
  }
}

function reload() {
  query.page = 1;
  return load();
}

function resetForm() {
  form.name = '';
  form.address = '';
  form.city = '北京';
  form.district = '';
  form.population = undefined;
  form.floorCount = undefined;
  form.buildingGroupId = undefined;
  form.status = 1;
  form.longitude = '';
  form.latitude = '';
  dialog.warnings = [];
  formRef.value?.clearValidate();
}

function openCreate() {
  dialog.isEdit = false;
  dialog.origin = null;
  resetForm();
  dialog.visible = true;
}

function openEdit(row: BuildingRow) {
  dialog.isEdit = true;
  dialog.origin = row;
  resetForm();
  form.name = row.name;
  form.address = row.address;
  form.city = row.city;
  form.district = row.district ?? '';
  form.population = row.population ?? undefined;
  form.floorCount = row.floorCount ?? undefined;
  form.buildingGroupId = row.buildingGroupId ?? undefined;
  form.status = row.status;
  form.longitude = row.longitude ?? '';
  form.latitude = row.latitude ?? '';
  dialog.visible = true;
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  const payload: BuildingWritePayload = {
    name: form.name,
    address: form.address,
    city: form.city || undefined,
    district: form.district || undefined,
    population: form.population,
    floorCount: form.floorCount,
    status: form.status,
    longitude: form.longitude || undefined,
    latitude: form.latitude || undefined,
  };

  // 楼群：新建只传「选了的值」；编辑要能表达「移出楼群」，故与原始值不同即传（含 null）
  if (dialog.isEdit) {
    const next = form.buildingGroupId ?? null;
    const origin = dialog.origin?.buildingGroupId ?? null;
    if (next !== origin) payload.buildingGroupId = next;
  } else if (form.buildingGroupId) {
    payload.buildingGroupId = form.buildingGroupId;
  }

  dialog.saving = true;
  try {
    const res = dialog.isEdit
      ? await updateBuilding(dialog.origin!.id, payload)
      : await createBuilding(payload);
    dialog.warnings = res.warnings ?? [];
    ElMessage.success(
      dialog.isEdit
        ? `已保存：${res.name}`
        : `已创建：${res.name}（${res.canOrder ? '可开团' : '暂不可开团'}）`,
    );
    if (!dialog.warnings.length) dialog.visible = false;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败');
  } finally {
    dialog.saving = false;
  }
}

onMounted(load);
</script>

<style lang="scss" scoped>
.note {
  margin-bottom: $space-3;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: $space-4;
  padding: $space-2 $space-3;
  margin-bottom: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__item {
    display: flex;
    flex-direction: column;
  }

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    font-size: $fs-h2;
    font-weight: 700;

    &--ok {
      color: $c-success;
    }

    &--warn {
      color: $c-warning;
    }

    &--small {
      font-size: $fs-body;
      font-weight: 500;
    }
  }
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-3;

  &__right {
    display: flex;
    gap: $space-2;
    margin-left: auto;
  }
}

.table {
  margin-bottom: $space-3;
}

.stack {
  display: flex;
  flex-direction: column;
  line-height: 1.4;

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.strong {
  font-weight: 700;
}

.link {
  color: var(--el-color-primary);
}

.pager {
  display: flex;
  justify-content: flex-end;
}

.dialog {
  &__body {
    display: flex;
    flex-direction: column;
  }

  &__inline {
    display: flex;
    gap: $space-2;
  }

  &__block {
    margin-bottom: 0;
  }

  &__tip {
    margin-left: $space-2;
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.warn-line {
  line-height: 1.7;
}

.footnote {
  margin: 0;
  color: $c-text-weak;
  font-size: $fs-caption;
}
</style>
