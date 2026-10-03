<template>
  <view class="page">
    <ab-loading v-if="loading && !data" text="正在取今日出品方" />

    <template v-else-if="data">
      <!-- 今日未开团：只留一句说明，不摆空版式（说明卡与空态文案会重复） -->
      <ab-empty-state
        v-if="isEmpty"
        text="今日暂无出品方信息"
        :hint="data.traceNote"
        illustration="store"
        action-text="重新加载"
        @action="load"
      />

      <template v-else>
        <!-- 溯源说明卡（米金浅底 + 金棕描边 · 原型 P38） -->
        <view class="trace-card">
          <view class="trace-card__hd">
            <text class="abi abi-24 trace-card__icon">{{ I.search }}</text>
            <text class="trace-card__title">今日这盒 · 溯源</text>
          </view>
          <text class="trace-card__text">{{ data.traceNote }}</text>
        </view>

        <!-- 出品方卡（一菜一卡 · 原型 5 张 = 4 家供应商 + 1 个集散中心） -->
        <ab-supplier-card
          v-for="(d, i) in data.dishes"
          :key="`${d.supplier.id}-${d.dishName}-${i}`"
          :avatar-icon="dishIcon(d.category)"
          :name="d.supplier.name"
          :category="categoryLabel(d.category)"
          :detail="`今日出品：${d.dishName}`"
          :verified="verifiedText(d.supplier.qualifications)"
          clickable
          :highlight="focusId === d.supplier.id"
          @tap="goDetail(d.supplier.id)"
        />

        <!-- 集散中心（主食与打包 · 无资质页，故不可点） -->
        <ab-supplier-card
          v-if="data.distributionCenter"
          avatar-icon="rice"
          :name="data.distributionCenter.name"
          category="主食"
          detail="今日出品：米饭与打包"
          :extra="data.distributionCenter.address"
        />

        <text class="page__entry" @tap="goSupplierList">查看全部出品方资质 ›</text>
      </template>
    </template>

    <ab-empty-state
      v-else
      :text="emptyText"
      :hint="emptyHint"
      illustration="search"
      :action-text="userStore.info?.buildingId ? '重新加载' : ''"
      @action="load"
    />

    <text v-if="data && !isEmpty" class="page__ft">
      想推荐新商家？点击右下角「我的 → 客服」告诉我们
    </text>

    <ab-bottom-bar active="traceability" />
  </view>
</template>

<script setup lang="ts">
/**
 * P38 · 今日这盒 · 商家溯源（C8）
 *
 * ⭐ 版式基准 = `prototype/index.html` renderP38（v4.9.1 C8 改版）：
 *   溯源说明卡 → 出品方卡（4 家菜品供应商 + 1 个集散中心）→ 页脚 → 底部「供应商」tab。
 *   点出品方卡 → **跳该出品方的资质详情**（`pages/supplier/detail`）。
 *
 * ## 这一页存在的理由
 * 「不喜欢今天的套餐也没关系」—— 用户可以顺着溯源卡找到**具体是哪家做的这道菜**。
 * 把「一盒拼配」的透明度变成信任，而不是让人怀疑「这盒到底是谁做的」。
 *
 * ## ⚠️⭐ 2026-10-03：本页**不再提供任何外卖平台跳转**（勿加回来）
 * 原先点卡片弹出「美团 / 淘宝 / 京东」三平台层，跳不了时降级为「复制店名 + 引导搜索」。
 * 逐字复核《微信小程序平台运营规范》后确认这两种形态都不合规：
 *   · **5.10 互推行为** —— 不得对其他 APP 进行推荐、推广，也不得为上述行为提供
 *     任何**协助或便利**；处理规则是**下架**（现行原文已删去「未经腾讯书面同意」前缀）；
 *   · **5.20 诱导下载行为** —— 逐字含「通过利用**剪切板**能力来达到诱导跳转 /
 *     下载 APP 目的的行为」。即「不跳转、只复制」并不是安全替代，而是换了一条
 *     被单独点名的路；
 *   · **5.15.4 / 5.16** —— 滥用操作剪切板接口 → 封禁剪切板能力直至封号。
 * ⇒ 信任证据改由**自持证照**承载（见 `pages/supplier/*`）：那才是用户真正要看的
 *   （有没有证、过没过期），且完全落在自己域内。本页只负责「今天这盒是谁做的」。
 *
 * ## 数据来源
 * U5 `GET /traceability/today?buildingId=`（**免登录只读**）。楼群必须由端上给：
 * 端上从登录态 `user.buildingId` 取；拿不到就引导走团长邀请链接（同首页口径）。
 *
 * ## 入参（M5-17）
 * `?supplierId=<ab_supplier.id>` —— 首页「来自：X」点进来时带入。页面会**定位到那家**：
 * 卡片描金圈。缺省（从底部「供应商」tab 进入）即正常展示全部出品方。
 * 按 **id** 而非名字定位：`ab_supplier.name` 无唯一约束，同名两家会认错店。
 */
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import type { TraceabilityQualification, TraceabilityTodayResult } from '@abox/shared-types';
import { DISH_CATEGORY_LABEL, TRACEABILITY_QUALIFICATION_LABEL } from '@abox/shared-types';

import { fetchTraceabilityToday } from '@/api/traceability';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useUserStore } from '@/stores/user';
import { dishIcon } from '@/utils/format';
import { navigateTo } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const userStore = useUserStore();
const { run, loading } = useRequest();

