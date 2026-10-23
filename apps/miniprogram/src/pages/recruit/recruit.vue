<template>
  <view class="page">
    <!-- Hero（标题抓人 + 一个动机钩子，轻量口径，不写"爬楼/苦力"） -->
    <view class="hero">
      <text class="hero__kicker">ABox 一盒 · 团长招募</text>
      <text class="hero__title">顺手带个餐，同事中午不跑腿</text>
      <text class="hero__sub"
        >在办公楼里，把身边同事想吃的凑成团。取餐时顺手带一份，送到工位——不跑腿、不囤货，你只是给同事带个饭而已。</text
      >
    </view>

    <!-- 动机条（单一钩子） -->
    <view class="band">
      <text class="band__title">为什么是你来带，而不是让同事自己取？</text>
      <text class="band__desc"
        >同事花钱买的不是"一份盒饭"，是"中午不用动"。你顺手带一份，整层楼省下的，是每天最贵的那二十分钟。</text
      >
    </view>

    <!-- 佣金阶梯（中性口径：按单计提 / 四档佣金；测算示例·以实际接单为准） -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">按单计提 · 四档佣金</text>
        <text class="section__tag">卖一盒赚一盒</text>
      </view>
      <view class="ladder">
        <view v-for="row in levelRules" :key="row.key" class="lv">
          <text class="lv__rate">{{ Math.round(row.rate * 100) }}%</text>
          <text class="lv__name">{{ row.name }}</text>
          <text class="lv__cond">{{ row.condition }}</text>
        </view>
      </view>
      <view class="lvnote">
        <text
          >每单 ¥25.80，见习每单约赚 ¥2.06（测算示例 · 以实际接单为准）。每天顺手带几份，月均约
          ¥200+。升级看"月单量 且 介绍 N 名转正团长"，双条件须同时满足。</text
        >
      </view>
    </view>

    <!-- 团长做什么（轻量，不写"逐层爬楼"） -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">团长到底做什么</text>
        <text class="section__tag">很轻</text>
      </view>
      <view class="do-card">
        <text class="do-card__lead"
          >在办公楼里，把大家想吃的凑成团，取餐时顺手带一份给同事，带到工位、不跑腿不囤货。</text
        >
        <view class="steps">
          <view class="step">
            <view class="step__dot"><text class="step__num">1</text></view>
            <text class="step__st">取餐点\n统一取餐</text>
          </view>
          <text class="step__arrow">{{ I.chev }}</text>
          <view class="step">
            <view class="step__dot"><text class="step__num">2</text></view>
            <text class="step__st">回楼\n按份分装</text>
          </view>
          <text class="step__arrow">{{ I.chev }}</text>
          <view class="step">
            <view class="step__dot"><text class="step__num">3</text></view>
            <text class="step__st">带到\n工位</text>
          </view>
          <text class="step__arrow">{{ I.chev }}</text>
          <view class="step">
            <view class="step__dot"><text class="step__num">4</text></view>
            <text class="step__st">同事\n零走动</text>
          </view>
        </view>
        <view class="honest">
          <text
            >一栋楼可以有很多团长，每位只帮身边几个同事带几份——纯顺手。如实说：见习 30
            天未促成订单，资格自动取消。</text
          >
        </view>
      </view>
    </view>

    <!-- 两种参与方式（互斥，无同义并存） -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">两种参与方式</text>
        <text class="section__tag">任选</text>
      </view>
      <view class="modes">
        <view class="mode">
          <text class="mode__badge">方式一</text>
          <text class="mode__mt">自己当团长</text>
          <text class="mode__md">提交即生效，零押金。顺手带几份，按月计提佣金。</text>
        </view>
        <view class="mode">
          <text class="mode__badge">方式二</text>
          <text class="mode__mt">只介绍、不当</text>
          <text class="mode__md"
            >身边谁合适？介绍 1 名朋友转正，你得单层现金红包（不抽其下线）。</text
          >
        </view>
      </view>
    </view>

    <!-- 严选厨房（复用资质墙数据 · 单源；每项 → 出品方资质页） -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">你代表的厨房</text>
        <text class="section__tag">资质透明</text>
      </view>
      <view class="kit">
        <text class="kit__t">严选厨房 · 拒绝预制菜与脏乱差</text>
        <text class="kit__d"
          >你即将代表的，是附近的在册小店。点任意一家，可看营业执照等资质——你带出去的每一盒，都经得起看。</text
        >
        <view v-if="loading" class="kit__hint"><text class="kit__hint-text">加载中…</text></view>
        <view v-else-if="serving.length" class="kit__list">
          <view
            v-for="s in serving"
            :key="s.id"
            class="kit__item"
            hover-class="kit__item--hover"
            @tap="goSupplier(s.id)"
          >
            <view class="kit__item-main">
              <text class="kit__item-name">{{ s.name }}</text>
              <text class="kit__item-sub"
                >在册资质 {{ s.qualifications.length }} 项 · 累计供餐 {{ s.totalServed }} 份</text
              >
            </view>
            <text class="abi abi-16 kit__item-arrow">{{ I.chev }}</text>
          </view>
        </view>
        <view v-else class="kit__hint"><text class="kit__hint-text">暂无在册厨房</text></view>
      </view>
    </view>

    <!-- CTA（一屏一义：两枚语义互斥按钮，无同义并存） -->
    <view class="cta-wrap">
      <button class="cta cta--a" hover-class="cta--hover" @tap="goApply">申请成为团长</button>
      <button class="cta cta--b" hover-class="cta--hover" @tap="goInvite">介绍给合适的同事</button>
    </view>

    <view class="foot">
      <text class="foot__text"
        >申请即代表同意《团长协议》。佣金按售价计提，次月结算；介绍奖励为单层现金红包，非分销抽成。</text
      >
    </view>

    <ab-bottom-bar active="recruit" />
  </view>
