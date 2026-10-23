<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP1（v4.10.0）：
         倒计时深棕横幅 → 套餐概念大卡 →（团长身份横幅）→ 跟随团长卡 → 无团长引导 → 一饭四菜 → 价格份数 → 立即预订 -->

    <!-- 倒计时横幅（深棕 · 金字 · 居中） -->
    <view v-if="daily" class="countdown">
      <text class="countdown__label">距离截单还剩</text>
      <text class="countdown__num">{{ countdownText }}</text>
      <!-- ⭐ 时刻从响应取（`daily.cutoffAt`）—— 曾写死 `24:00`（2026-10-07 复查⑰） -->
      <text v-if="cutoffTimeText" class="countdown__sub">{{ cutoffTimeText }} 后将无法下单</text>
    </view>

    <!-- 首屏骨架 -->
    <ab-loading v-if="loading && !daily" text="正在取今日组合" />

    <template v-else-if="daily">
      <!-- 套餐概念大卡（米金渐变） -->
      <view class="hero-card">
        <text class="hero-card__date">{{ mealDateCn }}</text>
        <view class="hero-card__pill">
          <text class="hero-card__pill-text">{{ heroSlogan }}</text>
          <text v-if="deliverLine" class="hero-card__pill-text hero-card__pill-text--func">
            <text class="abi abi-16">{{ I.clock }}</text> {{ deliverLine }}
          </text>
        </view>
      </view>

      <!-- 团长身份横幅（L10：仅 isLeader=true 时显示 → 团长工作台 P11） -->
      <view
        v-if="leaderStore.isLeader"
        class="leader-banner"
        hover-class="leader-banner--hover"
        @tap="goWorkbench"
      >
        <text class="abi abi-deco-28 leader-banner__icon">{{ I.package }}</text>
        <view class="leader-banner__main">
          <text class="leader-banner__title">您是{{ leaderLevelLabel }}团长</text>
          <text class="leader-banner__sub">{{ daily.leader?.building ?? '' }}</text>
        </view>
        <text class="leader-banner__chip">进入工作台 ›</text>
      </view>

      <!-- 跟随团长卡（M5-17：明示「佣金归谁」—— 见 leaderSourceText 头注） -->
      <view v-if="daily.leader" class="card" @tap="tapSwitchLeader">
        <view class="leader-row">
          <view class="leader-row__left">
            <text class="leader-row__label">{{ leaderLabel }}</text>
            <text class="leader-row__name">{{ daily.leader.name || '本楼团长' }}</text>
            <text class="leader-row__building">{{ daily.leader.building }}</text>
            <text class="leader-row__source" :class="`leader-row__source--${daily.leader.source}`">
              {{ leaderSourceText }}
            </text>
          </view>
          <text class="leader-row__switch">点此切换 ›</text>
        </view>
      </view>

      <!-- 找不到团长时的引导（v4.6） -->
      <view v-if="!daily.leader && !leaderStore.isLeader" class="guide">
        <text class="guide__text">
          <text class="abi abi-16">{{ I.info }}</text> 所在办公楼没有团长？
          <text class="guide__link" @tap="goLeaderApply">申请成为团长</text>
          （无需审核，立即上岗），或通过该楼团长的邀请链接进入。
        </text>
      </view>
      <view v-else-if="!daily.canOrder" class="guide guide--warn">
        <text class="guide__text">{{ daily.reason ?? '当前不可下单' }}</text>
      </view>

      <!-- 本日精选（两列菜品卡网格 · 点击卡片打开菜品弹窗；「查看资质」→ 出品方资质页） -->
      <view class="card">
        <text class="card__title"
          ><text class="abi abi-16">{{ daily?.kind === 'fmcg' ? I.package : I.rice }}</text>
          本日精选</text
        >
        <view class="dish-grid">
          <view
            v-for="(d, i) in daily.items"
            :key="i"
            class="dish-card"
            hover-class="dish-card--hover"
            @tap="openDish(d)"
          >
            <view class="dish-card__media" :class="{ 'dish-card__media--fallback': !d.imageUrl }">
              <image v-if="d.imageUrl" class="dish-card__img" :src="d.imageUrl" mode="aspectFill" />
              <text v-else class="dish-card__letter">{{ initial(d.name) }}</text>
              <view v-if="d.category" class="dish-card__badge">{{ d.category }}</view>
            </view>
            <view class="dish-card__body">
              <text class="dish-card__name">{{ d.name }}</text>
              <text v-if="d.supplierName" class="dish-card__supplier">{{ d.supplierName }}</text>
              <view
                v-if="d.supplierId"
                class="dish-card__qual"
                hover-class="dish-card__qual--hover"
                @tap.stop="openSupplier(d)"
              >
                <text class="abi abi-16 dish-card__qual-icon">{{ I.shield }}</text>
                <text class="dish-card__qual-text">查看资质</text>
                <text class="abi abi-16 dish-card__qual-arrow">{{ I.chev }}</text>
              </view>
            </view>
          </view>
        </view>
        <!-- 主食（随附 · 集散中心统一供应） -->
        <view v-if="daily.rice" class="dish-row">
          <view class="dish-row__ico">
            <text class="abi abi-deco-34">{{ I.rice }}</text>
          </view>
          <view class="dish-row__info">
            <text class="dish-row__name">{{ daily.rice }}</text>
            <view class="dish-row__from-wrap">
              <text class="dish-row__from">随附 · 集散中心统一供应</text>
            </view>
          </view>
        </view>

        <!-- x 盲盒（轻量小辅助）：本单随附一份轻食惊喜，下单时不定内容，送达后揭晓 -->
        <view class="blind-row">
          <view class="blind-row__ico">
            <text class="abi abi-deco-34">{{ I.gift }}</text>
          </view>
          <view class="blind-row__info">
            <text class="blind-row__name">随单附赠 · x 盲盒</text>
            <view class="blind-row__from-wrap">
              <text class="blind-row__from">下单后送达时揭晓 · 一份轻食惊喜</text>
            </view>
          </view>
        </view>
      </view>

      <!-- 价格 + 份数 -->
      <view class="card">
        <view class="price-row">
          <view class="price-row__left">
            <text class="price-row__label">统一售价</text>
            <view class="price-row__price">
              <text class="price-big">¥{{ unitPriceText }}</text>
              <text class="price-unit">/份</text>
            </view>
          </view>
          <view v-if="canPickQuantity" class="qty-control">
            <view class="qty-btn" :class="{ 'is-disabled': quantity <= 1 }" @tap="decQty">
              <text>−</text>
            </view>
            <text class="qty-value">{{ quantity }}</text>
            <view
              class="qty-btn"
              :class="{ 'is-disabled': quantity >= ORDER_MAX_QUANTITY }"
              @tap="incQty"
            >
              <text>+</text>
            </view>
          </view>
        </view>
      </view>

      <text class="max-hint">单笔最多 {{ ORDER_MAX_QUANTITY }} 份</text>

      <!-- 已订概览：一人一日可多单（2026-10-03），这里只做「你已经订了多少」的告知，
           不再当拦截条件 —— 否则用户看到份数控件消失会以为不能订了 -->
      <view v-if="hasOrder" class="guide">
        <text class="guide__text"> {{ orderedSummary }} · 可继续追加 </text>
      </view>

      <button
        v-if="daily.canOrder"
        class="btn-primary"
        hover-class="btn-primary--hover"
        @tap="goCreate"
      >
        {{ orderBtnText }} ¥{{ totalText }}
      </button>
      <button v-else class="btn-primary btn-primary--disabled" disabled>本场已截单</button>

      <button
        v-if="hasOrder"
        class="btn-primary btn-primary--ghost"
        hover-class="btn-primary--hover"
        @tap="goDetail"
      >
        查看今日订单
      </button>
    </template>

    <ab-empty-state
      v-else
      :text="emptyText"
      :hint="emptyHint"
      illustration="box"
      :action-text="emptyActionText"
      @action="onEmptyAction"
    />

    <ab-bottom-bar active="index" />

    <!-- 菜品弹窗（方案B 居中模态卡 · 下拉关闭 · 门店实拍 · 查看资质入口） -->
    <ab-dish-popup
      :visible="popupVisible"
      :item="popupItem"
      :photos="popupPhotos"
      @close="closeDish"
    />
  </view>
