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
          :links="d.supplier.takeoutLinks"
          :clickable="hasShop(d.supplier.takeoutLinks)"
          :highlight="focusId === d.supplier.id"
          @tap="openSheet(d.supplier)"
        />

        <!-- 集散中心（主食与打包 · 无外卖入口，故不可点） -->
        <ab-supplier-card
          v-if="data.distributionCenter"
          avatar-icon="rice"
          :name="data.distributionCenter.name"
          category="主食"
          detail="今日出品：米饭与打包"
          :extra="data.distributionCenter.address"
        />
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

    <!-- 平台选择弹层（原型 P38 的模态：三平台恒显，未入驻置灰） -->
    <view v-if="sheet" class="sheet-mask" @tap="closeSheet">
      <view class="sheet" @tap.stop>
        <view class="sheet__hd">
          <text class="sheet__title">{{ sheet.name }}</text>
          <text class="sheet__close" @tap="closeSheet">关闭</text>
        </view>
        <text class="sheet__hint">在以下平台都能找到这家店；灰色为尚未入驻的平台。</text>

        <view
          v-for="l in sheet.links"
          :key="l.platform"
          class="shop-row"
          :class="{
            'is-off': !l.configured,
            'is-rec': l.configured && l.platform === sheet.recommended,
          }"
          @tap="openShop(l)"
        >
          <view class="shop-row__badge" :class="`shop-row__badge--${l.platform}`">
            <text class="shop-row__badge-text">{{ shortLabel(l.platform) }}</text>
          </view>
          <text class="shop-row__name">{{ l.label }}</text>
          <text v-if="l.configured && l.platform === sheet.recommended" class="shop-row__rec">
            推荐
          </text>
          <text class="shop-row__state">{{ l.configured ? '去这家 ›' : '未入驻' }}</text>
        </view>
      </view>
    </view>

    <ab-bottom-bar active="traceability" />
  </view>
</template>

<script setup lang="ts">
/**
 * P38 · 今日这盒 · 商家溯源（C8）
 *
 * ⭐ 版式基准 = `prototype/index.html` renderP38（v4.9.1 C8 改版）：
 *   溯源说明卡 → 出品方卡（4 家菜品供应商 + 1 个集散中心）→ 页脚 → 底部「供应商」tab。
 *   点出品方卡 → 平台弹层（三平台，未入驻置灰）→ 跳转。
 *
 * ## 这一页存在的理由
 * 「不喜欢今天的套餐也没关系」—— 用户可以顺着溯源卡找到**具体是哪家做的这道菜**，
 * 再去那家自己的店铺点单。把「一盒拼配」的透明度变成信任，而不是让人怀疑
 * 「这盒到底是谁做的」。
 *
 * ## 数据来源
 * U5 `GET /traceability/today?buildingId=`（**免登录只读**）。楼群必须由端上给：
 * 端上从登录态 `user.buildingId` 取；拿不到就引导走团长邀请链接（同首页口径）。
 *
 * ## 跳转的现实边界（务必知道）
 * `wx.navigateToMiniProgram` 要求目标 appid 先进本小程序后台的「可跳转小程序名单」，
 * 且需对方同意。一期**没有任何平台的白名单关系**，故 `TAKEOUT_MINI_PROGRAM_APPID`
 * 三个平台均留空，端上走**降级路径**：复制店铺名/链接 + 引导用户去对应平台内搜索。
 * 用户仍能找到这家店，只是不经由小程序直跳。填入 appid 后自动切回直跳（无需改页面）。
 *
 * ⚠️ 降级**不是**「功能没做完」的托词 —— 它是唯一诚实的实现：没有准入关系时，
 *    任何「看起来跳过去了」的假象都比做不了更糟。
 *
 * ## 入参（M5-17）
 * `?supplierId=<ab_supplier.id>` —— 首页「来自：X」点进来时带入。页面会**定位到那家**：
 * 卡片描金圈 + 直接弹出它的平台层。缺省（从底部「供应商」tab 进入）即正常展示全部出品方。
 * 按 **id** 而非名字定位：`ab_supplier.name` 无唯一约束，同名两家会弹错店 ——
 * 而用户在溯源页照着弹出来的店去平台点单，弹错店是这一页最坏的一类错误。
 */
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import type {
  TraceabilityQualification,
  TraceabilitySupplierView,
  TraceabilityTakeoutLink,
  TraceabilityTodayResult,
} from '@abox/shared-types';
import {
  DISH_CATEGORY_LABEL,
  TAKEOUT_PLATFORM_SHORT,
  TRACEABILITY_QUALIFICATION_LABEL,
  TakeoutPlatform,
} from '@abox/shared-types';

