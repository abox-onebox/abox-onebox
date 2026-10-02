<template>
  <div class="page-container">
    <h2 class="page-container__title">用户管理 · C 端微信用户</h2>
    <p class="page-container__meta">
      模块：M33（用户域）· 接口：<code>GET /admin/users</code> · <code>PUT /admin/users/:id</code> ·
      数据源 <code>ab_user</code>（手机号脱敏 · openid 仅回后 6 位）
    </p>

    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>本页管的是「吃盒饭的人」</b> —— 后台运营账号（客服 / 财务）在「系统 → 账号管理」。
        两者都叫用户，但没有任何外键关系。
      </template>
    </el-alert>

    <el-alert
      v-if="summary.unboundCount > 0"
      type="warning"
      :closable="false"
      class="note"
      :title="`有 ${summary.unboundCount} 人未绑定办公楼 —— 他们下不了单，而自己只知道「首页一片空白」`"
    >
      <div>
        未绑楼的用户在小程序端会拿到 <code>20016</code>，首页显示「你还没有选择办公楼」。
        可在本页<b>代绑</b>，或让他到「我的 → 切换团长（绑定办公楼）」自助选择。 用上方「绑楼状态 =
        未绑楼（下不了单）」可以直接筛出这批人。
      </div>
    </el-alert>

    <!-- 汇总（按当前过滤条件的全量，不受分页影响） -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">用户总数</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">正常</span>
        <span class="stats__value">{{ summary.normalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">黑名单</span>
        <span class="stats__value stats__value--warn">{{ summary.blacklistCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已注销</span>
        <span class="stats__value stats__value--muted">{{ summary.canceledCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">未绑楼（下不了单）</span>
        <span class="stats__value stats__value--warn">{{ summary.unboundCount }}</span>
      </div>
    </div>

    <!-- 工具条 -->
    <div class="toolbar">
      <el-input
        v-model="query.keyword"
        placeholder="昵称 / 手机号 / openid 后 6 位"
        clearable
        style="width: 240px"
        @keyup.enter="reload()"
        @clear="reload()"
      />
      <el-select
        v-model="query.buildingId"
        placeholder="办公楼"
        clearable
        style="width: 180px"
        @change="reload()"
      >
        <el-option
          v-for="b in options.buildings"
          :key="b.id"
          :label="b.name"
          :value="b.id"
          :disabled="b.status !== 1"
        />
      </el-select>
      <el-select
        v-model="query.status"
        placeholder="账号状态"
        clearable
        style="width: 130px"
        @change="reload()"
      >
        <el-option v-for="s in options.statuses" :key="s.key" :label="s.label" :value="s.key" />
      </el-select>
      <el-select
        v-model="query.bindState"
        placeholder="绑楼状态"
        clearable
        style="width: 180px"
        @change="reload()"
      >
        <el-option v-for="s in options.bindStates" :key="s.key" :label="s.label" :value="s.key" />
      </el-select>
      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">查询</el-button>
      </div>
    </div>

    <el-table v-loading="loading" :data="rows" class="table" stripe size="small">
      <el-table-column label="用户" min-width="140">
        <template #default="{ row }">
          <div class="stack">
            <span class="strong">{{ displayOr(row.nickname) }}</span>
            <span class="stack__sub mono">id {{ row.id }} · openid …{{ row.openidTail }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="手机号" width="130">
        <template #default="{ row }">
          <span class="mono">{{ displayOr(row.phoneMasked) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="办公楼 / 楼群" min-width="180">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(row.buildingName, '未绑定') }}</span>
            <span v-if="row.buildingId && !row.groupName" class="stack__sub stack__sub--warn">
              该楼未归群 —— 下不了单
            </span>
            <span v-else class="stack__sub">{{ displayOr(row.groupName, '—') }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="跟随团长" width="120">
        <template #default="{ row }">
          {{ displayOr(row.leaderName) }}
        </template>
      </el-table-column>

      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag
            size="small"
            effect="plain"
            :type="row.status === 1 ? 'success' : row.status === 2 ? 'danger' : 'info'"
          >
            {{ row.statusLabel }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column prop="orderCount" label="订单数" width="80" align="right" />

      <el-table-column label="注册时间" width="160">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>

      <el-table-column label="操作" width="180" align="center">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row as UserRow)">
            详情
          </el-button>
          <el-button link type="primary" size="small" @click="openEdit(row as UserRow)">
            改绑 / 拉黑
          </el-button>
        </template>
      </el-table-column>

      <template #empty><el-empty description="没有符合条件的用户" /></template>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      :page-size="query.pageSize"
      :total="total"
      layout="total, prev, pager, next"
      class="pager"
      @current-change="reload()"
    />

    <p class="footnote">
      改绑办公楼会<b>同时清空该用户的跟随团长</b>，由服务端按新楼重新匹配 ——
      否则会出现「在新楼下单、佣金记给旧楼团长」且不报错。已注销账号不可改（注销有三道资金闸门，恢复需人工）。
    </p>

    <!-- ─────────────────── 详情抽屉 ─────────────────── -->
    <el-drawer
      v-model="detailVisible"
      :title="`用户详情 · ${detail?.user.nickname ?? ''}`"
      size="560px"
    >
      <div v-if="detail" v-loading="detailLoading">
        <el-alert
          type="info"
          :closable="false"
          class="note"
          title="为什么下不了单 / 该怎么修"
          :description="detail.note"
        />

        <el-descriptions :column="2" border size="small" class="desc">
          <el-descriptions-item label="用户 id">{{ detail.user.id }}</el-descriptions-item>
          <el-descriptions-item label="昵称">
            {{ displayOr(detail.user.nickname) }}
          </el-descriptions-item>
          <el-descriptions-item label="手机号">
            {{ displayOr(detail.user.phoneMasked) }}
          </el-descriptions-item>
          <el-descriptions-item label="openid 尾号">
            …{{ detail.user.openidTail }}
          </el-descriptions-item>
          <el-descriptions-item label="账号状态">
            {{ detail.user.statusLabel }}
          </el-descriptions-item>
          <el-descriptions-item label="注册时间">
            {{ formatDateTime(detail.user.createdAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="办公楼">
            {{ displayOr(detail.user.buildingName, '未绑定') }}
          </el-descriptions-item>
          <el-descriptions-item label="楼群">
            {{ displayOr(detail.user.groupName) }}
          </el-descriptions-item>
          <el-descriptions-item label="跟随团长">
            {{ displayOr(detail.user.leaderName) }}
          </el-descriptions-item>
          <el-descriptions-item label="最近下单">
            {{ formatDateTime(detail.user.lastOrderAt) }}
          </el-descriptions-item>
        </el-descriptions>

        <h4 class="block-title">余额账户（与团长佣金同一账户）</h4>
        <el-descriptions :column="2" border size="small" class="desc">
          <el-descriptions-item label="可用余额">
            {{ fenToCny(detail.balance.balanceFen) }}
          </el-descriptions-item>
          <el-descriptions-item label="冻结额">
            {{ fenToCny(detail.balance.frozenFen) }}
          </el-descriptions-item>
          <el-descriptions-item label="累计收入">
            {{ fenToCny(detail.balance.totalInFen) }}
          </el-descriptions-item>
          <el-descriptions-item label="累计支出">
            {{ fenToCny(detail.balance.totalOutFen) }}
          </el-descriptions-item>
        </el-descriptions>
        <p v-if="!detail.balance.hasBalanceAccount" class="muted">
          尚无余额账户（从未发生资金往来）—— 余额全 0 是正常状态，不是异常。
        </p>

        <h4 class="block-title">最近 10 单</h4>
        <el-table :data="detail.recentOrders" size="small" border>
          <el-table-column prop="orderNo" label="订单号" min-width="150" />
          <el-table-column prop="mealDate" label="出餐日" width="110" />
          <el-table-column prop="quantity" label="份数" width="70" align="right" />
          <el-table-column label="金额" width="90" align="right">
            <template #default="{ row }">{{ fenToCny(row.totalFen) }}</template>
          </el-table-column>
          <el-table-column prop="statusText" label="状态" width="110" />
          <template #empty><el-empty description="该用户还没有订单" :image-size="60" /></template>
        </el-table>
      </div>
    </el-drawer>

    <!-- ─────────────────── 改绑 / 拉黑 ─────────────────── -->
    <el-dialog
      v-model="editVisible"
      :title="`修改用户 · ${editTarget?.nickname ?? ''}`"
      width="520px"
    >
      <el-alert
        v-if="editTarget?.status === 3"
        type="error"
        :closable="false"
        class="note"
        title="已注销账号不可修改 —— 恢复需人工处理"
      />
      <template v-else>
        <div class="field">
          <span class="field__label">办公楼</span>
          <el-select
            v-model="editForm.buildingId"
            placeholder="不选 = 不改动；清空 = 解绑"
            clearable
            style="flex: 1"
          >
            <el-option
              v-for="b in options.buildings"
              :key="b.id"
              :label="b.name"
              :value="b.id"
              :disabled="b.status !== 1"
            />
          </el-select>
        </div>
        <p class="muted">
          清空即<b>解绑</b>：该用户此后下不了单，需到小程序重新选楼。改楼会同时清空跟随团长，
          由服务端按新楼重算。
        </p>

        <div class="field">
          <span class="field__label">账号状态</span>
          <el-radio-group v-model="editForm.status">
            <el-radio :value="1">正常</el-radio>
            <el-radio :value="2">黑名单（登录拦 20006）</el-radio>
          </el-radio-group>
        </div>
        <p class="muted">
          没有「已注销」选项：注销是用户自主发起且有三道资金闸门（在职团长 / 余额 / 在途订单），
          运营改状态等于绕开闸门。
        </p>
      </template>

      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="editTarget?.status === 3"
          @click="confirmEdit"
        >
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 用户管理（后台 · C 端微信用户）
 *
 * ## 收口的是哪一件挂账
 *
 * 全仓 83 个 `/admin/*` 端点里**没有一个 C 端用户的**，后台也没有任何用户页
 * （`api/user.ts` 是一句 `export {}`）。后果是运营面对「用户说他下不了单」时：
 *   查不到人 → 代绑不了楼 → 也拉不黑（`ab_user.status = 2` 有语义、
 *   登录侧有 `20006` 拦截，但没有任何入口能把它置上 —— **有锁没钥匙**）。
 * 本页 + `UserAdminController` 把这块补上。
 *
 * ## ⭐ 本页最有运营价值的一个数是「未绑楼」
 *
 * 未绑楼的用户在小程序首页只能看到一个空态（端上报 `20016`），
 * 而他自己不知道为什么。这个数从 0 变正就是在报警 —— 故给了顶部告警条
 * 与「绑楼状态」筛选器两个出口，而不是只放在表格里等人翻。
 *
 * ## ⚠️ 端上不复刻服务端规则
 * · 状态文案（`statusLabel`）、订单状态文案（`statusText`）、
 *   「为什么下不了单」（`note`）全部服务端下发；
 * · 「该楼未归群」的判据用 `buildingId 有 && groupName 无`，
 *   是**展示**判断，不是业务判断（真正的拦截在 `MealService.resolveUserGroup`）。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  fetchUserDetail,
  fetchUserFilterOptions,
  fetchUsers,
  updateUser,
  type UserDetailResult,
  type UserFilterOptions,
  type UserRow,
} from '@/api/user';
import { displayOr, fenToCny, formatDateTime } from '@/utils/format';

const loading = ref(false);
const rows = ref<UserRow[]>([]);
const total = ref(0);
const query = reactive<{
  keyword: string;
  buildingId?: number;
  status?: number;
  bindState?: string;
  page: number;
  pageSize: number;
}>({ keyword: '', page: 1, pageSize: 20 });

const summary = reactive({
  totalCount: 0,
  normalCount: 0,
  blacklistCount: 0,
  canceledCount: 0,
  unboundCount: 0,
});

const options = ref<UserFilterOptions>({ buildings: [], statuses: [], bindStates: [] });

async function loadOptions() {
  try {
    options.value = await fetchUserFilterOptions();
  } catch (e) {
    ElMessage.error((e as Error).message || '加载筛选项失败');
  }
}

async function reload() {
  loading.value = true;
  try {
    const res = await fetchUsers({
      keyword: query.keyword || undefined,
      buildingId: query.buildingId,
      status: query.status,
      bindState: query.bindState,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list;
    total.value = res.total;
    Object.assign(summary, res.summary);
  } catch (e) {
    ElMessage.error((e as Error).message || '加载用户列表失败');
  } finally {
    loading.value = false;
  }
}

// ------------------------------------------------------------------ 详情

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<UserDetailResult | null>(null);

async function openDetail(row: UserRow) {
  detailVisible.value = true;
  detail.value = null;
  detailLoading.value = true;
  try {
    detail.value = await fetchUserDetail(row.id);
  } catch (e) {
    ElMessage.error((e as Error).message || '加载用户详情失败');
  } finally {
    detailLoading.value = false;
  }
}

// ------------------------------------------------------------------ 改绑 / 拉黑

const editVisible = ref(false);
const saving = ref(false);
const editTarget = ref<UserRow | null>(null);
const editForm = reactive<{ buildingId?: number | null; status?: number }>({
  buildingId: undefined,
  status: undefined,
});

function openEdit(row: UserRow) {
  editTarget.value = row;
  // ⚠️ 初始值是「当前值」而不是 undefined —— 否则运营打开对话框什么都不动
  //    就点保存，会把「不改动」变成「清空」，一次误触就把人解绑了。
  editForm.buildingId = row.buildingId;
  editForm.status = row.status === 3 ? undefined : row.status;
  editVisible.value = true;
}

async function confirmEdit() {
  const row = editTarget.value;
  if (!row) return;

  const payload: { buildingId?: number | null; status?: number } = {};
  if (editForm.buildingId !== row.buildingId) payload.buildingId = editForm.buildingId ?? null;
  if (editForm.status !== undefined && editForm.status !== row.status) {
    payload.status = editForm.status;
  }

  if (Object.keys(payload).length === 0) {
    ElMessage.info('没有需要变更的字段');
    return;
  }

  if (payload.buildingId === null) {
    try {
      await ElMessageBox.confirm(
        '解绑后该用户将无法下单，需到小程序重新选择办公楼。确认解绑？',
        `确认解绑 · ${row.nickname ?? row.id}`,
        { type: 'warning', confirmButtonText: '确认解绑', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }

  saving.value = true;
  try {
    const r = await updateUser(row.id, payload);
    ElMessage.success(r.changed.length ? `已保存：${r.changed.join(' / ')}` : r.note);
    editVisible.value = false;
    await reload();
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await loadOptions();
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
  gap: $space-3;
  margin-bottom: $space-3;

  &__item {
    flex: 1;
    min-width: 120px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: $space-3;
    background: $c-surface-2;
    border-radius: $radius-sm;
  }

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    font-size: 20px;
    font-weight: 600;
    color: $c-text;

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
  align-items: center;
  gap: $space-2;
  flex-wrap: wrap;
  margin-bottom: $space-3;

  &__right {
    margin-left: auto;
  }
}

.table {
  width: 100%;
}

.pager {
  margin-top: $space-3;
}

.stack {
  display: flex;
  flex-direction: column;

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;

    &--warn {
      color: $c-warn-fg;
    }
  }
}

.strong {
  font-weight: 600;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.muted {
  margin: $space-2 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}

.block-title {
  margin: $space-4 0 $space-2;
  font-size: 14px;
  font-weight: 600;
}

.desc {
  margin-top: $space-2;
}

.field {
  display: flex;
  align-items: center;
  gap: $space-3;

  &__label {
    white-space: nowrap;
    font-size: 13px;
    color: $c-text;
  }
}

.footnote {
  margin: $space-3 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}
</style>
