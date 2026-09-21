<template>
  <div class="page-container">
    <h2 class="page-container__title">{{ auth.isSupplier ? '概览' : '工作台' }}</h2>
    <p class="page-container__meta">
      当前账号：<b>{{ auth.displayName || '—' }}</b> · 角色：{{ auth.roleLabel || '—' }}
      <template v-if="todos"> · 业务日 {{ todos.businessDate }} </template> · 入口目录
      {{ cards.length }} 项（不含本页）
    </p>

    <!-- ================= 运营侧：待办 + 今日作业 ================= -->
    <template v-if="!auth.isSupplier">
      <el-alert type="info" :closable="false" show-icon class="note">
        <template #title>
          <b>这一页只回答一个问题：今天有什么必须我来处理的。</b>
          上面是待办 —— 只给计数，点进去处理，明细在各域自己的列表页
          （本页刻意不列明细：两处都列，必然有一处先过时）。
          下面是<strong>当前角色有权打开的页面</strong>目录。 数字看板（GMV / 份数 /
          楼宇榜）仍在「数据 → 数据看板」。
        </template>
      </el-alert>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card__head">
            <span class="card__title">今日待办</span>
            <span class="card__meta">D66 · 口径全在服务端，端上不复刻</span>
          </div>
        </template>

        <el-alert
          v-if="loadError"
          type="warning"
          :closable="false"
          show-icon
          class="card__error"
          :title="`待办数据没取到：${loadError}`"
        >
          <template #default>
            <span class="card__error-text"> 页面上其余内容（入口目录 / 锁定口径）不受影响。 </span>
            <el-button link type="primary" @click="load()">重试</el-button>
          </template>
        </el-alert>

        <!-- 加载骨架：刻意用纯 CSS 而不是 v-loading —— 后者依赖指令自动注册，
             在本工程（组件走 unplugin 自动引入、指令未必）是不必要的风险 -->
        <div v-if="loading" class="todos">
          <div v-for="n in 4" :key="n" class="todo todo--ghost" />
        </div>

        <div v-else-if="todos && todos.items.length" class="todos">
          <button
            v-for="t in todos.items"
            :key="t.key"
            type="button"
            class="todo"
            :class="t.count > 0 ? 'todo--todo' : 'todo--clear'"
            @click="go(t.path)"
          >
            <span class="todo__row">
              <span class="todo__count">{{ t.count }}</span>
              <span class="todo__label">{{ t.label }}</span>
            </span>
            <span class="todo__hint">{{ t.hint }}</span>
            <span class="todo__go">去处理 ›</span>
          </button>
        </div>

        <el-empty
          v-else-if="todos"
          description="当前角色没有待办处理入口（只读观察者只能看看板）"
          :image-size="56"
        />

        <p v-if="todos" class="card__foot">
          ⚠️ 「今日逾期未送达」在送达时刻（11:30）之前恒为 0 —— 未到点不算异常；
          「明日未排套餐的楼群」只数<strong>完全没排</strong>的楼群，已排待上架的（pending）不算，
          否则这张卡在开团前永远非零，很快就会被无视。
        </p>
      </el-card>

      <el-card v-if="todos" shadow="never" class="card">
        <template #header><span class="card__title">今日作业</span></template>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="今日配送">
            {{ todos.brief.deliveryArrived }} / {{ todos.brief.deliveryTotal }} 单已送达
          </el-descriptions-item>
          <el-descriptions-item label="明日套餐">
            {{ todos.brief.tomorrowGroupsAssigned }} /
            {{ todos.brief.tomorrowGroupsTotal }} 个启用楼群已排
          </el-descriptions-item>
        </el-descriptions>
      </el-card>
    </template>

    <el-alert v-else type="info" :closable="false" show-icon class="note">
      <template #title>
        本页把<strong>当前账号有权打开的页面</strong>列成入口（按服务端下发的菜单取交集），
        并显示几条锁定口径 —— 登录后一眼确认自己该做哪些事。
      </template>
    </el-alert>

    <!-- ================= 锁定口径 ================= -->
    <el-card shadow="never" class="card">
      <template #header><span class="card__title">锁定口径（改一处必改全链路）</span></template>
      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="售价"
          >{{ BIZ.unitPrice.toFixed(2) }} 元/份</el-descriptions-item
        >
        <el-descriptions-item label="套餐构成">{{
          SET_MEAL_COMPOSITION.rule
        }}</el-descriptions-item>
        <el-descriptions-item label="截单时刻">
          <!-- ⚠️ PR-02 收口：原先写死「（次日 11:30 送达）」。本卡是**静态口径卡**（整张卡由 `BIZ`
               常量驱动），而送达时刻的**真源在服务端时间轴**（`order-timeline.ts`，后台可改）。
               不给端上再加一个镜像常量（那会制造第三份表述）—— 此处只留口径，**具体时刻以
               「系统配置 → 时间轴」的生效值为准**。 -->
          T-1 {{ String(BIZ.cutoffHour).padStart(2, '0') }}:00（次日送达，实际时刻见「系统配置」）
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <!-- ================= 入口目录 ================= -->
    <el-card v-for="g in groups" :key="g.group" shadow="never" class="card">
      <template #header
        ><span class="card__title">{{ g.group }}</span></template
      >
      <div class="links">
        <button
          v-for="it in g.items"
          :key="it.path"
          class="link"
          type="button"
          @click="go(it.path)"
        >
          <span class="link__title">{{ it.title }}</span>
          <span class="link__meta">{{ it.page }} · {{ it.module }}</span>
        </button>
      </div>
    </el-card>

    <p class="hint">
      <strong>⚠️ 一期说明</strong>：本页的待办是<strong>聚合计数</strong>（D66 · M5-16），
      只覆盖「到期必须有人处置」的四件事；明细请点进对应页面。
      其余待办（如履约异常、供应商报量缺口）需要各自的领域接口，<strong>未在</strong>本页冒充。
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 工作台（登录落点）· `/dashboard`
 *
 * ## 这一页的定位（M5-15 建立 · M5-16 升级为真工作台）
 *
 * `/dashboard` 是本工程**所有角色的登录落点**（`router/routes.ts` 的根路由与 404 兜底
 * 都指向它，`permission.landingPath` 取的是 `ADMIN_NAV` 第一组第一项），
 * 因此它必须同时服务三种人：
 *
 *   · **运营 / 财务** —— 想知道「今天有什么必须我处理的」⇒ 顶部 4 张待办卡（D66）；
 *   · **只读观察者（viewer）** —— 只有看板菜单，四张待办卡一张都点不进去
 *     ⇒ 按可见菜单过滤后自然为空，页面显示「没有待办处理入口」而**不是**伪造数字；
 *   · **供应商** —— 走完全不同的菜单树（`SUPPLIER_NAV`），**不发**待办请求
 *     （`/admin/*` 对 `typ='supplier'` 的令牌一律 10004，发了只会白挨一次错误）。
 *
 * ## 三件必须守住的事
 *
 * ① **待办数字不由前端算**。四个计数全来自 `GET /admin/dashboard/todos`。
 *    前端各打一次列表接口再数条数会撞上三件事：列表分页拿不到总数、四次请求时序不同
 *    导致卡片互相打架、以及**前端复刻四份状态口径必然漂移**。
 * ② **入口是「按菜单算出来的」，不是写死的**。卡片来自 `permission.visiblePaths`
 *    ∩ `ADMIN_NAV`/`SUPPLIER_NAV` ⇒ 永远不会给出当前角色打不开的链接。
 * ③ **待办卡也要按菜单过滤**（同上一条的推论）：服务端对五个运营角色一律返回 4 条
 *    （同源纪律见 `DashboardController` 注释），但 `viewer` 点不进去 `/finance/*`
 *    ⇒ 端上必须自己滤掉，否则会出现「能点、点了 403」——那正是最容易被当成 bug 的一类不一致。
 *
 * ## 为什么不把本页做成数据看板的复制品
 *
 * 「数据看板」（P35 · M36 · `/stats/core-metrics`）给的是**经营数字**（GMV / 份数 / 榜单）；
 * 本页给的是**作业清单**（谁该去批什么、哪个楼群还没排）。同一份内容挂两个菜单，
 * 运营会以为「两个页面一样」，而后续任何一边改了另一边就悄悄过时。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { BIZ, SET_MEAL_COMPOSITION } from '@abox/shared-utils';
