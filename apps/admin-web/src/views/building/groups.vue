<template>
  <div class="page-container">
    <h2 class="page-container__title">办公楼管理 · 楼群划分</h2>
    <p class="page-container__meta">
      模块：M33-02 · 原型 P37 视图 3 · 接口：D16 列表 / D17 新建 / D18 编辑 · 数据源
      <code>ab_building_group</code> + <code>ab_building</code>
    </p>

    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>一楼群一日一组合</b>（`uk_meal_assignment_date_group`）—— 楼群就是「分发单位」。
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
          content="仅管理员 / 超级管理员可改楼群划分（决定哪些楼共享同一组合与配送）"
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
            <!-- 详情**只读**，故不挂 :disabled="!canManage" —— viewer 也要能查覆盖为什么断 -->
            <el-button link @click="openDetail(g)">详情</el-button>
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
              >（暂无成员楼 · 空楼群不参与组合分配）</span
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
              {{ g.todayAssignment.setMealName ?? `组合 #${g.todayAssignment.setMealId}` }}
              <el-tag size="small" effect="plain">{{ g.todayAssignment.status }}</el-tag>
            </div>
            <div v-else class="muted">未排（今日不开团）</div>
          </div>
          <div>
            <span class="gcard__label">明日分配</span>
            <div v-if="g.tomorrowAssignment">
              {{ g.tomorrowAssignment.setMealName ?? `组合 #${g.tomorrowAssignment.setMealId}` }}
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

    <!--
      楼群详情（只读）
      卡片已经给了「成员楼数 / 覆盖人数 / 今明两日分配」，但**没有**成员楼与服务它的
      集散中心清单 —— 运营判断「这个群能不能停、能不能搬」恰恰要看这两张表。
      `fetchGroupDetail` 一直在、页面零引用（admin:coverage #45）。
    -->
    <el-drawer v-model="detailVisible" :title="detailTitle" size="520px">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="状态">{{
              detail.statusLabel ?? '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="覆盖状态">
              {{ detail.coverageLabel }}
            </el-descriptions-item>
            <el-descriptions-item label="成员楼数">{{ detail.memberCount }}</el-descriptions-item>
            <el-descriptions-item label="城市 / 行政区">
              {{ detail.city }}{{ detail.district ? ` / ${detail.district}` : '' }}
            </el-descriptions-item>
            <el-descriptions-item label="说明">
              {{ detail.description || '—' }}
            </el-descriptions-item>
          </el-descriptions>

          <h4 class="detail__h">成员楼（{{ detail.members.length }}）</h4>
          <el-table v-if="detail.members.length" :data="detail.members" border size="small">
            <el-table-column prop="name" label="楼栋" min-width="180" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                {{ asMember(row).status === 1 ? '启用' : '停用' }}
              </template>
            </el-table-column>
          </el-table>
          <p v-else class="dialog__tip">空群 —— 停用前不必搬楼，但也没有楼会被配送。</p>

          <h4 class="detail__h">服务该楼群的集散中心（{{ detail.centers.length }}）</h4>
          <el-table v-if="detail.centers.length" :data="detail.centers" border size="small">
            <el-table-column prop="name" label="名称" min-width="180" />
            <el-table-column label="状态" width="120">
              <template #default="{ row }">{{ asCenter(row).statusLabel }}</template>
            </el-table-column>
          </el-table>
          <p v-else class="dialog__tip">
            没有任何集散中心服务本群 —— 这是「未覆盖」的根因：用户能下单，履约断链。
          </p>
        </template>
      </div>
    </el-drawer>

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
            placeholder="可选，如：四栋同址，统一组合统一配送"
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
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';

import {
  createGroup,
  fetchGroups,
  fetchGroupFilterOptions,
  fetchGroupDetail,
  updateGroup,
  type GroupDetail,
  type GroupRow,
  type GroupsPage,
  type GroupWritePayload,
  type Option,
} from '@/api/building';
import { guardSuspendWrite } from '@/views/building/suspend-guard';

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

/** 详情抽屉（只读） */
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<GroupDetail | null>(null);
const detailTitle = computed(() => (detail.value ? `楼群详情 · ${detail.value.name}` : '楼群详情'));

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

/** 抽屉里两张小表的 row 断言：入口断言一次，不让 `as` 扩散进模板 */
function asMember(raw: unknown): GroupDetail['members'][number] {
  return raw as GroupDetail['members'][number];
}
function asCenter(raw: unknown): GroupDetail['centers'][number] {
  return raw as GroupDetail['centers'][number];
}

/**
 * 打开详情抽屉
 *
 * ⚠️ 每次**重新拉**：成员楼与集散中心都是派生态，用卡片上的缓存给运营看，
 *    等于让他拿上一秒的数据判断「这个群现在能不能停」。
 */
async function openDetail(g: GroupRow): Promise<void> {
  detail.value = null;
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    detail.value = await fetchGroupDetail(g.id);
  } finally {
    detailLoading.value = false;
  }
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

/** 落库并收尾 —— 同样拆出来给 N2 闸门的二次确认重提交复用 */
async function send(payload: GroupWritePayload) {
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
    await send(payload);
  } catch (e) {
    // N2 闸门：与楼宇同套分支（60007 / 60012 / 60013 / 10001），handled=true 时不再叠通用报错
    const handled = await guardSuspendWrite(e, (force) => send({ ...payload, ...force }));
    if (!handled) ElMessage.error((e as Error).message || '保存失败');
  } finally {
    dialog.saving = false;
  }
}

/**
 * 下拉枚举：改用独立端点（状态 + 可搬入的楼）
 *
 * ⚠️ 与 `building/list.vue` 同款**静默兜底**：失败不弹错，`load()` 里列表内联的
 *    同名 options 会照样填回；弹错会让人误以为楼群没加载出来。
 */
async function loadOptions(): Promise<void> {
  try {
    const res = await fetchGroupFilterOptions();
    options.statuses = res.statusOptions ?? [];
    options.buildings = res.buildingOptions ?? [];
  } catch {
    // 兜底在 load() —— 见上方注释
  }
}

onMounted(() => {
  void loadOptions();
  void load();
});
</script>

<style lang="scss" scoped>
.note {
  margin-bottom: $space-3;
}

.detail__h {
  margin: $space-4 0 $space-2;
  font-size: $fs-body;
  color: $c-text;
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
      color: $c-ok-fg;
    }

    &--warn {
      color: $c-warn-fg;
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
  }
}

/**
 * ⭐ 2026-10-07 整体复查⑱：这里原写 `@media (max-width: 1100px)` ——
 *    那是**第二份断点**：真源是 `use-narrow.ts` 的 `NARROW_MAX = 768`（**数值还不一样**），
 *    而 CSS 断点与 JS 断点是两份表述，**任何门禁都看不见它们的漂移**。
 *    ⇒ 改挂 `.ab-layout.is-narrow`（由 `layouts/default-layout.vue` 挂上），断点只有一份。
 */
.ab-layout.is-narrow {
  .gcard__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
  color: $c-warn-fg;
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
