<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP12（v4.10.0）：
         办公楼金棕大卡（三指标）→ 各订单类型分布 → 今日成员订餐 → 查看订单明细 -->

    <ab-loading v-if="loading && !today" text="正在加载本楼概况" />

    <ab-empty-state
      v-else-if="!today"
      text="概况加载失败"
      hint="请稍后重试"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <!-- ① 办公楼大卡 -->
      <view class="hero">
        <text class="hero__label">我服务的办公楼</text>
        <text class="hero__name">{{ displayOr(profile?.buildingName, '本楼') }}</text>

        <view class="hero__stats">
          <view class="hero__stat">
            <text class="hero__value">{{ today.totalQuantity }}</text>
            <text class="hero__unit">今日份数</text>
          </view>
          <view class="hero__stat">
            <text class="hero__value">{{ fenToYuanText(war?.today.amountFen ?? 0) }}</text>
            <text class="hero__unit">今日 GMV</text>
          </view>
          <view class="hero__stat">
            <text class="hero__value hero__value--gold">
              {{ fenToYuanText(war?.today.commissionFen ?? 0) }}
            </text>
            <text class="hero__unit">我的佣金 {{ ratePercent }}%</text>
          </view>
        </view>

        <text class="hero__foot">{{ heroFoot }}</text>
      </view>

      <!-- ② 各订单类型分布 -->
      <view class="card">
        <text class="card__title">📊 各订单类型分布</text>

        <view
          v-for="row in distribution"
          :key="row.label"
          class="simple"
          :class="{ 'simple--link': row.link }"
          @tap="row.link && goOrders()"
        >
          <text class="simple__label" :class="`is-${row.tone}`">{{ row.label }}</text>
          <text class="simple__value">{{ row.count }} 单</text>
        </view>

        <view class="note">
          <text class="note__text">
            💡 以上为<text class="note__strong">今日实时待处理</text
            >数据；本月历史异常订单已处理记录见 <text class="note__strong">异常订单总览</text>。
          </text>
        </view>
      </view>

      <!-- ③ 今日成员订餐 -->
      <view class="card">
        <text class="card__title">👥 今日成员订餐</text>

        <view class="simple">
          <text class="simple__label simple__label--weak">下单人数</text>
          <text class="simple__value">{{ memberStats.dinerCount }} 人</text>
        </view>
        <view class="simple">
          <text class="simple__label simple__label--weak">人均份数</text>
          <text class="simple__value">{{ memberStats.avgQuantity }} 份</text>
        </view>

        <view class="multi">
          <view class="simple simple--plain">
            <text class="simple__label simple__label--weak">下单多份</text>
            <text class="simple__value simple__value--warn"
              >{{ memberStats.multiList.length }} 人</text
            >
          </view>
          <view v-if="memberStats.multiList.length" class="multi__pills">
            <text v-for="m in memberStats.multiList" :key="m.name" class="multi__pill">
              {{ m.name }} × {{ m.quantity }}
            </text>
          </view>
          <text v-else class="multi__empty">今日没有同事下单多份</text>
        </view>
      </view>

      <button class="btn-primary" hover-class="btn-primary--hover" @tap="goOrders">
        查看订单明细
      </button>

      <text class="foot">
        ⚠️ 原型此处列「未下单同事」—— 该口径需<text class="foot__strong">楼栋成员名册</text>（按
        ab_user.building_id 只能统计已注册用户，没有「应到人数」作分母），当前未实装，
        故以「下单人数 / 人均份数」替代，不做估算填充。
      </text>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P12 · 本楼概况（我服务的办公楼）
 *
 * ⭐ 版式基准 = prototype/index.html renderP12（v4.10.0）
 *
 * 数据来源（四路并发，除 L8 外均 best-effort）：
 *   · L8 `GET /leader/pickup/today`  —— 今日份数 / 已分发 / 待分发 / 成员列表（主数据）
 *   · L14 `GET /leader/profile`      —— 楼名 / 楼层（L8 不返回）
 *   · L1 `GET /leader/workbench`     —— 今日 GMV / 佣金 / 退款单数（L8 无金额字段）
 *   · L6 `GET /leader/orders/abnormal` —— 未支付待处理单数
 *
 * ⚠️ **「未下单同事」不做**（原型有）：该口径需要「楼栋应到人数」作分母，
 *    而系统里只有 `ab_user.building_id`（**已注册用户**）——用「注册数 − 今日下单数」
 *    得到的既不是「未下单同事」也不是任何有意义的量，属**凭空造数**，故如实留白并说明。
 *
 * ⚠️ 佣金口径：计佣基数 = **实发份数**，取餐确认前佣金恒为 0（见 P11 头注）。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchLeaderProfile, fetchWorkbench } from '@/api/leader';
import type { LeaderProfile, LeaderWorkbenchData } from '@/api/leader';
import { fetchLeaderAbnormal, fetchPickupToday } from '@/api/leader-order';
import type { PickupTodayData } from '@/api/leader-order';
import { toastApiError, useRequest } from '@/composables/use-request';
import { displayOr, fenToYuanText } from '@/utils/format';
import { navigateTo } from '@/utils/router';

const { run, loading } = useRequest();

const today = ref<PickupTodayData | null>(null);
const profile = ref<LeaderProfile | null>(null);
const war = ref<LeaderWorkbenchData | null>(null);
const abnormalCount = ref(0);