</template>

<script setup lang="ts">
/**
 * P1 · 首页（融合套餐详情）
 *
 * ⭐ 版式基准 = prototype/index.html renderP1（v4.10.0 · 2026-09-18 裁定「19 页逐页对齐原型」）：
 *   倒计时深棕横幅 → 套餐概念大卡 →（团长身份横幅 · L10 仅 isLeader）→ 跟随团长卡 →
 *   无团长引导 → 一饭四菜（含主食行）→ 价格 + 份数 → 立即预订。
 *
 * 验收要点（M1 标准 1 / 5）：
 *   · 微信授权后**直接进首页**，不索要手机号与地址（C3 / L9）
 *   · 倒计时显示距 T-1 24:00 的真实剩余时间（以服务端 `countdownSec` 起表）
 *
 * 数据来源：U1 明日套餐（含 `canOrder` 权威判定、已有订单、跟随团长）。
 *
 * ## M5-17 三处调整（本页）
 * ① **移除「往日这盒」**：首页只保留「今天订不订」这一件事。U2 接口与端上封装
 *    `fetchHistory` **均保留**（M1 既有验收点，且日后做「历史」入口可直接复用），
 *    只是不再占首页版位 —— 首页每多一块，主按钮就往下掉一屏。
 * ② **「查看资质」可点** → 每道菜卡片底部「查看资质 ›」跳 `supplier/detail?id=`
 *    （自持证照，不引外链；溯源页已于 2026-10-23 删除）。按 id 不按名字：
 *    `ab_supplier.name` 无唯一约束。
 * ③ **明示佣金归属**（`leader.source`）：未走邀请链接的用户会被**自动挂靠**本楼在任团长，
 *    下单佣金也归那位 —— 这件事必须写在脸上，而不是让用户以为「我没跟谁」。
 *    ⭐ 与之配套的后端修正：U1 的团长判据此前**不看在职**，与真正决定钱的
 *    `OrderService.resolveLeader` 不一致（停职团长会被显示却收不到佣金）——
 *    已在 M5-17 对齐（缺陷 ⑫）。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { HomeDailyResult, MealItemView } from '@abox/shared-types';
import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';

import { fetchDaily } from '@/api/meal';
import { fetchMe } from '@/api/auth';
import { fetchSupplierQualifications } from '@/api/traceability';
import { ApiError, CODE_BUILDING_UNBOUND } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useCountdown } from '@/composables/use-countdown';
import { buildUrl, navigateTo } from '@/utils/router';
import { formatMealDate, formatTime } from '@/utils/format';
import { ORDER_MAX_QUANTITY } from '@/constants';
import { useLeaderStore } from '@/stores/leader';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const leaderStore = useLeaderStore();
const { run, loading } = useRequest();
const { remainSec, start } = useCountdown();

const daily = ref<HomeDailyResult | null>(null);
const loadError = ref<ApiError | null>(null);
/** 份数（原型 P1 的 stepper；带入 P3 下单确认） */
const quantity = ref(1);

