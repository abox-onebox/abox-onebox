<template>
  <div class="page-container">
    <h2 class="page-container__title">团长申请流水（提交即生效 · C3）</h2>
    <p class="page-container__meta">
      模块：M33-03 · 原型 P32 · 接口：D19（<code>view=applications</code>）· 数据源
      <code>ab_team_leader</code> + <code>ab_leader_invite</code>（手机号脱敏）
    </p>

    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>本页是观察流水，不是待办队列。</b>
        C3 口径下用户填写微信号 + 手机号 + 所在办公楼后<b>立即成为见习团长（8%）</b>，
        没有人工/系统审核环节。本页用于追溯「谁在什么时间申请成为哪个楼的团长、经谁推荐」；
        发现恶意申请请到名录页用「例外处理 → 停用」。
      </template>
    </el-alert>

    <!-- ⚠️ 出参偏差要如实展示：原型图里有「微信号」列，但数据模型从未采集过 -->
    <el-alert v-if="notes.wechatId" type="warning" :closable="false" class="note">
      <template #title> <b>字段偏差提示</b>：{{ notes.wechatId }} </template>
    </el-alert>

    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">近 {{ summary.days ?? 7 }} 天申请</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">待审核</span>
        <span class="stats__value stats__value--muted">0</span>
        <span class="stats__sub">申请即生效，无审核环节</span>
      </div>
      <div class="stats__item stats__item--wide">
        <span class="stats__label">按办公楼分布</span>
        <span class="stats__value stats__value--small">
          <template v-if="summary.byBuilding?.length">
            <el-tag
              v-for="b in summary.byBuilding"
              :key="b.key"
              size="small"
              class="dist"
              effect="plain"
            >
              {{ b.key }} · {{ b.count }}
            </el-tag>
          </template>
          <span v-else class="muted">—</span>
        </span>
      </div>
    </div>

    <div class="toolbar">
      <el-select v-model="query.days" style="width: 140px" @change="reload()">
        <el-option label="近 7 天" :value="7" />
        <el-option label="近 30 天" :value="30" />
        <el-option label="近 90 天" :value="90" />
      </el-select>

      <el-select v-model="query.buildingId" placeholder="办公楼" clearable style="width: 180px">
        <el-option v-for="b in options.buildings" :key="b.id" :label="b.name" :value="b.id" />
      </el-select>

      <el-select v-model="query.level" placeholder="等级" clearable style="width: 130px">
        <el-option
          v-for="l in options.levels"
          :key="l.key"
          :label="`${l.label}（${l.rateText}）`"
          :value="l.key"
        />
      </el-select>

      <el-select v-model="query.status" placeholder="在职状态" clearable style="width: 120px">
        <el-option v-for="s in options.statuses" :key="s.key" :label="s.label" :value="s.key" />
      </el-select>

      <el-input
        v-model="query.keyword"
        placeholder="姓名 / 手机号 / 微信昵称"
        clearable
        style="width: 200px"
        @keyup.enter="reload"
        @clear="reload"
      />

      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">查询</el-button>
        <el-button @click="router.push('/leader/list')">返回名录</el-button>
      </div>
    </div>

    <el-table v-loading="loading" :data="rows" class="table" stripe>
      <el-table-column label="申请人" min-width="150">
        <template #default="{ row }">
          <div class="stack">
            <span class="strong">{{ asRow(row).realName }}</span>
            <span class="stack__sub mono">{{ displayOr(asRow(row).phoneMasked) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="办公楼 / 楼层" min-width="170">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(asRow(row).buildingName) }}</span>
            <span class="stack__sub">{{ displayOr(asRow(row).floor) }}</span>
          </div>
        </template>
      </el-table-column>

      <!-- 原型此列名为「微信号」；数据模型未采集该字段，如实改为「微信（昵称 + 标识后 6 位）」 -->
      <el-table-column label="微信（昵称 · 标识）" min-width="180">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(asRow(row).nickname) }}</span>
            <span class="stack__sub mono">
              {{ asRow(row).openidTail ? `…${asRow(row).openidTail}` : '—' }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="推荐人" min-width="150">
        <template #default="{ row }">
          <span :class="{ muted: !asRow(row).inviter }">{{ asRow(row).inviterText }}</span>
        </template>
      </el-table-column>

      <el-table-column label="来源渠道" width="100">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ channelText(asRow(row).channel) }}</el-tag>
        </template>
      </el-table-column>

      <el-table-column label="等级 / 状态" width="130">
        <template #default="{ row }">
          <div class="stack">
            <el-tag size="small" :type="levelTagType(asRow(row).level)">
              {{ asRow(row).levelLabel }}
            </el-tag>
            <span class="stack__sub">
              {{ asRow(row).statusLabel }}
              · 协议 {{ displayOr(asRow(row).agreeVersion) }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="提交时间" min-width="160">
        <template #default="{ row }">
          <span class="stack__sub">{{ formatDateTime(asRow(row).appliedAt) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="goDetail(asRow(row))">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next"
        @size-change="reload"
        @current-change="reload"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  fetchLeaderApplications,
  fetchLeaderFilterOptions,
  type LeaderApplicationRow,
  type LeaderFilterOptions,
  type LeadersSummary,
} from '@/api/leader';
import { ApiError } from '@/api/request';
import { displayOr, formatDateTime } from '@/utils/format';

const router = useRouter();

const loading = ref(false);
const rows = ref<LeaderApplicationRow[]>([]);
const total = ref(0);
const notes = reactive<Record<string, string>>({});

const summary = reactive<LeadersSummary>({
  totalCount: 0,
  activeCount: 0,
  suspendedCount: 0,
  traineeCount: 0,
  formalCount: 0,
  goldCount: 0,
  chiefCount: 0,
  monthNewCount: 0,
  monthCommissionFen: 0,
  pendingAuditCount: 0,
});

const options = reactive<LeaderFilterOptions>({
  groups: [],
  buildings: [],
  levels: [],
  statuses: [],
});

const query = reactive({
  days: 7,
  buildingId: undefined as number | undefined,
  level: undefined as string | undefined,
  status: undefined as number | undefined,
  keyword: '',
  page: 1,
  pageSize: 20,
});

function asRow(raw: unknown): LeaderApplicationRow {
  return raw as LeaderApplicationRow;
}

function levelTagType(level: string): 'info' | 'success' | 'warning' | 'danger' {
  if (level === 'chief') return 'danger';
  if (level === 'gold') return 'warning';
  if (level === 'formal') return 'success';
  return 'info';
}

function channelText(channel: string): string {
  if (channel === 'qrcode') return '小程序码';
  if (channel === 'poster') return '海报';
  if (channel === 'link') return '分享链接';
  if (channel === 'self') return '直接申请';
  return channel;
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchLeaderApplications({
      days: query.days,
      buildingId: query.buildingId,
      level: query.level,
      status: query.status,
      keyword: query.keyword.trim() || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list ?? [];
    total.value = res.total ?? 0;
    Object.assign(summary, res.summary);
    Object.keys(notes).forEach((k) => delete notes[k]);
    Object.assign(notes, res.notes ?? {});
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '申请流水加载失败');
  } finally {
    loading.value = false;
  }
}

function goDetail(row: LeaderApplicationRow): void {
  router.push({ path: '/leader/detail', query: { id: String(row.id) } });
}

onMounted(async () => {
  try {
    Object.assign(options, await fetchLeaderFilterOptions());
  } catch {
    // 选择器失败不阻断主列表
  }
  await reload();
});
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

    &--wide {
      flex: 1;
      min-width: 240px;
    }
  }

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    font-size: $fs-h2;
    font-weight: 700;

    &--muted {
      color: $c-text-weak;
    }

    &--small {
      font-size: $fs-caption;
      font-weight: 400;
      line-height: 2;
    }
  }

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.dist {
  margin: 0 4px 0 0;
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

.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: $fs-caption;
}

.muted {
  color: $c-text-weak;
}

.pager {
  display: flex;
  justify-content: flex-end;
}
</style>
