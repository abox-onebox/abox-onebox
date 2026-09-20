<template>
  <div class="page-container">
    <h2 class="page-container__title">{{ auth.isSupplier ? '概览' : '运营概览' }}</h2>
    <p class="page-container__meta">
      当前账号：<b>{{ auth.displayName || '—' }}</b> · 角色：{{ auth.roleLabel || '—' }} · 可见菜单
      {{ cards.length }} 项
    </p>

    <el-alert type="info" :closable="false" show-icon class="note">
      <template #title>
        <b>本页是「导航概览」，不是数据看板</b>
        —— 数字看板在「数据看板」（P35 · M36）。本页只把**当前角色有权打开**的页面列成入口，
        并显示几条锁定口径，方便登录后一眼确认自己该做哪些事。
      </template>
    </el-alert>

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
          T-1 {{ String(BIZ.cutoffHour).padStart(2, '0') }}:00（次日 11:30 送达）
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

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
      <strong>⚠️ 一期说明</strong>：本页只做导航，<strong>不含待办聚合</strong>（待上架分配 /
      待审批退款 / 待审批提现 / 待办汇总）。那需要一个聚合接口，已登记在《悬而未决登记册》 ——
      在此之前，登录落点不再是一张空白占位页。
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 运营概览（登录落点）· `/dashboard`
 *
 * ## 为什么会有这一页（M5-15）
 *
 * `/dashboard` 是本工程**所有角色的登录落点**
 * （`router/routes.ts` 的根路由与 404 兜底都指向它，且 `permission.landingPath`
 * 取的就是 `ADMIN_NAV` 第一组第一项），但它的组件此前是一个
 * **脚手架占位页**（`el-empty` + 一句「业务实现见目录结构映射表」）。
 * 于是**任何人登录后看到的第一屏都是一张空白页** —— 这也是人工测试里
 * 「后台缺某某模块」这类印象的一部分来源（第一屏就没东西，后面即使有也像没有）。
 *
 * ## 它与「数据看板」的分工
 *
 *   · 本页 = **导航概览**（本角色能进哪些页 + 几条锁定口径），零接口、无聚合；
 *   · 数据看板（P35 · M36 · `/stats/core-metrics`）= 真数字（GMV / 份数 / 楼宇榜…）。
 *
 * 刻意**不**把本页做成数据看板的复制品：同一份内容挂在两个菜单下，
 * 运营会以为「两个页面一样」，而后续任何一边改了另一边就悄悄过时。
 *
 * ## 入口是「按菜单算出来的」，不是写死的
 *
 * 卡片直接来自 `permission.visiblePaths` ∩ `ADMIN_NAV`/`SUPPLIER_NAV`，
 * 因此**永远不会给出当前角色打不开的链接**，也不需要在换角色时改本页代码。
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import { BIZ, SET_MEAL_COMPOSITION } from '@abox/shared-utils';
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

  &__title {
    font-weight: 600;
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