const ratePercent = computed(() => {
  const r = war.value?.today.rate ?? Number(profile.value?.commissionRate ?? 0);
  return (r * 100).toFixed(0);
});

/** 大卡页脚：如实说明佣金基数（原型「1 单退款已跳过，佣金按实发 N 份结算」） */
const heroFoot = computed(() => {
  const w = war.value?.today;
  if (!w) return '';
  const skip = w.refundCount > 0 ? `${w.refundCount} 单退款已跳过，` : '';
  return `（${skip}佣金按实发 ${w.completedQuantity} 份结算）`;
});

/** 各订单类型分布（口径：全部取服务端数，端上不做减法的口径自造） */
const distribution = computed(() => {
  const w = war.value?.today;
  return [
    {
      label: '✅ 正常订单',
      count: w ? Math.max(0, w.orderCount - w.refundCount) : 0,
      tone: 'success',
      link: false,
    },
    { label: '💸 退款处理中', count: w?.refundCount ?? 0, tone: 'warning', link: false },
    { label: '⚠️ 异常订单（待我处理）', count: abnormalCount.value, tone: 'warning', link: true },
  ];
});

/** 今日成员订餐（人数 / 人均份数 / 多份名单 —— 全部由 L8 成员列表派生） */
const memberStats = computed(() => {
  const members = today.value?.members ?? [];
  const dinerCount = members.length;
  const totalQty = members.reduce((sum, m) => sum + m.quantity, 0);
  const multiList = members
    .filter((m) => m.quantity >= 2)
    .map((m) => ({ name: displayOr(m.userName, '匿名用户'), quantity: m.quantity }));

  return {
    dinerCount,
    avgQuantity: dinerCount ? (totalQty / dinerCount).toFixed(1) : '0.0',
    multiList,
  };
});

async function reload(): Promise<void> {
  try {
    today.value = await run(() => fetchPickupToday());
  } catch (e) {
    toastApiError(e, '本楼概况加载失败');
    return;
  }

  const [p, w, a] = await Promise.allSettled([
    fetchLeaderProfile(),
    fetchWorkbench(),
    fetchLeaderAbnormal(),
  ]);
  if (p.status === 'fulfilled') profile.value = p.value;
  if (w.status === 'fulfilled') war.value = w.value;
  if (a.status === 'fulfilled') abnormalCount.value = a.value.count;
}

function goOrders(): void {
  navigateTo('/pages/leader/orders');
}

onShow(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4;
  box-sizing: border-box;
}

// ---- ① 办公楼大卡 ----
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 36rpx $space-4;
  background: linear-gradient(135deg, $c-gold, #b8892f);
  border-radius: 36rpx;
  color: #ffffff;
  text-align: center;
  box-shadow: 0 10rpx 28rpx rgba(110, 84, 53, 0.2);

  &__label {
    font-size: $fs-caption;
    opacity: 0.92;
  }

  &__name {
    margin: $space-2 0 0;
    font-size: 46rpx;
    font-weight: bold;
  }

  &__stats {
    display: flex;
    align-items: center;
    justify-content: space-around;
    width: 100%;
    margin-top: $space-4;
  }

  &__stat {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  &__value {
    font-size: 42rpx;
    font-weight: bold;

    &--gold {
      color: #ffe082;
    }
  }

  &__unit {
    margin-top: 4rpx;
    font-size: 22rpx;
    opacity: 0.9;
  }

  &__foot {
    margin-top: $space-3;
    font-size: 22rpx;
    line-height: 1.6;
    opacity: 0.9;
  }
}

// ---- 通用卡片 ----
.card {
  margin-top: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &__title {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }
}

.simple {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed #d4c4a8;

  &:last-child {
    border-bottom: none;
  }

  &--plain {
    padding-bottom: 0;
    border-bottom: none;
  }

  &--link {
    // 可点击行（异常订单 → 明细）
    opacity: 0.95;
  }

  &__label {
    font-size: $fs-body;
    color: $c-text;

    &--weak {
      font-size: $fs-caption;
      color: $c-text-weak;
    }

    &.is-success {
      color: $c-success;
    }

    &.is-warning {
      color: $c-warning;
    }
  }

  &__value {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;

    &--warn {
      color: $c-warning;
    }
  }
}

.note {
  margin-top: $space-3;
  padding: $space-2 $space-3;
  background: #fbf7ee;
  border-radius: $radius-sm;

  &__text {
    font-size: 22rpx;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &__strong {
    font-weight: bold;
    color: $c-text;
  }
}

.multi {
  padding-top: $space-1;

  &__pills {
    display: flex;
    flex-wrap: wrap;
    margin-top: $space-2;
  }

  &__pill {
    margin: 0 $space-2 $space-2 0;
    padding: 6rpx $space-3;
    font-size: $fs-caption;
    color: $c-warning;
    background: rgba(196, 69, 54, 0.12);
    border-radius: $radius-pill;
  }

  &__empty {
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.btn-primary {
  height: 88rpx;
  margin-top: $space-4;
  line-height: 88rpx;
  color: #ffffff;
  font-size: $fs-body;
  font-weight: bold;
  background: linear-gradient(135deg, $c-gold, #b8892f);
  border: none;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.88;
  }
}

.foot {
  display: block;
  margin-top: $space-3;
  padding: 0 $space-1;
  font-size: 22rpx;
  line-height: 1.7;
  color: $c-text-weak;

  &__strong {
    font-weight: bold;
    color: $c-text;
  }
}
</style>