// ---- 菜品弹窗（方案B 居中模态卡） ----
const popupVisible = ref(false);
const popupItem = ref<MealItemView | null>(null);
/**
 * 门店实拍（决策2·方案B 保留照片墙）—— 后端已落地 `store_photos` 列（迁移 1700000000015）
 * 与 `SupplierQualificationDetail.photos` / `SupplierQualificationItem.photos` 下发字段。
 * 数据由 `loadSupplierPhotos()` 从资质墙列表构建 `supplierId → 照片` 映射，
 * 在 `openDish` 时按 `d.supplierId` 注入；取不到则为空数组 ⇒ 弹窗照片墙整体隐藏、版式不崩。
 */
const popupPhotos = ref<{ url: string }[]>([]);

/** supplierId → 门店实拍（仅 serving 组下发；首页弹窗照片墙数据来源） */
const supplierPhotos = ref<Record<number, { url: string }[]>>({});

/**
 * 拉取资质墙列表，构建 supplierId → 门店实拍 映射（首页弹窗照片墙用）
 *
 * ⚠️ 照片墙是**可选增强**：取不到不阻断首页、不报错（try/catch 静默吞掉），
 * 最坏情况只是弹窗照片墙整体隐藏，与「后端未配照片」时行为一致。
 */
async function loadSupplierPhotos(): Promise<void> {
  try {
    // ⚠️ 显式挂 `keepAuthState: true`：本接口 `auth:false`（免登录只读），
    //    它不该参与鉴权态清理；`mp:no-bare-call` 是静态扫描，看不出 `auth:false`。
    const list = await fetchSupplierQualifications({ keepAuthState: true });
    const map: Record<number, { url: string }[]> = {};
    for (const s of list.serving) {
      if (s.id && s.photos?.length) map[s.id] = s.photos.map((p) => ({ url: p.url }));
    }
    supplierPhotos.value = map;
  } catch {
    // 可选增强，失败不影响首页其余功能
  }
}