import { fetchWorkbenchTodos } from '@/api/dashboard';
import type { WorkbenchTodosResult } from '@/api/dashboard';
import { ADMIN_NAV, SUPPLIER_NAV } from '@/constants';
import { useAuthStore } from '@/stores/auth';
import { usePermissionStore } from '@/stores/permission';

const router = useRouter();
const auth = useAuthStore();
const perm = usePermissionStore();

interface Card {
  path: string;
  title: string;
  page: string;
  module: string;
}

/** 本角色可见的全部入口（去掉自己，避免「工作台 → 工作台」） */
const cards = computed<Card[]>(() => {
  const visible = new Set(perm.visiblePaths);
  const flat: Card[] = auth.isSupplier
    ? SUPPLIER_NAV.map((i) => ({ ...i }))
    : ADMIN_NAV.flatMap((g) => g.items.map((i) => ({ ...i })));

  return flat.filter((i) => visible.has(i.path) && i.path !== '/dashboard');
});

/** 按导航分组呈现（供应商侧单组） */
const groups = computed(() => {
  const byPath = new Map(cards.value.map((c) => [c.path, c]));
  // ⚠️ 用 `ReadonlyArray` 承接：`ADMIN_NAV` / `SUPPLIER_NAV` 都是 `as const` 的只读元组，
  //    写成可变数组类型会直接编译失败（TS4104）。
  const source: ReadonlyArray<{ group: string; items: ReadonlyArray<{ path: string }> }> =
    auth.isSupplier ? [{ group: '商家', items: SUPPLIER_NAV }] : ADMIN_NAV;
  return source
    .map((g) => ({
      group: g.group,
      items: g.items.map((i) => byPath.get(i.path)).filter((i): i is Card => !!i),
    }))
    .filter((g) => g.items.length > 0);
});

