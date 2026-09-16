<template>
  <div class="page-container">
    <h2 class="page-container__title">办公楼管理 · 楼群划分</h2>
    <p class="page-container__meta">
      模块：M33-02 · 原型 P37 视图 3 · 接口：D16 列表 / D17 新建 / D18 编辑 · 数据源
      <code>ab_building_group</code> + <code>ab_building</code>
    </p>

    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>一楼群一日一套餐</b>（`uk_meal_assignment_date_group`）—— 楼群就是「分发单位」。
        原型上展示的「独立分配」（银泰 1 栋红烧肉 / 2
        栋东坡肉）在本结构下需<b>把楼拆成各自的楼群</b>： 这不是限制，而是楼群的定义。<br />
        <b>保存成员楼为整体替换语义</b> —— 不在列表里的楼会被移出本群（变成「未归群」，无法开团）。
      </template>
    </el-alert>

    <!-- ─────────────── 汇总 ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">楼群总数</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">启用 / 停用</span>
        <span class="stats__value stats__value--small">
          <span class="stats__value--ok">{{ summary.activeCount }}</span> /
          {{ summary.suspendedCount }}
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">成员楼合计</span>
        <span class="stats__value">{{ summary.memberBuildingTotal }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">覆盖人数（估算）</span>
        <span class="stats__value">{{ summary.populationTotal }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">未覆盖 / 空楼群</span>
        <span class="stats__value stats__value--small">
          <span :class="{ 'stats__value--warn': summary.uncoveredCount > 0 }">
            {{ summary.uncoveredCount }}
          </span>
          / {{ summary.emptyCount }}
        </span>
      </div>
    </div>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-select
        v-model="query.status"
        placeholder="状态"
        clearable
        style="width: 130px"
        @change="reload"
      >
        <el-option v-for="s in options.statuses" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>

      <el-input
        v-model="query.keyword"
        placeholder="楼群名 / 说明 / 成员楼名"
        clearable
        style="width: 220px"
        @keyup.enter="reload"
        @clear="reload"
      />

      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">查询</el-button>
        <el-tooltip
          :disabled="canManage"
          content="仅管理员 / 超级管理员可改楼群划分（决定哪些楼共享同一套餐与配送）"
          placement="top"
        >
          <span>
            <el-button type="primary" :disabled="!canManage" @click="openCreate()"
              >+ 新建楼群</el-button
            >
          </span>
        </el-tooltip>
      </div>
    </div>

    <!-- ─────────────── 楼群卡片 ─────────────── -->
    <div v-loading="loading" class="groups">
      <el-empty v-if="!rows.length" description="尚无楼群" />
      <el-card v-for="g in rows" :key="g.id" shadow="never" class="gcard">
        <template #header>
          <div class="gcard__head">
            <div class="gcard__title">
              {{ g.name }}
              <el-tag :type="g.status === 1 ? 'success' : 'info'" size="small" effect="plain">
                {{ g.statusLabel }}
              </el-tag>
              <el-tag :type="coverageTag(g.coverageState)" size="small">{{
                g.coverageLabel
              }}</el-tag>
            </div>
            <el-button link type="primary" :disabled="!canManage" @click="openEdit(g)"
              >编辑</el-button
            >
          </div>
        </template>

        <div v-if="g.description" class="gcard__desc">{{ g.description }}</div>

        <div class="gcard__section">
          <span class="gcard__label">成员办公楼（{{ g.memberCount }}）</span>
          <div class="chips">
            <el-tag
              v-for="m in g.members"
              :key="m.id"
              size="small"
              effect="plain"
              :type="m.status === 1 ? undefined : 'info'"
            >
              {{ m.name }}
              <span class="chips__sub">
                {{ m.statusLabel }}<template v-if="m.leaderName"> · {{ m.leaderName }}</template
                ><template v-else> · 无团长</template>
              </span>
            </el-tag>
            <span v-if="!g.members.length" class="muted"
              >（暂无成员楼 · 空楼群不参与套餐分配）</span
            >
          </div>
        </div>

        <div class="gcard__grid">
          <div>
            <span class="gcard__label">集散中心</span>
            <div v-if="g.mainDcName">
              主：{{ g.mainDcName }}
              <span class="muted">· 备：{{ g.backupDcName ?? '无' }}</span>
            </div>
            <div v-else class="warn">无 —— 成员楼下单能成立、履约断链</div>
          </div>
          <div>
            <span class="gcard__label">覆盖人数（估算）</span>
            <div>{{ g.populationTotal }} 人</div>
          </div>
          <div>
            <span class="gcard__label">今日分配</span>
            <div v-if="g.todayAssignment">
              {{ g.todayAssignment.setMealName ?? `套餐 #${g.todayAssignment.setMealId}` }}
              <el-tag size="small" effect="plain">{{ g.todayAssignment.status }}</el-tag>
            </div>
            <div v-else class="muted">未排（今日不开团）</div>
          </div>
          <div>
            <span class="gcard__label">明日分配</span>
            <div v-if="g.tomorrowAssignment">
              {{ g.tomorrowAssignment.setMealName ?? `套餐 #${g.tomorrowAssignment.setMealId}` }}
              <el-tag size="small" effect="plain">{{ g.tomorrowAssignment.status }}</el-tag>
            </div>
            <div v-else class="muted">未排</div>
          </div>
        </div>
      </el-card>
    </div>

    <div class="pager">
      <el-pagination
        v-model:current-page="query.page"
        :page-size="query.pageSize"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="load()"
      />
    </div>

    <!-- ─────────────── 新建 / 编辑弹窗 ─────────────── -->
    <el-dialog
      v-model="dialog.visible"
      :title="dialog.isEdit ? `编辑楼群 · ${dialog.origin?.name ?? ''}` : '新建楼群'"
      width="640px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" class="dialog__body">
        <el-form-item label="楼群名" prop="name">
          <el-input v-model="form.name" placeholder="如：国贸三期组" maxlength="64" />
        </el-form-item>

        <el-form-item label="说明" prop="description">
          <el-input
            v-model="form.description"
            placeholder="可选，如：四栋同址，统一套餐统一配送"
            maxlength="256"
          />
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
          <div class="dialog__tip">
            停用要求<b>成员楼已清空</b>（否则 60003）—— 停用会让成员楼静默失去开团能力，
            而楼自身状态仍显示「营业中」，列表上看不出异常。
          </div>
        </el-form-item>

        <el-form-item label="成员办公楼" prop="buildingIds">
          <el-select
            v-model="form.buildingIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="选择归入本楼群的办公楼"
            style="width: 100%"
          >
            <el-option
              v-for="b in options.buildings"
              :key="b.value"
              :label="b.label"
              :value="b.value"
            >
              <span>{{ b.label }}</span>
              <span class="opt-hint">
                {{ groupHint(b.groupId, dialog.origin?.id) }}
              </span>
            </el-option>
          </el-select>
          <div class="dialog__tip">
            整体替换：<b>不在列表里的本群现有成员会被移出</b>（变成「未归群」）；
            勾选其他楼群的楼会把它<b>搬进本群</b>（一楼一群）。
          </div>
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
  createGroup,
  fetchGroups,
  updateGroup,
  type GroupRow,
  type GroupsPage,
  type GroupWritePayload,
  type Option,
} from '@/api/building';

const loading = ref(false);
const rows = ref<GroupRow[]>([]);
const total = ref(0);

const summary = ref<GroupsPage['summary']>({
  totalCount: 0,
  activeCount: 0,
  suspendedCount: 0,
  emptyCount: 0,
  uncoveredCount: 0,
  memberBuildingTotal: 0,
  populationTotal: 0,
});

const options = reactive<{ statuses: Option[]; buildings: Option[] }>({
  statuses: [],
  buildings: [],
});
const canManage = ref(false);

const query = reactive({
  status: undefined as number | undefined,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const dialog = reactive({
  visible: false,
  isEdit: false,
  saving: false,
  warnings: [] as string[],
  origin: null as GroupRow | null,
});

const formRef = ref<FormInstance>();
const form = reactive({
  name: '',
  description: '',
  status: 1,
  buildingIds: [] as number[],
});

const rules: FormRules = {
  name: [
    { required: true, message: '请填写楼群名', trigger: 'blur' },
    { min: 2, max: 64, message: '楼群名 2–64 字', trigger: 'blur' },
  ],
};

const coverageTag = (state: string) =>
  state === 'covered' ? 'success' : state === 'uncovered' ? 'danger' : 'info';

/** 下拉里标注每栋楼当前归属，避免「勾了才发现是别人家的楼」 */
const groupHint = (groupId: number | null | undefined, selfId?: number) => {
  if (!groupId) return '未归群';
  if (selfId && groupId === selfId) return '本群';
  return '其他楼群（勾选即搬入）';
};

async function load() {
  loading.value = true;
  try {
    const res = await fetchGroups({
      status: query.status,
      keyword: query.keyword || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list;
    total.value = res.total;
    summary.value = res.summary;
    options.statuses = res.statusOptions;
    options.buildings = res.buildingOptions;
    canManage.value = res.actions.canManage;
  } finally {
    loading.value = false;
  }
}

function reload() {
  query.page = 1;
  return load();
}

function openCreate() {
  dialog.isEdit = false;
  dialog.origin = null;
  form.name = '';
  form.description = '';
  form.status = 1;
  form.buildingIds = [];
  dialog.warnings = [];
  formRef.value?.clearValidate();
  dialog.visible = true;
}

function openEdit(g: GroupRow) {
  dialog.isEdit = true;
  dialog.origin = g;
  form.name = g.name;
  form.description = g.description ?? '';
  form.status = g.status;
  form.buildingIds = g.members.map((m) => m.id);
  dialog.warnings = [];
  formRef.value?.clearValidate();
  dialog.visible = true;
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  const payload: GroupWritePayload = {
    name: form.name,
    description: form.description || undefined,
    status: form.status,
    buildingIds: form.buildingIds,
  };

  dialog.saving = true;
  try {
    const res = dialog.isEdit
      ? await updateGroup(dialog.origin!.id, payload)
      : await createGroup(payload);
    dialog.warnings = res.warnings ?? [];
    ElMessage.success(
      dialog.isEdit
        ? `已保存：${res.name}（成员楼 ${res.memberCount} 栋）`
        : `已创建：${res.name}（成员楼 ${res.memberCount} 栋）`,
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

.groups {
  display: flex;
  flex-direction: column;
  gap: $space-2;
  min-height: 60px;
}

.gcard {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__title {
    display: flex;
    gap: 6px;
    align-items: center;
    font-weight: 600;
  }

  &__desc {
    margin-bottom: $space-2;
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__section {
    margin-bottom: $space-2;
  }

  &__label {
    display: block;
    margin-bottom: 6px;
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: $space-2;
    font-size: $fs-caption;

    @media (max-width: 1100px) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;

  &__sub {
    margin-left: 4px;
    color: $c-text-weak;
  }
}

.muted {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.warn {
  color: $c-warning;
  font-size: $fs-caption;
}

.opt-hint {
  float: right;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: $space-3;
}

.dialog {
  &__body {
    display: flex;
    flex-direction: column;
  }

  &__block {
    margin-bottom: 0;
  }

  &__tip {
    margin-top: 4px;
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.6;
  }
}

.warn-line {
  line-height: 1.7;
}
</style>