function openDish(d: MealItemView): void {
  popupItem.value = d;
  popupPhotos.value = (d.supplierId ? supplierPhotos.value[d.supplierId] : undefined) ?? [];
  popupVisible.value = true;
}

function closeDish(): void {
  popupVisible.value = false;
}

/** 菜品卡 / 头图无图时的首字兜底（不写死色块，真实拍照就位后自动走全图） */
function initial(name: string | null | undefined): string {
  const ch = name?.charAt(0);
  return ch ? ch.toUpperCase() : '菜';
}

/**
 * ⭐ 空态**按错误码分级**，不再一句「本楼今日未开团」兜全部
 *
 * 此前 `emptyText` 对**任何** `loadError.code` 都返回同一句，于是
 * 「你还没绑定办公楼」（本可自助）与「本楼今日真的没开团」（只能等）
 * 在界面上长得一模一样 —— 用户能做的只有反复点「重新加载」。
 * 服务端已把前者拆成独立码 `20016`（见 `ErrorCode.USER_BUILDING_UNBOUND`），
 * 这里据此把**主按钮也换掉**：能自己解决的事，按钮就该指向解决办法。
 */
const needsBuilding = computed(() => loadError.value?.code === CODE_BUILDING_UNBOUND);

const emptyText = computed(() => {
  if (loadError.value?.code === undefined) return '今日暂无开团';
  return needsBuilding.value ? '你还没有选择办公楼' : '本楼今日未开团';
});

const emptyHint = computed(() => loadError.value?.message ?? '选好办公楼后即可查看次日组合');

/**
 * 截单时刻（`HH:mm`）—— **从响应取**，端上不写死
 *
 * ⭐ 2026-10-07 整体复查⑰：本行原写死「今晚 24:00 后将无法下单」。
 *    而 `cutoffAt` 是服务端按**生效时间轴**派生的（后台可改截单时刻），
 *    写死就会出现「后台已把截单改成 23:00、横幅还写 24:00」——
 *    且改 09:30 那种第二份定义时全仓门禁**一条都不红**（`dup:const` 只拦 `'11:30'`）。
 *
 * ⚠️ 取不到时返回空串 ⇒ **整行不显示**，而不是回落到某个写死值 ——
 *    回落值就是新的硬编码，等于把同一个缺陷换个位置留下来。
 */
const cutoffTimeText = computed(() => {
  const t = formatTime(daily.value?.cutoffAt);
  return t && t !== '--' ? t : '';
});

/** 空态主按钮：未绑楼 → 去选楼；其余 → 重新加载 */
const emptyActionText = computed(() => (needsBuilding.value ? '选择办公楼' : '重新加载'));

function onEmptyAction(): void {
  if (needsBuilding.value) tapSwitchLeader();
  else void load();
}

const countdownText = computed(() => {
  const s = Math.max(0, remainSec.value);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
});

/**
 * mealDate → 「9月19日 周六」（原型概念卡日期行）
 *
 * ⚠️ 一律走 `formatMealDate`（`utils/format.ts`）—— 它**手工解析**、不碰 `Date` 的时区语义。
 *    此处曾内联 `new Date(`${raw}T00:00:00`)`，**正是该工具文件注释里逐字禁止的写法**：
 *    `YYYY-MM-DDTHH:mm:ss` 在 ES2016+ 按**本地时间**解析（东八区恰好正确），
 *    但旧 WebView / JSCore 有按 **UTC** 解析的历史行为 ⇒ 会整体偏移一天。
 *    「碰巧正确」不是正确：两份实现在**缺省兜底**上也已不同（内联版返回 `raw`，
 *    `formatMealDate` 返回入参 `mealDate`），将来任一处改动都会**单边生效**。
 */
const mealDateCn = computed(() => {
  const raw = daily.value?.mealDate;
  return raw ? formatMealDate(raw) : '';
});

