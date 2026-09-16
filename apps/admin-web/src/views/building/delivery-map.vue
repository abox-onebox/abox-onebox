<template>
  <div class="page-container">
    <h2 class="page-container__title">办公楼管理 · 集散中心 → 办公楼 配送映射</h2>
    <p class="page-container__meta">
      模块：M33-02 · 原型 P37 视图 5 · 数据源：<code>ab_distribution_center.service_groups</code>
      派生（无副本表）
    </p>

    <el-alert type="warning" :closable="false" class="note">
      <template #title>
        <b>路线号与站点顺序是派生值</b>：主集散中心 = 服务该楼所属楼群、启用中的集散中心里 id
        最小者； R1…Rn 按主集散中心 id 升序编号，同路线内按楼栋 id 升序。
        <b>不返回距离与单段时长</b> —— 需要地图与真实路况数据，一期不具备；原型上的「0.8 km / 30
        分钟」是演示值。
      </template>
    </el-alert>

    <!-- ─────────────── 汇总 ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">配送路线</span>
        <span class="stats__value">{{ data?.summary.routeCount ?? 0 }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已覆盖楼栋</span>
        <span class="stats__value stats__value--ok">{{
          data?.summary.coveredBuildingCount ?? 0
        }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">未覆盖楼栋</span>
        <span
          class="stats__value"
          :class="
            (data?.summary.uncoveredBuildingCount ?? 0) > 0
              ? 'stats__value--warn'
              : 'stats__value--ok'
          "
        >
          {{ data?.summary.uncoveredBuildingCount ?? 0 }}
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">单条路线最多站点</span>
        <span class="stats__value">{{ data?.summary.maxStopCount ?? 0 }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">办公楼总数</span>
        <span class="stats__value stats__value--muted">{{
          data?.summary.totalBuildingCount ?? 0
        }}</span>
      </div>
    </div>

    <!-- ─────────────── 路线卡片 ─────────────── -->
    <div v-loading="loading" class="routes">
      <div v-for="r in data?.routes ?? []" :key="r.dcId" class="rcard">
        <div class="rcard__head">
          <span class="rcard__no">{{ r.routeNo ?? '—' }}</span>
          <span class="rcard__name">{{ r.dcName }}</span>
          <el-tag size="small" :type="r.dcStatus === 1 ? 'success' : 'danger'" effect="plain">
            {{ r.dcStatusLabel }}
          </el-tag>
        </div>
        <div class="rcard__addr">{{ r.dcAddress }}</div>
        <div class="rcard__stats">
          <span
            ><b>{{ r.stopCount }}</b> 站</span
          >
          <span
            >约 <b>{{ r.populationTotal }}</b> 人</span
          >
        </div>
        <div class="rcard__chain">
          <template v-for="(s, i) in r.stops" :key="s.buildingId">
            <span v-if="i > 0" class="rcard__arrow">→</span>
            <span class="rcard__stop">{{ s.buildingName }}</span>
          </template>
        </div>
      </div>
      <el-empty
        v-if="!loading && !(data?.routes ?? []).length"
        description="尚无可用配送路线（没有启用中的集散中心）"
      />
    </div>

    <!-- ─────────────── 站点明细 ─────────────── -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="card__head">站点明细（每栋楼的主 / 备集散中心）</div>
      </template>
      <el-table :data="stops" size="small" style="width: 100%">
        <el-table-column label="路线" width="80">
          <template #default="{ row }">
            <el-tag size="small">{{ row.routeNo ?? '—' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="seq" label="序号" width="70" />
        <el-table-column label="办公楼" min-width="170">
          <template #default="{ row }">
            <div class="stack">
              <span class="strong">{{ row.buildingName }}</span>
              <span class="stack__sub">{{ row.groupName ?? '未归群' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="address" label="地址" min-width="180" show-overflow-tooltip />
        <el-table-column label="主集散中心" min-width="150">
          <template #default="{ row }">{{ row.dcName }}</template>
        </el-table-column>
        <el-table-column label="备用集散中心" min-width="150">
          <template #default="{ row }">
            <span :class="{ muted: !row.backupDcName }">{{
              row.backupDcName ?? '无（该楼群仅一个集散中心）'
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 1 ? 'success' : 'info'" effect="plain">
              {{ row.statusLabel }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ─────────────── 未分配 ─────────────── -->
    <el-card v-if="(data?.unassigned ?? []).length" shadow="never" class="card">
      <template #header>
        <div class="card__head card__head--warn">
          未纳入任何路线（{{ data?.unassigned.length }}）—— 用户能下单、履约断链
        </div>
      </template>
      <el-table :data="data?.unassigned ?? []" size="small" style="width: 100%">
        <el-table-column prop="buildingName" label="办公楼" min-width="160" />
        <el-table-column prop="groupName" label="楼群" min-width="130">
          <template #default="{ row }">
            <span :class="{ muted: !row.groupName }">{{ row.groupName ?? '未归群' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="缺口原因" min-width="150">
          <template #default="{ row }">
            <el-tag type="warning" size="small" effect="plain">{{ row.gapLabel }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="修法" min-width="280">
          <template #default="{ row }">{{ gapFix(row.gap) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <p class="footnote">
      想调整某栋楼走哪个集散中心？改的不是楼，而是<b>集散中心的「服务楼群」</b>
      （集散中心配置 · D31）—— 本页只是这条配置的投影，避免出现两套互相打脸的真源。
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { fetchDeliveryMap, type DeliveryMap, type DeliveryStop } from '@/api/building';

const loading = ref(false);
const data = ref<DeliveryMap | null>(null);

/** 站点明细：拉平时带上路线号，便于一张表看全 */
const stops = computed<Array<DeliveryStop & { routeNo: string | null; dcName: string }>>(() =>
  (data.value?.routes ?? []).flatMap((r) =>
    r.stops.map((s) => ({ ...s, routeNo: r.routeNo, dcName: r.dcName })),
  ),
);

const gapFix = (gap: string) =>
  ({
    no_group: '去「楼群划分」把这栋楼挂进一个楼群',
    no_center: '去「集散中心配置」，把该楼群加进某个集散中心的「服务楼群」',
    all_center_disabled: '去「集散中心配置」恢复该集散中心，或改挂另一个',
  })[gap] ?? '';

async function load() {
  loading.value = true;
  try {
    data.value = await fetchDeliveryMap();
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
      color: $c-success;
    }

    &--warn {
      color: $c-warning;
    }

    &--muted {
      color: $c-text-weak;
    }
  }
}

.routes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: $space-2;
  min-height: 60px;
  margin-bottom: $space-3;
}

.rcard {
  padding: $space-2;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__head {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 4px;
  }

  &__no {
    padding: 1px 6px;
    color: #fff;
    font-weight: 700;
    font-size: $fs-caption;
    background: var(--el-color-primary);
    border-radius: 4px;
  }

  &__name {
    font-weight: 600;
  }

  &__addr {
    margin-bottom: 6px;
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__stats {
    display: flex;
    gap: $space-3;
    margin-bottom: 6px;
    font-size: $fs-caption;
  }

  &__chain {
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.8;
  }

  &__stop {
    white-space: nowrap;
  }

  &__arrow {
    margin: 0 4px;
    color: var(--el-color-primary);
  }
}

.card {
  margin-bottom: $space-3;

  &__head {
    font-weight: 600;

    &--warn {
      color: $c-warning;
    }
  }
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

.muted {
  color: $c-text-weak;
}

.footnote {
  margin: 0;
  color: $c-text-weak;
  font-size: $fs-caption;
}
</style>
