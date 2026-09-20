<template>
  <view
    class="supplier-card"
    :class="{ 'is-clickable': clickable, 'is-highlight': highlight }"
    :hover-class="clickable ? 'supplier-card--hover' : 'none'"
    @tap="onTap"
  >
    <view class="supplier-card__avatar">
      <text class="supplier-card__avatar-text">{{ avatar }}</text>
    </view>

    <view class="supplier-card__main">
      <view class="supplier-card__hd">
        <text class="supplier-card__name">{{ name }}</text>
        <text v-if="category" class="supplier-card__cat">{{ category }}</text>
      </view>

      <text class="supplier-card__detail">{{ detail }}</text>

      <text v-if="extra" class="supplier-card__extra">{{ extra }}</text>

      <text v-if="verified" class="supplier-card__verified">{{ verified }}</text>

      <view v-if="showPlatforms" class="platforms">
        <text
          v-for="l in links"
          :key="l.platform"
          class="platforms__tag"
          :class="[`platforms__tag--${l.platform}`, { 'is-off': !l.configured }]"
        >
          {{ shortLabel(l.platform) }}
        </text>
      </view>
    </view>

    <text v-if="clickable" class="supplier-card__arrow">›</text>
  </view>
</template>

<script setup lang="ts">
/**
 * ab-supplier-card —— 溯源出品方卡片（C8 · 原型 P38）
 *
 * ## 一个组件、两种卡片
 * 原型 P38 的 5 张卡是同一种版式：**4 家菜品供应商**（带资质行与外卖平台角标）
 * 与**1 个集散中心**（带地址行、无外卖平台）。若拆成两个组件，卡片的圆角 / 间距 /
 * 头像块就会各写一份 —— 那种「同一视觉两份实现」迟早会在某次改版里只改一边。
 * 故此处用一组**扁平入参**承载两种数据（页面负责把 DTO 映射成文案），
 * 组件只管把它画出来。
 *
 * ## 为什么入参是字符串而不是 DTO
 * 组件不依赖 `TraceabilityDishView` / `TraceabilityCenterView` 中的任何一个 ——
 * 两种数据的形状本就不同（一个带外卖链接、一个带地址）。改用扁平字符串后，
 * 「供应商名怎么拼」「资质行怎么写」这类决策留在页面，组件的职责只剩渲染。
 *
 * ## ⚠️ 平台角标一律**恒显三条**
 * 未入驻的画成灰色而不是删掉：卡片上「缺京东」是**要被人看见**的信息
 * （运营据此去谈），隐藏它会把这件事实一起藏掉。
 */
import { computed } from 'vue';
import { TAKEOUT_PLATFORM_SHORT, TakeoutPlatform } from '@abox/shared-types';
import type { TraceabilityTakeoutLink } from '@abox/shared-types';

const props = withDefaults(
  defineProps<{
    /** 头像图示字符（菜品 emoji，由 `utils/format` 的 `dishEmoji()` 给出） */
    avatar: string;
    /** 出品方名称 */
    name: string;
    /** 右上角品类角标（主荤 / 素菜 / 汤品 / 主食…）；空则不显示 */
    category?: string | null;
    /** 主行文案（如「今日出品：红烧肉」/「今日出品：米饭与打包」） */
    detail: string;
    /** 次级灰行（如集散中心地址）；空则不显示 */
    extra?: string | null;
    /** 核验行（绿色，如「已核验 · 食品经营许可证 · 营业执照」）；空则不显示 */
    verified?: string | null;
    /** 三个平台入口（**恒三条**）；无任何已入驻平台时整行不渲染 */
    links?: TraceabilityTakeoutLink[];
    /** 是否可点开跳转弹层（无任何已入驻平台时为 false，不显示 › ） */
    clickable?: boolean;
    /**
     * 高亮这张卡（M5-17 · 「定位到某一家」）
     *
     * 首页「来自：X」跳过来会带 `supplierId`，本页据此把对应的卡描金圈出来 ——
     * 否则用户在 4~5 张同版式的卡里不知道哪张是自己点的那家。
     *
     * ⚠️ 为什么是**显式 prop** 而不是让页面给组件挂 `class`：
     *    组件有自己的根节点与 scoped 样式，外部 class 是否落到根节点上，
     *    在小程序各端的表现并不一致（`class` 挂在自定义组件标签上时，
     *    多数端是落在宿主节点、而非组件内部根节点）。「看起来生效、真机不生效」
     *    正是本项目最想避免的缺陷形状，故用 prop 把这件事变成确定的行为。
     */
    highlight?: boolean;
  }>(),
  {
    category: null,
    extra: null,
    verified: null,
    links: () => [],
    clickable: false,
    highlight: false,
  },
);

const emit = defineEmits<{ tap: [] }>();

/** 是否渲染平台角标行 —— 一家都没入驻时整行不显示（原型即如此处理集散中心） */
const showPlatforms = computed(() => props.links.some((l) => l.configured));

/** 平台短名（共享枚举，端上不另写一份映射） */
function shortLabel(platform: string): string {
  return TAKEOUT_PLATFORM_SHORT[platform as TakeoutPlatform] ?? platform;
}

function onTap(): void {
  if (!props.clickable) return;
  emit('tap');
}
</script>

<style lang="scss" scoped>
.supplier-card {
  display: flex;
  align-items: flex-start;
  gap: $space-3;
  margin: $space-3 $space-4 0;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &--hover {
    background: #fbf7ee;
  }

  // 被「定位」的那一张（M5-17）：描金圈 + 浅金底，与平台弹层的「推荐」同一种强调语言。
  // 底色用已登记的金色浅底 token（`$c-trace-card-from`）而非再写一个 rgba —— 请勿新增裸色值。
  &.is-highlight {
    background: $c-trace-card-from;
    border: 2px solid $c-gold;
  }

  &__avatar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 104rpx;
    height: 104rpx;
    background: #efe5d0;
    border-radius: $radius-lg;
  }

  &__avatar-text {
    font-size: 56rpx;
    line-height: 1;
  }

  &__main {
    flex: 1;
    min-width: 0;
  }

  &__hd {
    display: flex;
    align-items: center;
  }

  &__name {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__cat {
    margin-left: $space-2;
    padding: 2rpx $space-1;
    font-size: $fs-caption;
    color: #ffffff;
    background: $c-gold;
    border-radius: $radius-sm;
  }

  &__detail {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__extra {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__verified {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-success;
  }

  &__arrow {
    flex: none;
    align-self: center;
    font-size: 40rpx;
    line-height: 1;
    color: $c-text-weak;
  }
}

.platforms {
  display: flex;
  flex-wrap: wrap;
  gap: $space-1;
  margin-top: $space-2;

  &__tag {
    padding: 2rpx $space-2;
    font-size: $fs-caption;
    border-radius: $radius-sm;

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

    // 未入驻：同色系去饱和 + 降透明度，保留平台身份但明确不可点
    &.is-off {
      color: $c-text-weak;
      background: $c-bg;
      border: 1px dashed $c-border;
    }
  }
}
</style>