/**
 * 首页口号（替换原写死的「四方好味汇一盒 / 每家只出一件拿手好物」）
 *
 * 饭菜 / 快消品套餐共用同一句口号「四家好味，汇于一盒」（用户裁定：两类套餐不区分）。
 * ⚠️ 端上不写死时刻 —— 同框功能行的送达时刻一律取自 `daily.deliverAt`（与 `cutoffTimeText` 同理）。
 */
const heroSlogan = computed(() => '四家好味，汇于一盒');

/**
 * 功能行（与口号同框、零后端）：用 U1 已下发但未在首页展示的 `deliverAt`
 *
 * · 有团长 → 「明早 {t} 送达楼下，团长会送货上门」（贴合「团长统一取餐分发」模型）
 * · 无团长 → 回落「明早 {t} 送达楼下取餐点」，避免在无团长楼里谎称「团长送货」
 * ⚠️ 取不到 `deliverAt` ⇒ 整行不显示（不回落写死值，与 countdown 纪律一致）
 */
const deliverLine = computed(() => {
  const t = daily.value?.deliverAt;
  if (!t || t === '--') return '';
  return daily.value?.leader ? `明早 ${t} 送达楼下，团长会送货上门` : `明早 ${t} 送达楼下取餐点`;
});

const leaderLevelLabel = computed(() => {
  const level = leaderStore.info?.level;
  return level ? (LEADER_LEVEL_META[level as LeaderLevel]?.label ?? '团长') : '';
});

/**
 * 团长卡的标题行
 *
 * `bound` = 用户自己扫了某位团长的邀请码进来 → 「跟随团长」是准确描述；
 * `building_default` = 用户没走过邀请流程，系统按本楼自动挂靠 → 此时写「跟随」
 * 会让人以为是自己选的，故直说「本楼团长」。
 */
const leaderLabel = computed(() =>
  daily.value?.leader?.source === 'bound' ? '跟随团长' : '本楼团长',
);

/**
 * 佣金归属的明示文案
 *
 * ⚠️ 为什么必须显示这件事：佣金是**从这单里分出去的**。一个没跟任何人的用户
 *    被自动挂靠到本楼团长后，如果界面只写「跟随团长 张某」，他无从知道
 *    「我没选过人」与「张某在收我的单的佣金」是同一件事。说清楚不会有损失，
 *    不说则一旦被用户发现，损的是对整个平台账目的信任。
 */
const leaderSourceText = computed(() => {
  const src = daily.value?.leader?.source;
  if (src === 'bound') return '你通过 TA 的邀请链接进入 · 本单佣金归 TA';
  if (src === 'building_default') return '你未绑定团长，本单自动挂靠本楼团长';
  return '';
});

const unitPriceText = computed(() => ((daily.value?.priceFen ?? 0) / 100).toFixed(2));
const totalText = computed(() =>
  (((daily.value?.priceFen ?? 0) * quantity.value) / 100).toFixed(2),
);

/**
 * 份数控件可见性（2026-10-03 变更）
 *
 * ⚠️ 原判据是 `canOrder && !existingOrderNo`：在「一人一日一单」下成立，放开多单后
 *    它会把「已订一单」误判成「不能再订」—— 份数控件整块消失，用户看到的现象正是
 *    「25.8 还在、按钮没了」。多单后能否加订只取决于是否截单，故只看 `canOrder`。
 */
const canPickQuantity = computed(() => Boolean(daily.value?.canOrder));

/** 今日是否已有未取消订单（跳「查看订单」需要 `existingOrderNo`） */
const hasOrder = computed(() => Boolean(daily.value?.existingOrderNo));

/** 主按钮文案：已订过 → 「再来一单」，否则「立即预订」 */
const orderBtnText = computed(() => (hasOrder.value ? '再来一单' : '立即预订'));

/**
 * 已订概览文案
 *
 * ⚠️ 后端未下发聚合字段时（如线上仍是旧版 API）退化成只报单数 —— 直接插值
 *    `existingQuantity` 会在旧后端上渲染出「今日已订 份（ 单）」这种空档。
 */
const orderedSummary = computed(() => {
  const n = daily.value?.existingOrderCount ?? 0;
  const q = daily.value?.existingQuantity ?? 0;
  if (q > 0) return `今日已订 ${q} 份（${n} 单）`;
  return '今日已订 1 单';
});

