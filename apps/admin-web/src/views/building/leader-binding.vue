<template>
  <div class="page-container">
    <h2 class="page-container__title">办公楼管理 · 团长 ↔ 办公楼绑定</h2>
    <p class="page-container__meta">
      模块：M33-03 · 原型 P37 视图 4 · 数据源：D13 列表（`ab_building` × `ab_team_leader`）
    </p>

    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>本页是只读视图</b>：任命 / 转交团长唯一入口在「团长管理」（D20），常规变更（等级 / 所属楼
        / 停复职）走 D21。 本页不提供绑定操作 —— 楼栋编辑接口刻意不收
        `leaderId`，避免绕过<b>撞车确认闸门</b>（20012）。<br />
        <b>「副团长」不在本期模型</b>：一栋楼一名在职团长（`ab_team_leader.building_id` 单值）。
        原型上的「副团长 /
        兼任」需先补数据模型，一期不做；一名团长管多栋楼是支持的（下一行「兼管」）。
      </template>
    </el-alert>

    <!-- ─────────────── 汇总 ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">办公楼</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已配主团长</span>
        <span class="stats__value stats__value--ok">{{ summary.leaderAssignedCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">待分配</span>
        <span
          class="stats__value"
          :class="summary.leaderVacantCount ? 'stats__value--warn' : 'stats__value--ok'"
        >
          {{ summary.leaderVacantCount }}
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">非营业中楼栋</span>
        <span class="stats__value stats__value--muted">
          {{ summary.suspendedCount + summary.preparingCount }}
        </span>
      </div>
    </div>

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
        v-model="query.leaderState"
        placeholder="团长归属"
        clearable
        style="width: 150px"
        @change="reload"
      >
        <el-option
          v-for="l in options.leaderStates"
          :key="l.value"
          :label="l.label"
          :value="l.value"
        />
      </el-select>
      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">查询</el-button>
        <el-button @click="goLeaderList()">去团长管理（任命 / 变更）</el-button>
      </div>
    </div>

    <!-- ─────────────── 绑定表 ─────────────── -->
    <el-table v-loading="loading" :data="rows" size="small" class="table" style="width: 100%">
      <el-table-column label="办公楼" min-width="170">
        <template #default="{ row }">
          <div class="stack">
            <span class="strong">{{ row.name }}</span>
            <span class="stack__sub">{{ row.groupName ?? '未归群' }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="主团长" min-width="130">
        <template #default="{ row }">
          <div v-if="row.leaderName" class="stack">
            <span class="strong">{{ row.leaderName }}</span>
            <span class="stack__sub">{{ row.leaderLevelLabel }}</span>
          </div>
          <span v-else class="warn">待分配</span>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)" size="small">{{ row.statusLabel }}</el-tag>
        </template>
      </el-table-column>

      <el-table-column label="可开团" width="90">
        <template #default="{ row }">
          <el-tag :type="row.canOrder ? 'success' : 'info'" size="small" effect="plain">
            {{ row.canOrder ? '是' : '否' }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="覆盖人数（估算）" width="130">
        <template #default="{ row }">{{ row.population ?? '未登记' }}</template>
      </el-table-column>

      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="goLeaderList(asRow(row))">
            {{ row.leaderName ? '去变更' : '去任命' }}
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
      提示：一名团长可管多栋楼（如「赵静 · 银泰中心 1 / 2
      栋」）。转交会让现任团长置为<b>停职（非删除）</b>， 历史佣金与推荐关系仍留在其名下 —— 这是
      M3-5 的刻意设计（换人不抹账）。
    </p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { fetchBuildings, type BuildingRow, type BuildingsPage, type Option } from '@/api/building';

const router = useRouter();
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

const options = reactive<{ groups: Option[]; leaderStates: Option[] }>({
  groups: [],
  leaderStates: [],
});

const query = reactive({
  groupId: undefined as number | undefined,
  leaderState: undefined as string | undefined,
  page: 1,
  pageSize: 20,
});

const statusTag = (s: number) => (s === 1 ? 'success' : s === 2 ? 'warning' : 'info');

/** el-table 插槽的 row 是 `DefaultRow`，显式收窄成业务行（与 M3-6 `asRow()` 同一做法）*/
const asRow = (raw: unknown) => raw as BuildingRow;

async function load() {
  loading.value = true;
  try {
    const res = await fetchBuildings({
      groupId: query.groupId,
      leaderState: query.leaderState,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list;
    total.value = res.total;
    summary.value = res.summary;
    options.groups = res.groupOptions;
    options.leaderStates = res.leaderStateOptions;
  } finally {
    loading.value = false;
  }
}

function reload() {
  query.page = 1;
  return load();
}

/**
 * 跳团长管理
 *
 * ⚠️ 带上楼 id 作为查询参数：P32 页面用它预选「所属办公楼」，
 *    让运营点过来之后不必再自己找一遍楼。参数缺失也安全（只是少一次预选）。
 */
function goLeaderList(row?: BuildingRow) {
  router.push({ path: '/leader/list', query: row ? { buildingId: String(row.id) } : {} });
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
      color: $c-ok-fg;
    }

    &--warn {
      color: $c-warn-fg;
    }

    &--muted {
      color: $c-text-weak;
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

.warn {
  color: $c-warn-fg;
}

.pager {
  display: flex;
  justify-content: flex-end;
}

.footnote {
  margin: 0;
  color: $c-text-weak;
  font-size: $fs-caption;
}
</style>
