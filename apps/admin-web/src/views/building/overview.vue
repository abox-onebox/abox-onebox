<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">办公楼管理 · 总览</h2>
    <p class="page-container__meta">
      模块：M33-01/02 · 原型 P37 · 接口：D13 列表（`/overview` 聚合） · 数据源
      <code>ab_building</code> + <code>ab_building_group</code> +
      <code>ab_distribution_center</code>
    </p>

    <!-- 覆盖缺口是「下单能成立、履约断链」，不是普通的列表为空 —— 置顶提示 -->
    <el-alert
      v-if="data && data.uncoveredBuildings.length"
      type="warning"
      :closable="false"
      class="note"
    >
      <template #title>
        <b>{{ data.uncoveredBuildings.length }} 栋办公楼「送不出去」</b> ——
        用户能正常下单，却没有集散中心接单配送。三种成因三种修法：<b>未归入楼群</b>去「楼群划分」挂群；
        <b>楼群无集散中心</b>去「集散中心配置」把楼群加进服务范围；<b>集散中心已停用</b>恢复或改挂。
      </template>
    </el-alert>

    <el-alert v-else-if="data" type="success" :closable="false" class="note">
      <template #title
        >集散中心已覆盖全部在用办公楼（{{ data.centerStats.coveredBuildingCount }} 栋）。</template
      >
    </el-alert>

    <!-- ─────────────── KPI ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">办公楼总数</span>
        <span class="stats__value">{{ data?.buildings.totalCount ?? '—' }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">营业中 / 待开通 / 已暂停</span>
        <span class="stats__value stats__value--small">
          <span class="stats__value--ok">{{ data?.buildings.activeCount ?? 0 }}</span> /
          {{ data?.buildings.preparingCount ?? 0 }} / {{ data?.buildings.suspendedCount ?? 0 }}
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">覆盖人数（估算）</span>
        <span class="stats__value">{{ data?.buildings.populationTotal ?? 0 }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">可开团楼栋</span>
        <span class="stats__value">
          {{ data?.buildings.canOrderCount ?? 0 }}
          <span class="stats__sub">/ {{ data?.buildings.totalCount ?? 0 }}</span>
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">楼群数</span>
        <span class="stats__value">{{ data?.groupStats.totalCount ?? 0 }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">集散中心覆盖</span>
        <span class="stats__value stats__value--small">
          {{ data?.centerStats.activeCount ?? 0 }} 启用 /
          <span :class="{ 'stats__value--warn': (data?.centerStats.disabledCount ?? 0) > 0 }">
            {{ data?.centerStats.disabledCount ?? 0 }} 停用</span
          >
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">在职团长 / 空缺楼栋</span>
        <span class="stats__value stats__value--small">
          {{ data?.leaderStats.assignedCount ?? 0 }} /
          <span :class="{ 'stats__value--warn': (data?.leaderStats.vacantBuildingCount ?? 0) > 0 }">
            {{ data?.leaderStats.vacantBuildingCount ?? 0 }}</span
          >
        </span>
      </div>
    </div>

    <!-- ─────────────── 楼群分布 / 集散覆盖 ─────────────── -->
    <div class="grid">
      <el-card shadow="never" class="card">
        <template #header>
          <div class="card__head">
            <span>楼群分布</span>
            <span class="card__hint"
              >未覆盖 {{ data?.groupStats.uncoveredCount ?? 0 }} · 空楼群
              {{ data?.groupStats.emptyCount ?? 0 }}</span
            >
          </div>
        </template>
        <el-empty v-if="!data?.groupDistribution.length" description="尚无楼群" :image-size="60" />
        <div v-for="g in data?.groupDistribution ?? []" :key="g.groupId" class="row">
          <div class="row__main">
            <div class="row__title">
              {{ g.name }}
              <el-tag :type="g.status === 1 ? 'success' : 'info'" size="small" effect="plain">
                {{ g.statusLabel }}
              </el-tag>
              <el-tag :type="coverageTag(g.coverageState)" size="small">{{
                g.coverageLabel
              }}</el-tag>
            </div>
            <div class="row__sub">{{ g.buildingNames.join(' / ') || '（暂无成员楼）' }}</div>
            <div v-if="g.mainDcName" class="row__sub">主集散中心：{{ g.mainDcName }}</div>
          </div>
          <div class="row__side">
            <div>
              <b>{{ g.memberCount }}</b> 栋
            </div>
            <div class="row__sub">约 {{ g.populationTotal }} 人</div>
          </div>
        </div>
      </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card__head">
            <span>集散中心覆盖</span>
            <span class="card__hint"
              >共 {{ data?.centerStats.totalCount ?? 0 }} 个（C4 表驱动，非硬编码 4 个）</span
            >
          </div>
        </template>
        <el-empty v-if="!data?.centerCoverage.length" description="尚无集散中心" :image-size="60" />
        <div v-for="c in data?.centerCoverage ?? []" :key="c.dcId" class="row">
          <div class="row__main">
            <div class="row__title">
              {{ c.name }}
              <el-tag :type="c.status === 1 ? 'success' : 'danger'" size="small" effect="plain">
                {{ c.statusLabel }}
              </el-tag>
            </div>
            <div class="row__sub">{{ c.address }}</div>
            <div class="row__sub">
              覆盖 <b>{{ c.coveredGroupCount }}</b> 个楼群 ·
              <b>{{ c.coveredBuildingCount }}</b> 栋办公楼
            </div>
          </div>
          <div class="row__side">
            <div>
              <b>{{ c.coveredPopulation }}</b>
            </div>
            <div class="row__sub">覆盖人数</div>
          </div>
        </div>
      </el-card>
    </div>

    <!-- ─────────────── 未覆盖楼栋 / 待分配团长 ─────────────── -->
    <div class="grid">
      <el-card shadow="never" class="card">
        <template #header>
          <div class="card__head">
            <span>未覆盖楼栋（{{ data?.uncoveredBuildings.length ?? 0 }}）</span>
          </div>
        </template>
        <el-table :data="data?.uncoveredBuildings ?? []" size="small" style="width: 100%">
          <el-table-column prop="name" label="办公楼" min-width="140" />
          <el-table-column prop="statusLabel" label="状态" width="90" />
          <el-table-column label="覆盖缺口" min-width="140">
            <template #default="{ row }">
              <el-tag type="warning" size="small" effect="plain">{{ row.gapLabel }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card__head">
            <span>待分配团长（{{ data?.vacantBuildings.length ?? 0 }}）</span>
            <router-link class="card__hint link" to="/leader/list">去团长管理任命 →</router-link>
          </div>
        </template>
        <el-table :data="data?.vacantBuildings ?? []" size="small" style="width: 100%">
          <el-table-column prop="name" label="办公楼" min-width="140" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              {{ statusText(row.status) }}
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <p class="footnote">
      本视图只做<b>主数据健康度</b>（楼栋 / 楼群 / 团长 / 集散覆盖），不含经营指标 ——
      「本月服务订单」等看<b>数据看板</b>，避免同一指标两处口径。
    </p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { fetchBuildingOverview, type BuildingOverview } from '@/api/building';

const data = ref<BuildingOverview | null>(null);
const loading = ref(false);

const statusText = (s: number) => ({ 1: '营业中', 2: '待开通', 3: '已暂停' })[s] ?? `未知(${s})`;

/** 覆盖状态 → Tag 类型：已覆盖绿、未覆盖红、空楼群灰（不是错误，只是还没安排）*/
const coverageTag = (state: string) =>
  state === 'covered' ? 'success' : state === 'uncovered' ? 'danger' : 'info';

async function load() {
  loading.value = true;
  try {
    data.value = await fetchBuildingOverview();
  } finally {
    loading.value = false;
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

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
    font-weight: 400;
  }
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: $space-3;
  margin-bottom: $space-3;

  @media (max-width: 1100px) {
    grid-template-columns: 1fr;
  }
}

.card {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
  }

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
    font-weight: 400;
  }
}

.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: $space-2;
  padding: $space-2 0;
  border-bottom: 1px dashed $c-border;

  &:last-child {
    border-bottom: none;
  }

  &__title {
    display: flex;
    gap: 6px;
    align-items: center;
    font-weight: 600;
  }

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.6;
  }

  &__side {
    flex: 0 0 auto;
    text-align: right;
    font-size: $fs-caption;
  }
}

.link {
  color: var(--el-color-primary);
}

.footnote {
  margin: 0;
  color: $c-text-weak;
  font-size: $fs-caption;
}
</style>