function decQty(): void {
  if (quantity.value > 1) quantity.value -= 1;
}

function incQty(): void {
  if (quantity.value < ORDER_MAX_QUANTITY) quantity.value += 1;
}

/** 拉取首页数据（U1 明日套餐） */
async function load(): Promise<void> {
  try {
    const d = await run(() => fetchDaily());

    daily.value = d;
    loadError.value = null;
    quantity.value = 1;
    // 以服务端剩余秒数起表，规避设备时钟偏差
    start(d.countdownSec);
  } catch (e) {
    if (daily.value === null) loadError.value = e instanceof ApiError ? e : null;
    toastApiError(e);
  }
}

function goCreate(): void {
  const d = daily.value;
  if (!d) return;
  navigateTo(
    buildUrl('/pages/order-create/order-create', { mealDate: d.mealDate, qty: quantity.value }),
  );
}

function goDetail(): void {
  const orderNo = daily.value?.existingOrderNo;
  if (!orderNo) return;
  navigateTo(buildUrl('/pages/order-detail/order-detail', { orderNo }));
}

function goWorkbench(): void {
  navigateTo('/pages/leader/workbench');
}

/**
 * 「查看资质」→ 出品方资质页（supplier/detail?id=）
 *
 * ⭐ 2026-10-23 重构：原「来自：X」跳转溯源页（traceability），现供应商资质已下沉到
 *    `supplier/detail`（自持证照，不引外链），故这里直接带 `supplierId` 跳资质页。
 *    只带 id 不带整份对象：跳过去的是另一个页面实例，数据由它自己按 id 现取，单一真相。
 *    `supplierId` 缺失时静默不跳。
 */
function openSupplier(d: MealItemView): void {
  if (!d.supplierId) return;
  navigateTo(buildUrl('/pages/supplier/detail', { id: d.supplierId }));
}

function goLeaderApply(): void {
  navigateTo('/pages/leader-apply/leader-apply');
}

/**
 * 自助切换办公楼
 *
 * ⚠️ 此前这里只有一句 toast「请通过该楼团长邀请链接进入」——
 *    那句话在 `building_id` **只能由邀请链接写入**时是诚实的，但它同时意味着
 *    「没有链接的人永远绑不上楼」。现在有 `GET /building` + `PUT /me/building`，
 *    故点「点此切换 ›」与空态主按钮都直达选楼页。
 */
function tapSwitchLeader(): void {
  navigateTo('/pages/building/switch');
}

/**
 * 用权威 `GET /auth/me` 对账团长身份（2026-10-21 修复 · 首页三标识打架根因）。
 *
 * ⚠️ 端上 `leaderStore.isLeader` 只在登录时由 JWT 派生、持久化本地，而
 *    `ensureLogin(force=false)` 在 7 天 token 有效期内短路不重登 —— 于是服务端把团长
 *    停职 / 复职后，本地仍显示旧值，导致横幅「您是团长」与服务端「无团长 / 20003」共存。
 *    每次进首页都重新对账：在职写回真值，已停职（status≠ACTIVE）则清掉本地残留。
 */
async function syncLeader(): Promise<void> {
  try {
    const me = await run(() => fetchMe());
    if (me.isLeader && me.leader) {
      leaderStore.setLeader({
        id: me.leader.id,
        realName: me.leaderName,
        level: me.leader.level,
        commissionRate: me.leader.commissionRate,
        balance: me.leader.balance,
        balanceFen: me.leader.balanceFen,
        frozenFen: me.leader.frozenFen,
      });
    } else {
      leaderStore.clear();
    }
  } catch {
    // 对账失败不阻断首页；保留本地上一值（可能陈旧，但绝不让页面崩溃）
  }
}