const data = ref<TraceabilityTodayResult | null>(null);
const loadError = ref<ApiError | null>(null);

/**
 * 被「定位」的出品方 id（M5-17）—— 由首页「来自：X」跳过来时带 `supplierId`
 *
 * 命中的那张卡会描金圈（`ab-supplier-card` 的 `highlight`）。
 * 用户在 4~5 张同版式的卡里不该自己找哪张是刚点的那家。
 */
const focusId = ref<number | null>(null);

/**
 * 尚未消费的定位请求（`onLoad` 写入 → 首次取数成功后消费并清空）
 *
 * ⚠️ 为什么不直接让 `onLoad` 去定位：那一刻 U5 还没回来，`dishes` 是空的。
 *    故 `onLoad` 只**记下意图**，由 `load()` 兑现。
 */
const pendingSupplierId = ref<number | null>(null);

const isEmpty = computed(
  () => (data.value?.dishes.length ?? 0) === 0 && !data.value?.distributionCenter,
);

const emptyText = computed(() =>
  userStore.info?.buildingId ? '本楼今日暂无溯源信息' : '还未绑定办公楼',
);
const emptyHint = computed(() => {
  if (!userStore.info?.buildingId) return '请通过该楼团长的邀请链接进入，绑定后即可查看';
  return loadError.value?.message ?? '开团后可在这里看到本盒的出品方';
});

/** 品类编码（main/half/veg/soup/staple）→ 中文（主荤/半荤/素菜/汤品/主食） */
function categoryLabel(category: string | null): string | null {
  if (!category) return null;
  return (DISH_CATEGORY_LABEL as Record<string, string>)[category] ?? null;
}

/** 核验行文案；**无在册资质时不编造**（返回 null ⇒ 卡片不渲染该行） */
function verifiedText(qualifications: TraceabilityQualification[]): string | null {
  if (!qualifications.length) return null;
  return `已核验 · ${qualifications.map((q) => TRACEABILITY_QUALIFICATION_LABEL[q]).join(' · ')}`;
}

/** 点出品方卡 → 它的资质详情（不再弹平台层，理由见本文件头注） */
function goDetail(id: number): void {
  navigateTo(`/pages/supplier/detail?id=${id}`);
}

function goSupplierList(): void {
  navigateTo('/pages/supplier/list');
}

/** 拉取溯源数据；未绑定楼群时不发请求，直接走空态引导 */
async function load(): Promise<void> {
  const buildingId = userStore.info?.buildingId ?? null;
  if (!buildingId) {
    data.value = null;
    loadError.value = null;
    return;
  }

  try {
    data.value = await run(() => fetchTraceabilityToday(buildingId));
    loadError.value = null;
    consumePendingSupplier();
  } catch (e) {
    loadError.value = e instanceof ApiError ? e : null;
    toastApiError(e);
  }
}

/**
 * 兑现「定位某家出品方」的意图（M5-17）
 *
 * 按 `supplier.id` 匹配，**不按名字**：`ab_supplier.name` 无唯一约束
 * （同名两家是合法数据），按名字定位会认错店。
 *
 * 找不到时**明说**，不静默：跳过来却什么都不发生，用户只会以为页面坏了。
 * 真会发生的场景是「首页取的是 T+1 套餐，跳转途中跨过 24:00 截单换日」。
 */
function consumePendingSupplier(): void {
  const target = pendingSupplierId.value;
  if (target === null) return;
  pendingSupplierId.value = null;

  const hit = data.value?.dishes.find((d) => d.supplier.id === target);
  if (hit) {
    focusId.value = target;
    return;
  }
  uni.showToast({ title: '该出品方今日不在名单中', icon: 'none' });
}

/**
 * 入参 `supplierId`（首页「来自：X」带入）
 *
 * ⚠️ 只解析、不取数：`buildingId` 要从登录态取，而登录态在冷启动下由 `onShow` 处
 *    的既有链路保证就绪；这里抢跑反而会在「token 还没就位」时白跑一次请求。
 */
onLoad((query) => {
  const raw = query?.supplierId;
  const id = Number(raw);
  pendingSupplierId.value = Number.isFinite(id) && id > 0 ? id : null;
});

onShow(() => {
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  // 固定底栏高度 + 安全区（见 ab-bottom-bar 头注：使用该组件的页面必须留出）
  padding-bottom: 200rpx;
  box-sizing: border-box;

  &__entry {
    display: block;
    margin: $space-4 $space-4 0;
    font-size: $fs-caption;
    color: $c-text-weak;
    text-align: center;
  }

  &__ft {
    display: block;
    margin: $space-4 $space-4 0;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
    text-align: center;
  }
}

// ---- 溯源说明卡（米金浅底 + 金棕描边） ----
.trace-card {
  margin: $space-3 $space-4 0;
  padding: $space-4;
  background: linear-gradient(135deg, $c-trace-card-from, $c-trace-card-to);
  border: 1px solid $c-gold;
  border-radius: $radius-lg;

  &__hd {
    display: flex;
    align-items: center;
  }

  &__icon {
    line-height: 1;
  }

  &__title {
    margin-left: $space-2;
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__text {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    line-height: 1.85;
    color: $c-text;
  }
}
</style>
