<template>
  <view class="page">
    <ab-loading v-if="loading && !data" text="正在读取溯源信息" />

    <!-- 未绑定办公楼：溯源按楼群定位，没有楼就无从查起（先把人送去绑定，不给死页面） -->
    <view v-else-if="!buildingId" class="empty">
      <text class="abi abi-deco-34 empty__icon">{{ I['warn-tri'] }}</text>
      <text class="empty__text">还没有绑定办公楼</text>
      <text class="empty__hint">溯源要按你所在的楼群定位出品方，请先通过团长邀请链接绑定</text>
      <button class="empty__btn" hover-class="empty__btn--hover" @tap="goHome">回首页</button>
    </view>

    <template v-else-if="data">
      <!-- 说明文案由**服务端下发**（traceNote），端上不拼 —— 同一句口径只有一个来源 -->
      <view class="note">
        <text class="abi abi-16 note__icon">{{ I.shield }}</text>
        <text class="note__text">{{ data.traceNote }}</text>
      </view>

      <view class="card">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.calendar }}</text> {{ data.mealDate }}
          {{ data.setName ? `· ${data.setName}` : '' }}</text
        >
      </view>

      <!-- 出品方逐菜列出 -->
      <view class="card">
        <text class="card__title"
          ><text class="abi abi-16">{{ isFmcg ? I.cup : I.rice }}</text> 本餐出品方</text
        >

        <view v-for="(it, i) in data.items" :key="i" class="item">
          <image v-if="it.imageUrl" class="item__img" :src="it.imageUrl" mode="aspectFill" />
          <view class="item__body">
            <text class="item__name">{{ it.itemName }}</text>
            <text class="item__sup" :class="{ 'item__sup--on': it.supplier.id === highlightId }"
              >来自：{{ it.supplier.name }}</text
            >
          </view>
          <text class="item__go" @tap="openSupplier(it.supplier.id)">证照</text>
        </view>

        <text v-if="!data.items.length" class="card__none">当日暂无出品明细</text>
      </view>

      <!-- 集散中心：ABox 自有加工 / 出餐场所（主食与打包） -->
      <view v-if="data.distributionCenter" class="card">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.store }}</text> 加工与出餐</text
        >
        <text class="dc__name">{{ data.distributionCenter.name }}</text>
        <text class="dc__addr">{{ data.distributionCenter.address }}</text>
      </view>
      <view v-else class="card">
        <text class="card__none">当日没有分配到集散中心（这楼群今天不开团）</text>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * 今日这盒 · 商家溯源（U5 `GET /traceability/today`）
 *
 * ⭐ 为什么补这个页面：`fetchTraceabilityToday` 封装好了、免登录端点也在跑，
 *    端上却**没有任何入口**（admin:coverage #45）—— 而 `TraceabilitySupplierView.id`
 *    的注释里明写着「首页『来自：X』跳本页时带 supplierId」，说明这条跳转**本来就在设计里**，
 *    只是从没接上。页面缺位时，注释说得再清楚也只是愿望。
 *
 * ⭐ 信任路径的意义：这一页取代了「跳外卖平台看店铺」那条老路 —— 后者撞
 *    《微信小程序平台运营规范》5.10 互推，处理是下架乃至封禁剪切板能力。
 *    所以本页**不做任何外跳**，只展示在册证照（点「证照」进的是本小程序内的资质页）。
 *
 * ⚠️ `buildingId` 必传：免登录端点无从推楼群，拿不到就整页降级为「请先绑定办公楼」，
 *    不能拿一个假楼去查（查出来也是别人的出品方）。
 * ⚠️ `supplierId` 只用于**高亮**（按 id 不按 name —— 供应商名无唯一约束，同名两家会认错店）。
 */
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { fetchTraceabilityToday } from '@/api/traceability';
import type { TraceabilityTodayResult } from '@abox/shared-types';
import { toastApiError, useRequest } from '@/composables/use-request';
import { navigateTo, switchTab } from '@/utils/router';
import { useUserStore } from '@/stores/user';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const user = useUserStore();
const data = ref<TraceabilityTodayResult | null>(null);
/** 从首页「来自：X」带过来的出品方 id（仅用于高亮，不用于筛选） */
const highlightId = ref<number | null>(null);
const { run, loading } = useRequest();

const buildingId = computed<number | null>(() => user.info?.buildingId ?? null);
/** 快消品换杯形图标，餐饮用碗 —— 与首页同一套判据（服务端下发 kind） */
const isFmcg = computed(() => data.value?.kind === 'fmcg');

async function load(): Promise<void> {
  if (!buildingId.value) return;
  try {
    data.value = await run(() => fetchTraceabilityToday(buildingId.value as number));
  } catch (e) {
    toastApiError(e);
  }
}

function openSupplier(id: number): void {
  navigateTo(`/pages/supplier/detail?id=${id}`);
}

function goHome(): void {
  switchTab('/pages/index/index');
}

onLoad((query) => {
  const sid = Number(query?.supplierId);
  highlightId.value = Number.isFinite(sid) && sid > 0 ? sid : null;
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-3 $space-4 $space-5;
  box-sizing: border-box;
}

.note {
  display: flex;
  flex-direction: row;
  padding: $space-3;
  background: $c-surface-3;
  border-left: 6rpx solid $c-info;
  border-radius: $radius-sm;

  &__icon {
    margin-right: $space-1;
  }

  &__text {
    flex: 1;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.card {
  margin-top: $space-3;
  padding: $space-3;
  background: $c-surface;
  border-radius: $radius-md;

  &__title {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__none {
    display: block;
    padding: $space-3 0;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.item {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: $space-3 0;
  border-bottom: 1rpx solid $c-border;

  &:last-child {
    border-bottom: none;
  }

  &__img {
    width: 80rpx;
    height: 80rpx;
    margin-right: $space-2;
    border-radius: $radius-sm;
  }

  &__body {
    flex: 1;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    color: $c-text;
  }

  &__sup {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;

    // 从首页「来自：X」点进来的那一家 —— 用户是冲着它来的，先让他看见
    &--on {
      font-weight: bold;
      color: $c-gold-deep;
    }
  }

  &__go {
    font-size: $fs-caption;
    color: $c-gold-deep;
  }
}

.dc__name {
  display: block;
  margin-top: $space-2;
  font-size: $fs-body;
  color: $c-text;
}

.dc__addr {
  display: block;
  margin-top: $space-1;
  font-size: $fs-caption;
  color: $c-text-weak;
}
</style>