onShow(() => {
  void load();
  void syncLeader();
  void loadSupplierPhotos();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding-bottom: 200rpx;
  box-sizing: border-box;
}

// ---- 倒计时横幅（深棕 · 金字 · 居中，贴导航栏） ----
.countdown {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: $space-3 $space-4;
  background: $c-text;
  color: $c-bg;
  border-radius: 0 0 36rpx 36rpx;
  text-align: center;

  &__label {
    font-size: $fs-caption;
    opacity: 0.92;
  }

  &__num {
    margin-top: $space-1;
    font-size: 36rpx;
    font-weight: bold;
    color: $c-gold-fg;
    letter-spacing: 2rpx;
    font-family: monospace;
  }

  &__sub {
    margin-top: $space-1;
    font-size: $fs-caption;
    opacity: 0.85;
  }
}

// ---- 套餐概念大卡（米金渐变） ----
.hero-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: $space-2 $space-4 0;
  padding: 44rpx $space-4;
  background: linear-gradient(135deg, $c-gold, $c-gold-deep);
  border-radius: 36rpx;
  color: #ffffff;
  text-align: center;

  &__date {
    margin-top: $space-2;
    font-size: $fs-caption;
    opacity: 0.92;
    letter-spacing: 2rpx;
  }

  &__pill {
    display: flex;
    flex-direction: column;
    margin-top: $space-4;
    padding: $space-2 $space-4;
    background: rgba(255, 255, 255, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: $radius-lg;
  }

  &__pill-text {
    font-size: $fs-caption;
    line-height: 1.6;
    letter-spacing: 1rpx;

    // 功能行：与口号分隔，一眼读作「信息」而非口号
    &--func {
      margin-top: $space-1;
      padding-top: $space-1;
      border-top: 1px solid rgba(255, 255, 255, 0.35);
    }
  }
}

// ---- 团长身份横幅（金→棕渐变） ----
.leader-banner {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin: $space-3 $space-4 0;
  padding: $space-3 $space-4;
  background: linear-gradient(135deg, $c-gold, $c-text);
  border-radius: $radius-md;
  color: #ffffff;
  box-shadow: 0 8rpx 24rpx rgba(201, 168, 118, 0.35);

  &--hover {
    opacity: 0.9;
  }

  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  &__title {
    font-size: $fs-body;
    font-weight: bold;
  }

  &__sub {
    margin-top: $space-1;
    font-size: $fs-caption;
    opacity: 0.92;
  }

  &__chip {
    font-size: $fs-caption;
    padding: $space-1 $space-2;
    background: rgba(255, 255, 255, 0.2);
    border-radius: $radius-sm;
  }
}

// ---- 通用卡片 ----
.card {
  margin: $space-3 $space-4 0;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: 0 2rpx 8rpx rgba(110, 84, 53, 0.06);

  &__title {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-h2;
    font-weight: bold;
    letter-spacing: 1rpx;
    color: $c-text;
  }
}

// ---- 跟随团长卡 ----
.leader-row {
  display: flex;
  align-items: center;
  justify-content: space-between;

  &__left {
    display: flex;
    flex-direction: column;
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__name {
    margin-top: $space-1;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__building {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  // 佣金归属明示（M5-17）
  // · 邀请绑定 = 用户自己选的，一句弱灰即可；
  // · 自动挂靠 = 用户没选过却有人在分他的单 ⇒ 用主文字色说清，不用弱灰一笔带过。
  &__source {
    margin-top: $space-1;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;

    &--building_default {
      color: $c-text;
    }
  }

  &__switch {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 无团长引导 / 截单原因（左侧金边提示条） ----
.guide {
  margin: $space-3 $space-4 0;
  padding: $space-2 $space-3;
  background: $c-surface-3;
  border-left: 6rpx solid $c-gold;
  border-radius: $radius-sm;

  &--warn {
    border-left-color: $c-warning;
  }

  &__text {
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &__link {
    color: $c-gold-fg;
    text-decoration: underline;
  }
}

// ---- 一饭四菜 ----
.dish-row {
  display: flex;
  align-items: center;
  gap: $space-3;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

  &:last-child {
    border-bottom: none;
  }

  &__ico {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 112rpx;
    height: 112rpx;
    background: $c-surface-2;
    border-radius: $radius-lg;
  }

  &__info {
    flex: 1;
    min-width: 0;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  // 主食行（随附说明，无跳转）。整块作为说明即可。
  &__from-wrap {
    margin-top: $space-1;
    text-align: right;

    &.is-link {
      padding: 4rpx 0 4rpx $space-3;
    }

    &--hover {
      opacity: 0.6;
    }
  }

  &__from {
    font-size: $fs-caption;
    // 既有裸色值（端上裸色值基线之一），收归 token 由 S4「裸色值归零」统一处理，本批不动
    color: $c-gold-fg;
  }
}

// ---- x 盲盒（轻量小辅助 · 随单附赠惊喜） ----
.blind-row {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-top: $space-3;
  padding: $space-3;
  background: $c-surface-2;
  border: 1px dashed $c-gold;
  border-radius: $radius-lg;

  &__ico {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 112rpx;
    height: 112rpx;
    background: linear-gradient(135deg, $c-gold 0%, $c-gold-deep 100%);
    border-radius: $radius-lg;
    color: #ffffff;
  }

  &__info {
    flex: 1;
    min-width: 0;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__from-wrap {
    margin-top: $space-1;
  }

  &__from {
    font-size: $fs-caption;
    color: $c-gold-fg;
  }
}

// ---- 本日精选 · 两列菜品卡网格 ----
.dish-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: $space-3;
}

.dish-card {
  display: flex;
  flex-direction: column;
  background: $c-surface-2;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  overflow: hidden;

  &--hover {
    opacity: 0.92;
  }

  &__media {
    position: relative;
    width: 100%;
    height: 200rpx;
    background: linear-gradient(135deg, $c-gold 0%, $c-gold-deep 100%);
  }

  &__media--fallback {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__img {
    width: 100%;
    height: 100%;
  }

  &__letter {
    font-size: 80rpx;
    font-weight: bold;
    color: rgba(255, 255, 255, 0.85);
  }

  &__badge {
    position: absolute;
    top: 12rpx;
    left: 12rpx;
    padding: 4rpx 14rpx;
    font-size: $fs-caption;
    color: #ffffff;
    background: rgba(110, 84, 53, 0.72);
    border-radius: $radius-pill;
  }

  &__body {
    display: flex;
    flex-direction: column;
    padding: $space-2 $space-3 $space-3;
  }

  &__name {
    font-size: $fs-body;
    font-weight: bold;
    line-height: 1.4;
    color: $c-text;
  }

  &__supplier {
    margin-top: 4rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__qual {
    display: flex;
    align-items: center;
    gap: 8rpx;
    margin-top: $space-2;
    padding-top: $space-2;
    border-top: 1px dashed $c-border-strong;

    &--hover {
      opacity: 0.6;
    }
  }

  &__qual-icon {
    color: $c-gold-fg;
  }

  &__qual-text {
    flex: 1;
    font-size: $fs-caption;
    color: $c-gold-fg;
  }

  &__qual-arrow {
    color: $c-gold-fg;
  }
}

// ---- 价格 + 份数 ----
.price-row {
  display: flex;
  align-items: center;
  justify-content: space-between;

  &__left {
    display: flex;
    flex-direction: column;
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__price {
    display: flex;
    align-items: baseline;
    margin-top: $space-1;
  }
}

.price-big {
  font-size: 60rpx;
  font-weight: bold;
  color: $c-text;
  line-height: 1.2;
}

.price-unit {
  margin-left: $space-1;
  font-size: $fs-body;
  color: $c-text-weak;
}

.qty-control {
  display: inline-flex;
  align-items: center;
  background: $c-bg;
  border: 1px solid $c-border-strong;
  border-radius: $radius-pill;
  overflow: hidden;
}

.qty-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 60rpx;
  height: 60rpx;
  background: $c-surface-2;
  color: $c-text;
  font-size: 36rpx;

  &.is-disabled {
    opacity: 0.35;
  }
}

.qty-value {
  width: 72rpx;
  text-align: center;
  font-size: $fs-body;
  font-weight: bold;
  color: $c-text;
}

.max-hint {
  display: block;
  margin: $space-1 $space-4 0;
  text-align: right;
  font-size: $fs-caption;
  color: $c-text-weak;
}

// ---- 立即预订（金棕渐变大按钮） ----
.btn-primary {
  display: block;
  width: calc(100% - #{($space-4 * 2)});
  margin: $space-3 $space-4 0;
  padding: $space-3 0;
  background: linear-gradient(135deg, $c-text 0%, $c-gold-deep 100%);
  color: $c-bg;
  font-size: $fs-h2;
  font-weight: bold;
  letter-spacing: 4rpx;
  text-align: center;
  border: none;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    filter: brightness(1.08);
  }

  &--ghost {
    background: $c-surface;
    color: $c-text;
    border: 1px solid $c-text;
  }

  &--disabled {
    background: rgba(154, 139, 114, 0.2);
    color: $c-text-weak;
  }
}
</style>