</template>

<script setup lang="ts">
/**
 * 招募页（2026-10-23 重构 · 原「供应商」底部 tab 落点）
 *
 * ## 定位
 * 落地 / 营销页：把"想当团长 / 想介绍朋友"的人**导向**已开发的 `leader-apply` 与
 * `leader-invite`。本页**不重复做表单**（表单在 leader-apply），只做动机 + 透明 + 入口。
 *
 * ## 文案铁律（见项目 MEMORY · 招募页口径）
 * ① 标题先抓人 + 一个动机钩子 + 短，禁平铺产品说明；
 * ② 收益直白是**提审红线**：一律"按单计提 / 四档佣金"式中性语，禁"躺赚 / 轻松赚 / 零花钱"；
 *    金额写"测算示例 · 以实际接单为准"；收益量级按**个人顺手**算（每天几份、月约 ¥200+），
 *    禁按"全楼 N 单 / 月 ¥XXX"渲染。
 * ③ 交付口径 = 轻（"顺手带给大家 / 带到工位、不跑腿不囤货"），**严禁**写"逐层爬楼 / 一层层
 *    送上楼 / 苦力活"—— 用户原话"就是给同事带个餐而已"。
 * ④ 一栋楼可有多团长，每位只帮身边几个同事带几份，纯顺手；服务范围不暗示"一栋楼一位 / 全楼"。
 * ⑤ CTA 一屏一义："成为团长"字样**整页只出现一次**，且只作路径 A 的动作按钮（申请成为团长）；
 *    路径 A / B 各带语义互斥按钮（申请成为团长 / 介绍给合适的同事），禁"总按钮 + 卡标题 + 小链接"同义并存。
 * ⑥ 全页不出现任何第三方平台名（五项禁令）。
 *
 * ## 严选厨房（单源）
 * 直接复用既有数据接口 `fetchSupplierQualifications()`（`api/traceability`，`serving` 组），
 * 不再另开一份列表页（决策4：复用其数据）。每项 `id` 跳 `supplier/detail?id=`。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';
import { fetchSupplierQualifications } from '@/api/traceability';
import { toastApiError, useRequest } from '@/composables/use-request';
import { navigateTo, buildUrl } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

type SupplierItemLite = {
  id: number;
  name: string;
  qualifications: unknown[];
  totalServed: number;
};

const { run } = useRequest();
const loading = ref(false);
const serving = ref<SupplierItemLite[]>([]);

const LADDER: readonly LeaderLevel[] = [
  LeaderLevel.TRAINEE,
  LeaderLevel.FORMAL,
  LeaderLevel.GOLD,
  LeaderLevel.CHIEF,
];

const levelRules = computed(() =>
  LADDER.map((key) => {
    const meta = LEADER_LEVEL_META[key];
    return {
      key,
      name: `${meta.label}团长`,
      rate: meta.rate,
      condition:
        key === LeaderLevel.TRAINEE
          ? '提交申请即生效'
          : `月单 > ${meta.monthlyOrders} 且介绍 ${meta.referrals} 名转正团长`,
    };
  }),
);

async function loadKitchen(): Promise<void> {
  loading.value = true;
  try {
    const res = await run(() => fetchSupplierQualifications());
    serving.value = (res.serving ?? []) as SupplierItemLite[];
  } catch (e) {
    serving.value = [];
    toastApiError(e);
  } finally {
    loading.value = false;
  }
}

function goApply(): void {
  navigateTo('/pages/leader-apply/leader-apply');
}

function goInvite(): void {
  navigateTo('/pages/leader-invite/leader-invite');
}

function goSupplier(id: number): void {
  navigateTo(buildUrl('/pages/supplier/detail', { id }));
}

onShow(() => {
  void loadKitchen();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

// ---- Hero ----
.hero {
  padding: $space-5 $space-4;
  background: linear-gradient(150deg, $c-text 0%, $c-gold-deep 100%);
  border-radius: $radius-lg;
  color: $c-surface;

  &__kicker {
    display: block;
    font-size: $fs-caption;
    letter-spacing: 3rpx;
    opacity: 0.85;
  }

  &__title {
    display: block;
    margin-top: $space-2;
    font-size: $fs-h1;
    font-weight: bold;
    line-height: 1.4;
    letter-spacing: 1rpx;
  }

  &__sub {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.9;
    opacity: 0.95;
  }
}

// ---- 动机条 ----
.band {
  margin-top: $space-3;
  padding: $space-3 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-left: 4rpx solid $c-gold-deep;
  border-radius: $radius-md;

  &__title {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__desc {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    line-height: 1.8;
    color: $c-text-weak;
  }
}

// ---- 章节通用 ----
.section {
  margin-top: $space-5;

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
    border-left: 4rpx solid $c-gold-deep;
    padding-left: $space-2;
  }

  &__tag {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 佣金阶梯 ----
.ladder {
  display: flex;
  gap: $space-2;
}

.lv {
  flex: 1;
  padding: $space-3 $space-1;
  text-align: center;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;
  overflow: hidden;

  &__rate {
    display: block;
    font-size: $fs-h1;
    font-weight: bold;
    color: $c-gold-fg;
  }

  &__name {
    display: block;
    margin-top: 2rpx;
    font-size: $fs-caption;
    font-weight: bold;
    color: $c-text;
  }

  &__cond {
    display: block;
    margin-top: $space-1;
    padding-top: $space-1;
    border-top: 1px dashed $c-border-strong;
    font-size: 10.5px;
    line-height: 1.5;
    color: $c-text-weak;
  }
}

.lvnote {
  margin-top: $space-2;
  padding: $space-2 $space-3;
  font-size: $fs-caption;
  line-height: 1.8;
  color: $c-text-weak;
  background: $c-surface-2;
  border-radius: $radius-sm;
}

// ---- 团长做什么 ----
.do-card {
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__lead {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    line-height: 1.8;
    color: $c-text;
  }
}

.steps {
  display: flex;
  align-items: center;
  margin-top: $space-4;
}

.step {
  flex: 1;
  text-align: center;

  &__dot {
    width: 56rpx;
    height: 56rpx;
    margin: 0 auto $space-1;
    line-height: 56rpx;
    text-align: center;
    background: $c-text;
    border-radius: 999rpx;
  }

  &__num {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-surface;
  }

  &__st {
    display: block;
    font-size: 10.5px;
    line-height: 1.5;
    color: $c-text-weak;
    white-space: pre-line;
  }

  &__arrow {
    flex: none;
    color: $c-gold-fg;
    font-size: $fs-body;
    padding: 0 2rpx;
  }
}

.honest {
  margin-top: $space-3;
  padding: $space-2 $space-3;
  font-size: $fs-caption;
  line-height: 1.85;
  color: $c-text-weak;
  background: $c-gold-bg;
  border-radius: $radius-sm;
}

// ---- 两种参与方式 ----
.modes {
  display: flex;
  gap: $space-3;
}

.mode {
  flex: 1;
  padding: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__badge {
    display: inline-block;
    padding: 2rpx 14rpx;
    font-size: $fs-caption;
    color: $c-surface;
    background: $c-text;
    border-radius: 999rpx;
  }

  &__mt {
    display: block;
    margin-top: $space-2;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__md {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    line-height: 1.85;
    color: $c-text-weak;
  }
}

// ---- 严选厨房 ----
.kit {
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__t {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__d {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    line-height: 1.9;
    color: $c-text-weak;
  }

  &__hint {
    margin-top: $space-3;
    text-align: center;

    &-text {
      font-size: $fs-caption;
      color: $c-text-weak;
    }
  }

  &__list {
    margin-top: $space-3;
  }

  &__item {
    display: flex;
    align-items: center;
    padding: $space-3 0;
    border-bottom: 1px dashed $c-border-strong;

    &:last-child {
      border-bottom: none;
    }

    &--hover {
      opacity: 0.6;
    }
  }

  &__item-main {
    flex: 1;
    min-width: 0;
  }

  &__item-name {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__item-sub {
    display: block;
    margin-top: 2rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__item-arrow {
    color: $c-gold-fg;
  }
}

// ---- CTA（两枚互斥按钮） ----
.cta-wrap {
  margin-top: $space-5;
  display: flex;
  flex-direction: column;
  gap: $space-3;
}

.cta {
  width: 100%;
  height: 92rpx;
  font-size: $fs-body;
  font-weight: bold;
  line-height: 92rpx;
  border-radius: $radius-pill;
  border: none;

  &::after {
    border: none;
  }

  &--a {
    color: $c-surface;
    background: linear-gradient(135deg, $c-text 0%, $c-gold-deep 100%);
  }

  &--b {
    color: $c-text;
    background: $c-surface;
    border: 1px solid $c-text;
  }

  &--hover {
    filter: brightness(1.06);
  }
}

.foot {
  margin-top: $space-3;
  padding: 0 $space-2;

  &__text {
    font-size: $fs-caption;
    line-height: 1.8;
    color: $c-text-weak;
  }
}
</style>