import { fetchTraceabilityToday } from '@/api/traceability';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { TAKEOUT_MINI_PROGRAM_APPID } from '@/constants';
import { useUserStore } from '@/stores/user';
import { dishIcon } from '@/utils/format';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const userStore = useUserStore();
const { run, loading } = useRequest();

const data = ref<TraceabilityTodayResult | null>(null);
const loadError = ref<ApiError | null>(null);

/**
 * 被「定位」的出品方 id（M5-17）—— 由首页「来自：X」跳过来时带 `supplierId`
 *
 * 命中的那张卡会描金圈（`ab-supplier-card` 的 `highlight`），并**直接弹出它的平台层**。
 * 用户在 4~5 张同版式的卡里不该自己找哪张是刚点的那家。
 */
const focusId = ref<number | null>(null);

/**
 * 尚未消费的定位请求（`onLoad` 写入 → 首次取数成功后消费并清空）
 *
 * ⚠️ 为什么不直接让 `onLoad` 去打开弹层：那一刻 U5 还没回来，`dishes` 是空的，
 *    既定位不到卡、也拿不到链接。故 `onLoad` 只**记下意图**，由 `load()` 兑现。
 *
 * ⚠️ 为什么消费后必须清空：`onShow` 在「从外卖小程序跳回」「切前台」时也会触发，
 *    若定位意图留着不清，弹层会自己再弹一次 —— 用户没点任何东西却跳出个浮层。
 */
const pendingSupplierId = ref<number | null>(null);

/** 弹层当前展示的出品方（null = 关闭） */
interface SheetState {
  name: string;
  recommended: TakeoutPlatform | null;
  links: TraceabilityTakeoutLink[];
}
const sheet = ref<SheetState | null>(null);

const isEmpty = computed(
  () => (data.value?.dishes.length ?? 0) === 0 && !data.value?.distributionCenter,
);

