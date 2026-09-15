<template>
  <view class="page">
    <!-- 身份卡 -->
    <view class="profile">
      <view class="profile__avatar">
        <text class="profile__initial">{{ initial }}</text>
      </view>
      <view class="profile__main">
        <text class="profile__name">{{ nickname }}</text>
        <text class="profile__sub">{{ buildingText }}</text>
      </view>
      <view v-if="leaderStore.isLeader" class="profile__badge">
        <text class="profile__badge-text">{{ leaderStore.levelLabel }}团长</text>
      </view>
    </view>

    <!-- 团长专区（L10 · 叠加身份；完整功能 M2 开放） -->
    <view v-if="leaderStore.isLeader" class="section">
      <view class="section__hd">
        <text class="section__title">团长专区</text>
        <text class="section__tag">M2 开放</text>
      </view>
      <view class="card">
        <view class="card__row">
          <text class="card__label">等级 / 费率</text>
          <text class="card__value">{{ leaderStore.levelLabel }} · {{ ratePercent }}</text>
        </view>
        <view class="card__row">
          <text class="card__label">佣金余额</text>
          <text class="card__value card__value--strong">
            ¥{{ leaderStore.info?.balance ?? '0.00' }}
          </text>
        </view>
        <view class="card__row">
          <text class="card__label">升级门槛</text>
          <text class="card__value">{{ levelRuleText }}</text>
        </view>
      </view>
      <view class="tip">
        <text class="tip__text">
          工作台、本楼单量、订单明细、佣金中心与提现已开放，从底部「团长」进入。
        </text>
      </view>
    </view>

    <!-- 非团长：申请入口（M2 · L17 —— 勾选协议后提交即生效，无审核） -->
    <view v-else class="section">
      <view class="card">
        <view class="card__row card__row--link" hover-class="card__row--hover" @tap="goApply">
          <view class="apply">
            <text class="apply__title">申请成为团长</text>
            <text class="apply__sub">勾选协议后提交即生效，见习 8% 起步</text>
          </view>
          <text class="card__arrow">›</text>
        </view>
      </view>
      <view class="tip">
        <text class="tip__text"> 申请前需先绑定办公楼（通过团长邀请链接进入即可绑定）。 </text>
      </view>
    </view>

    <!-- 常用 -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">常用</text>
      </view>
      <view class="card">
        <view class="card__row card__row--link" hover-class="card__row--hover" @tap="goOrders">
          <text class="card__label">我的订单</text>
          <text class="card__arrow">›</text>
        </view>
        <view class="card__row">
          <text class="card__label">所属办公楼</text>
          <text class="card__value">{{ buildingText }}</text>
        </view>
        <view class="card__row card__row--link" hover-class="card__row--hover" @tap="goSupport">
          <text class="card__label">联系客服</text>
          <text class="card__arrow">›</text>
        </view>
      </view>
      <view class="tip">
        <text class="tip__text">
          C3：办公楼通过团长邀请链接绑定；App 不读取定位，也不索取手机号与地址（L9）。 退款 / 提现 /
          退出团长等需人工介入的事项，请添加客服微信处理。
        </text>
      </view>
    </view>

    <!-- 联调（开发期保留） -->
    <view class="section">
      <view class="section__hd">
        <text class="section__title">联调</text>
      </view>
      <view class="card">
        <view class="card__row card__row--link" hover-class="card__row--hover" @tap="clearLocal">
          <text class="card__label card__label--warn">清空本地登录态</text>
          <text class="card__arrow">›</text>
        </view>
      </view>
      <view class="tip">
        <text class="tip__text">
          本小程序为静默授权：清空后下次进入会自动重新登录同一账号（联调期固定 code），
          用于验证「首次进入」链路。
        </text>
      </view>
    </view>

    <ab-bottom-bar active="mine" />
  </view>
</template>

<script setup lang="ts">
/**
 * P8 · 个人中心
 *
 * M1 范围内只落「身份展示 + 入口」：团长身份由 A1 登录出参落库（L10 叠加身份）。
 * 工作台 / 佣金 / 提现属 M2，此处**不提前放可点入口**，避免出现死链。
 *
 * ⚠️ C3 / L9：办公楼只能靠团长邀请链接绑定，端上不读定位、不取手机号与地址。
 */
import { computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { LEADER_LEVEL_META, LeaderLevel } from '@abox/shared-types';

import { fetchMe } from '@/api/auth';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useLeaderStore } from '@/stores/leader';
import { useUserStore } from '@/stores/user';
import { clearAuthStorage } from '@/utils/storage';
import { navigateTo, switchTab } from '@/utils/router';

const { run } = useRequest();
const userStore = useUserStore();
const leaderStore = useLeaderStore();

const nickname = computed(() => userStore.info?.nickname || '微信用户');
const initial = computed(() => nickname.value.slice(0, 1));
const buildingText = computed(() =>
  userStore.hasBuilding ? '已绑定办公楼（见首页取餐点）' : '未绑定办公楼',
);

/** 当前等级的元信息（费率兜底 + 升级门槛文案的唯一来源：shared-types） */
const levelMeta = computed(() => LEADER_LEVEL_META[leaderStore.info?.level ?? LeaderLevel.TRAINEE]);

const ratePercent = computed(() => {
  // 以团长档案的 commissionRate 为准，缺失时回落该等级标准费率（C2）
  const rate = leaderStore.info?.commissionRate
    ? Number(leaderStore.info.commissionRate)
    : levelMeta.value.rate;
  return `${(rate * 100).toFixed(0)}%`;
});

const levelRuleText = computed(() => {
  const m = levelMeta.value;
  if (m.monthlyOrders === 0) return '申请即生效；30 天未促单取消资格';
  return `月单 > ${m.monthlyOrders} 且介绍 ${m.referrals} 名转正团长`;
});

/** 刷新资料（A2），保持本地双身份与库存一致 */
async function refresh(): Promise<void> {
  try {
    const me = await run(() => fetchMe());
    userStore.setLogin(userStore.token, {
      id: me.id,
      nickname: me.nickname,
      avatarUrl: me.avatarUrl,
      phone: me.phone,
      buildingId: me.buildingId,
      teamLeaderId: me.teamLeaderId,
    });
    if (me.isLeader && me.leader) {
      leaderStore.setLeader({
        id: me.leader.id,
        realName: null,
        level: me.leader.level,
        commissionRate: me.leader.commissionRate,
        balance: me.leader.balance,
      });
    }
  } catch (e) {
    toastApiError(e);
  }
}

function goOrders(): void {
  switchTab('/pages/order-list/order-list');
}

/** 进入团长申请页（M2 · L17）；提交成功后本页底栏会按 isLeader 重渲染为 5 项 */
function goApply(): void {
  navigateTo('/pages/leader-apply/leader-apply');
}

/** 联系客服（U17 · 客服微信号页面；人工处理，不要求团长身份） */
function goSupport(): void {
  navigateTo('/pages/support/contact');
}

function clearLocal(): void {
  clearAuthStorage();
  userStore.clear();
  leaderStore.clear();
  uni.showToast({ title: '已清空，下次进入自动重新登录', icon: 'none', duration: 2200 });
}

onShow(() => {
  void refresh();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

.profile {
  display: flex;
  align-items: center;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;

  &__avatar {
    flex: none;
    width: 96rpx;
    height: 96rpx;
    line-height: 96rpx;
    text-align: center;
    background: rgba(201, 168, 118, 0.18);
    border-radius: 50%;
  }

  &__initial {
    font-size: $fs-h1;
    color: $c-text;
  }

  &__main {
    flex: 1;
    margin-left: $space-4;
  }

  &__name {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__sub {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__badge {
    flex: none;
    padding: 4rpx $space-2;
    background: rgba(201, 168, 118, 0.18);
    border-radius: $radius-sm;
  }

  &__badge-text {
    font-size: $fs-caption;
    color: $c-gold;
  }
}

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
    font-weight: 600;
    color: $c-text;
  }

  &__tag {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.card {
  padding: 0 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: $space-3 0;
    border-bottom: 1px solid rgba(228, 216, 195, 0.5);

    &:last-child {
      border-bottom: none;
    }

    &--hover {
      opacity: 0.9;
    }
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;

    &--warn {
      color: $c-warning;
    }
  }

  &__value {
    font-size: $fs-caption;
    color: $c-text;

    &--strong {
      font-size: $fs-h2;
      font-weight: 600;
    }
  }

  &__arrow {
    font-size: $fs-h2;
    color: $c-text-weak;
  }
}

/* 申请成为团长入口（非团长态） */
.apply {
  flex: 1;

  &__title {
    display: block;
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__sub {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.tip {
  margin-top: $space-2;
  padding: 0 $space-1;

  &__text {
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}
</style>
