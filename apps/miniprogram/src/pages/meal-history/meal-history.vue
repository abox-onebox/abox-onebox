<template>
  <view class="page">
    <!-- 版式基准 = P9 账户余额（同族列表页）：说明条 → 列表卡 → 兜底文案 -->

    <ab-loading v-if="loading && !rows.length" text="正在读取往期菜单" />

    <view v-else-if="!rows.length" class="empty">
      <text class="abi abi-deco-34 empty__icon">{{ I.history }}</text>
      <text class="empty__text">还没有往期菜单</text>
      <text class="empty__hint">每完成一次配送，那天的组合就会归档到这里</text>
      <button class="empty__btn" hover-class="empty__btn--hover" @tap="goHome">
        去看看明天吃什么
      </button>
    </view>

    <template v-else>
      <!-- 口径说明条 -->
      <view class="tips">
        <text class="tips__text">
          这里是你<text class="tips__strong">订过的</text>往期组合（按出餐日归档）。
          它只作记录，<text class="tips__strong">不能补订</text> —— 可下单的只有「明日」那一餐。
        </text>
      </view>

      <view class="card">
        <view class="card__hd">
          <text class="card__title"
            ><text class="abi abi-16">{{ I.history }}</text> 往期组合 {{ total }} 天</text
          >
        </view>

        <view v-for="item in rows" :key="item.mealDate" class="hist">
          <view class="hist__hd">
            <text class="hist__date">{{ item.mealDate }}</text>
            <text class="hist__price">{{ fenToYuanText(item.priceFen) }}</text>
          </view>
          <text class="hist__name">{{ item.setName || '当日组合' }}</text>
          <text v-if="item.itemNames.length" class="hist__items">{{
            item.itemNames.join(' · ')
          }}</text>
          <text class="hist__count">当天订了 {{ item.ordersCount }} 单</text>
        </view>
      </view>

      <button
        v-if="hasMore"
        class="more"
        hover-class="more--hover"
        :disabled="loading"
        @tap="loadMore"
      >
        {{ loading ? '读取中…' : '加载更早的' }}
      </button>

      <text class="foot">价格为归档时的单价；若你用了券，实际支付以「我的订单」为准。</text>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * 往期菜单（U2 `GET /home/history` · 补 admin:coverage 扫出的缺口 #47）
 *
 * ⭐ 为什么端点一直在、端上却没入口：`fetchHistory` 早在 `api/meal.ts` 里封装好了，
 *    连注释都写着「日后做『历史』入口可直接复用」—— 于是它变成一句**没人兑现的承诺**：
 *    接口在跑、数据在长，用户却看不到。这类「预留」正是要靠门禁持续点名的东西。
 *
 * ⭐ 本页只做记录，不做补订：业务上能下单的只有「明日」那一餐（截单 T-1 24:00），
 *    给历史项加「再来一单」就是死入口 —— 点了必然失败。说明条里把这层说破。
 *
 * ⚠️ 分页是**翻页**不是追加到底：历史按出餐日倒序，一次拉 20 天足够回溯大半个月，
 *    再往前的用「加载更早的」取，不给无限滚动（列表类页面一律留底部）。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchHistory } from '@/api/meal';
import type { HomeHistoryItem } from '@abox/shared-types';
import { toastApiError, useRequest } from '@/composables/use-request';
import { fenToYuanText } from '@/utils/format';
import { switchTab } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const rows = ref<HomeHistoryItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const { run, loading } = useRequest();

/** ⚠️ 用**已取到的条数**判还有没有更多，不用 `total`：翻页到底时 total 仍 > rows.length，
 *    再点一次会拿到空页 —— 用 rows 判则按钮自己消失，不给用户「点了个没反应」。 */
const hasMore = computed(() => rows.value.length > 0 && rows.value.length < total.value);

async function load(nextPage = 1): Promise<void> {
  try {
    const res = await run(() => fetchHistory(nextPage, pageSize));
    // ⚠️ 第 1 页是**替换**、后续页是**追加**：混用会出现重复日期行
    rows.value = nextPage === 1 ? res.list : [...rows.value, ...res.list];
    total.value = res.total;
    page.value = nextPage;
  } catch (e) {
    toastApiError(e);
  }
}

function loadMore(): void {
  if (loading.value || !hasMore.value) return;
  void load(page.value + 1);
}

function goHome(): void {
  switchTab('/pages/index/index');
}

onShow(() => {
  void load(1);
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-3 $space-4 $space-5;
  box-sizing: border-box;
}

// ---- 说明条 ----
.tips {
  padding: $space-3;
  background: $c-surface-3;
  border-left: 6rpx solid $c-info;
  border-radius: $radius-sm;

  &__text {
    display: block;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &__strong {
    font-weight: bold;
    color: $c-text;
  }
}

// ---- 列表卡 ----
.card {
  margin-top: $space-3;
  padding: $space-3;
  background: $c-surface;
  border-radius: $radius-md;

  &__hd {
    padding-bottom: $space-2;
    border-bottom: 1rpx solid $c-border;
  }

  &__title {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }
}

.hist {
  padding: $space-3 0;
  border-bottom: 1rpx solid $c-border;

  &:last-child {
    border-bottom: none;
  }

  &__hd {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
  }

  &__date {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__price {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-gold-deep;
  }

  &__name {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text;
  }

  &__items {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
  }

  &__count {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.more {
  margin-top: $space-3;
  font-size: $fs-caption;
  color: $c-text-weak;
  background: $c-surface;

  &--hover {
    opacity: 0.6;
  }
}

.foot {
  display: block;
  margin-top: $space-3;
  font-size: $fs-caption;
  line-height: 1.6;
  color: $c-text-weak;
}
</style>
