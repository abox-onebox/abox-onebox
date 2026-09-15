<template>
  <view class="meal-card">
    <view class="meal-card__hd">
      <text class="meal-card__name">{{ name || '本周套餐' }}</text>
      <text v-if="mealDateText" class="meal-card__date">{{ mealDateText }}</text>
    </view>

    <view class="meal-card__dishes">
      <view v-for="dish in dishes" :key="`${dish.slot}-${dish.name}`" class="dish">
        <text class="dish__slot">{{ SLOT_LABEL[dish.slot] || '菜品' }}</text>
        <text class="dish__name">{{ dish.name }}</text>
        <text v-if="dish.supplierName" class="dish__from">{{ dish.supplierName }}</text>
      </view>
      <view v-if="!dishes.length" class="meal-card__placeholder">
        <text class="meal-card__placeholder-text">套餐配菜待公布</text>
      </view>
    </view>

    <view v-if="rice" class="meal-card__rice">
      <text class="meal-card__rice-label">主食</text>
      <text class="meal-card__rice-text">{{ rice }}</text>
    </view>

    <view class="meal-card__ft">
      <view class="price">
        <text class="price__symbol">¥</text>
        <text class="price__value">{{ priceText }}</text>
        <text class="price__unit">/ 份</text>
      </view>
      <slot name="action" />
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * ab-meal-card —— 套餐卡片（一饭四菜：1 主荤 + 1 半荤 + 1 素菜 + 1 汤 + 主食）
 *
 * ⚠️ C8：只展示菜名 / 档位 / 来源商家**展示名**，
 *    **严禁**出现供价、分账比例、供应商状态与联系方式。
 */
import { computed } from 'vue';
import type { MealDishView } from '@abox/shared-types';

import { SLOT_LABEL, fenToYuan, formatMealDate } from '@/utils/format';

const props = withDefaults(
  defineProps<{
    /** 套餐名 */
    name?: string | null;
    /** 出餐日 `YYYY-MM-DD` */
    mealDate?: string;
    /** 菜品列表（已按 slot 升序） */
    dishes?: MealDishView[];
    /** 主食说明 */
    rice?: string | null;
    /** 单价（分） */
    priceFen?: number;
  }>(),
  {
    name: null,
    mealDate: '',
    dishes: () => [],
    rice: null,
    priceFen: 0,
  },
);

const priceText = computed(() => fenToYuan(props.priceFen));
const mealDateText = computed(() => (props.mealDate ? formatMealDate(props.mealDate) : ''));
</script>

<style lang="scss" scoped>
.meal-card {
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding-bottom: $space-3;
    border-bottom: 1px solid $c-border;
  }

  &__name {
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__date {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__dishes {
    padding: $space-3 0;
  }

  &__placeholder {
    padding: $space-4 0;
    text-align: center;
  }

  &__placeholder-text {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__rice {
    display: flex;
    align-items: center;
    padding-top: $space-3;
    border-top: 1px solid $c-border;
  }

  &__rice-label {
    margin-right: $space-2;
    padding: 2rpx $space-1;
    font-size: $fs-caption;
    color: $c-gold;
    border: 1px solid $c-gold;
    border-radius: $radius-sm;
  }

  &__rice-text {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__ft {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: $space-4;
    padding-top: $space-3;
    border-top: 1px solid $c-border;
  }
}

.dish {
  display: flex;
  align-items: baseline;
  padding: $space-2 0;

  &__slot {
    flex: none;
    width: 76rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__name {
    flex: 1;
    font-size: $fs-body;
    color: $c-text;
  }

  &__from {
    flex: none;
    margin-left: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.price {
  display: flex;
  align-items: baseline;
  color: $c-text;

  &__symbol {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__value {
    margin: 0 2rpx;
    font-size: $fs-display;
    font-weight: 600;
  }

  &__unit {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}
</style>