// ---------------------------------------------------------------------------
// D66 待办（仅运营侧）
// ---------------------------------------------------------------------------

const loading = ref(false);
const loadError = ref('');
const raw = ref<WorkbenchTodosResult | null>(null);

/**
 * 待办**再按可见菜单过滤一次**（见页头注释 ③）。
 *
 * 用 `visiblePaths` 而不是 `auth.canSee`：前者含前缀匹配语义（与路由守卫同一判据），
 * 且已经过 `NAV ∩ menus` 取交集 —— 一个来源，不在本页另立一套判定。
 */
const todos = computed<WorkbenchTodosResult | null>(() => {
  if (!raw.value) return null;
  const visible = new Set(perm.visiblePaths);
  return { ...raw.value, items: raw.value.items.filter((t) => visible.has(t.path)) };
});

async function load(): Promise<void> {
  // ⚠️ 供应商侧不发这个请求：`/admin/*` 对供应商令牌恒 10004，白挨一次错误
  if (auth.isSupplier) return;
  loading.value = true;
  loadError.value = '';
  try {
    raw.value = await fetchWorkbenchTodos();
  } catch (e) {
    // 待办取不到**不阻塞本页**：入口目录与锁定口径仍然有用，故只降级提示
    loadError.value = e instanceof Error ? e.message : '未知错误';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

function go(path: string): void {
  void router.push(path);
}
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.note {
  margin-bottom: $space-3;

  :deep(.el-alert__title) {
    line-height: 1.7;
  }
}

.card {
  margin-bottom: $space-3;
  border-color: $c-border;

  &__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: $space-2;
  }

  &__title {
    font-weight: 600;
  }

  &__meta {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__error {
    margin-bottom: $space-2;
  }

  &__error-text {
    margin-right: $space-1;
  }

  &__foot {
    margin: $space-2 0 0;
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.7;
  }
}

.todos {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

.todo {
  display: flex;
  flex: 1 1 210px;
  flex-direction: column;
  gap: 2px;
  min-width: 190px;
  padding: $space-3;
  border: 1px solid $c-border;
  border-left-width: 3px;
  border-radius: $radius-md;
  background: $c-surface;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s;

  &--todo {
    border-left-color: $c-warning;
  }

  &--clear {
    border-left-color: $c-success;
    cursor: default;
    opacity: 0.75;

    .todo__go {
      display: none;
    }
  }

  &--ghost {
    height: 92px;
    cursor: default;
    opacity: 0.5;
  }

  &:not(.todo--ghost):hover {
    border-color: $c-gold;
  }

  &__row {
    display: flex;
    align-items: baseline;
    gap: $space-2;
  }

  &__count {
    color: $c-text;
    font-size: 26px;
    font-weight: 700;
    line-height: 1.1;
  }

  &__label {
    color: $c-text;
    font-size: $fs-body;
    font-weight: 600;
  }

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.6;
  }

  &__go {
    margin-top: 2px;
    color: $c-info;
    font-size: $fs-caption;
  }
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

.link {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 148px;
  padding: $space-2 $space-3;
  border: 1px solid $c-border;
  border-radius: $radius-md;
  background: $c-surface;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s;

  &:hover {
    border-color: $c-gold;
  }

  &__title {
    color: $c-text;
    font-size: $fs-body;
    font-weight: 600;
  }

  &__meta {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.hint {
  margin: $space-3 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}
</style>