const emptyText = computed(() =>
  userStore.info?.buildingId ? '本楼今日暂无溯源信息' : '还未绑定办公楼',
);
const emptyHint = computed(() => {
  if (!userStore.info?.buildingId) return '请通过该楼团长的邀请链接进入，绑定后即可查看';
  return loadError.value?.message ?? '开团后可在这里看到本盒的出品方与店铺入口';
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

function shortLabel(platform: string): string {
  return TAKEOUT_PLATFORM_SHORT[platform as TakeoutPlatform] ?? platform;
}

/** 是否有任何已入驻平台（否则卡片不可点，连 › 也不显示） */
function hasShop(links: TraceabilityTakeoutLink[]): boolean {
  return links.some((l) => l.configured);
}

function openSheet(supplier: TraceabilitySupplierView): void {
  sheet.value = {
    name: supplier.name,
    recommended: supplier.recommended,
    links: supplier.takeoutLinks,
  };
}

function closeSheet(): void {
  sheet.value = null;
}

/**
 * 打开店铺
 *
 * 两级：① 原生小程序直跳（需 appId 与跳转白名单）→ ② 降级为「复制店名/链接 + 引导搜索」。
 * 第 ① 级的失败**不弹错** —— 它本来就可能因白名单未开通而失败，
 * 那是预期内的环境状态，不是用户操作错误，直接落第 ② 级即可。
 */
async function openShop(link: TraceabilityTakeoutLink): Promise<void> {
  if (!link.configured || !link.url) return;

  // #ifdef MP-WEIXIN
  const appId = TAKEOUT_MINI_PROGRAM_APPID[link.platform];
  // 存的是小程序路径（非 http 链接）且已配 appId —— 才可能直跳
  if (appId && !/^https?:\/\//i.test(link.url)) {
    const jumped = await new Promise<boolean>((resolve) => {
      (
        uni as unknown as {
          navigateToMiniProgram?: (o: Record<string, unknown>) => void;
        }
      ).navigateToMiniProgram?.({
        appId,
        path: link.url,
        success: () => resolve(true),
        fail: () => resolve(false),
      }) ?? resolve(false);
    });
    if (jumped) return;
  }
  // #endif

  fallbackToCopy(link);
}

/** 降级：复制可检索的标识，并明确告诉用户下一步怎么做 */
function fallbackToCopy(link: TraceabilityTakeoutLink): void {
  const isUrl = /^https?:\/\//i.test(link.url ?? '');
  const payload = isUrl ? (link.url as string) : (sheet.value?.name ?? '');
  if (!payload) return;

  const tip = (copied: boolean): void => {
    uni.showModal({
      title: copied ? (isUrl ? '已复制店铺链接' : '已复制店铺名') : '请手动记录',
      content: isUrl
        ? `${payload}\n\n可在浏览器中打开。`
        : copied
          ? `打开「${link.label}」，搜索「${payload}」即可找到这家店。`
          : `自动复制不可用，请手动记录：${payload}\n\n在「${link.label}」内搜索即可找到。`,
      showCancel: false,
      confirmText: '好',
    });
  };

  uni.setClipboardData({
    data: payload,
    success: () => tip(true),
    fail: () => tip(false),
  });
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
 * （同名两家是合法数据），按名字定位会弹错店 —— 而「弹错店」在溯源页是
 * 最坏的一类错误：用户会照着它去平台点单。
 *
 * 找不到时**明说**，不静默：跳过来却什么都不发生，用户只会以为页面坏了。
 * 真会发生的场景是「首页取的是 T+1 套餐，跳转途中跨过 24:00 截单换日」——
 * 一句话解释掉，比让人对着首屏发愣强。
 */
function consumePendingSupplier(): void {
  const target = pendingSupplierId.value;
  if (target === null) return;
  pendingSupplierId.value = null;

  const hit = data.value?.dishes.find((d) => d.supplier.id === target);
  if (hit) {
    focusId.value = target;
    openSheet(hit.supplier);
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

// ---- 平台选择弹层 ----
.sheet-mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 200;
  display: flex;
  align-items: flex-end;
  background: rgba(110, 84, 53, 0.35);
}

.sheet {
  width: 100%;
  padding: $space-4 $space-4 $space-5;
  background: $c-surface;
  border-radius: $radius-lg $radius-lg 0 0;

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__close {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__hint {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
  }
}

.shop-row {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-top: $space-3;
  padding: $space-3;
  background: $c-bg;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  // 推荐平台：金棕描边加重 + 浅金底（原型 P38 同款强调）
  &.is-rec {
    background: rgba(201, 168, 118, 0.08);
    border: 2px solid $c-gold;
  }

  // 未入驻：虚线灰边、整体降透明度，明确不可点
  &.is-off {
    opacity: 0.45;
    border-style: dashed;
  }

  &__badge {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64rpx;
    height: 64rpx;
    border-radius: $radius-md;

    &--meituan {
      color: $c-brand-meituan-text;
      background: $c-brand-meituan;
    }

    &--taobao {
      color: $c-brand-on-color;
      background: $c-brand-taobao;
    }

    &--jd {
      color: $c-brand-on-color;
      background: $c-brand-jd;
    }
  }

  &__badge-text {
    font-size: $fs-caption;
    font-weight: bold;
  }

  &__name {
    flex: 1;
    font-size: $fs-body;
    color: $c-text;
  }

  &__rec {
    flex: none;
    margin-right: $space-2;
    padding: 2rpx $space-1;
    font-size: $fs-caption;
    color: #ffffff;
    background: $c-gold;
    border-radius: $radius-sm;
  }

  &__state {
    flex: none;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}
</style>
