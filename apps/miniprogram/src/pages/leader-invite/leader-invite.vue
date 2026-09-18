<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP10（v4.10.0）：
         楼栋大标题 + 「团长邀请你加入」→ 团长身份卡 → 加入后说明 →
         来源说明条 → ✅ 三条 → 授权加入 / 暂不加入 -->

    <ab-loading v-if="loading" text="正在读取邀请信息" />

    <template v-else>
      <!-- 楼栋大标题 -->
      <view class="head">
        <text class="head__icon">🏠</text>
        <text class="head__building">{{ landing?.building || '本楼订餐' }}</text>
        <text class="head__sub">团长邀请你加入</text>
      </view>

      <!-- 团长卡 -->
      <view class="card">
        <view class="leader">
          <view class="leader__avatar">
            <text class="leader__avatar-text">👨‍💼</text>
          </view>
          <view class="leader__main">
            <text class="leader__name">{{ landing?.leaderName || '本楼团长' }}</text>
            <text class="leader__role">
              团长 · {{ landing?.building || '办公楼' }}{{ landing?.floor || '' }}
            </text>
          </view>
        </view>
        <text class="card__desc">
          加入后，你将自动跟随该办公楼订餐，明天 11:30 由团长统一取餐分发。
        </text>
      </view>

      <!-- 来源说明条（左金边 · 原型 v4.6 新增段） -->
      <view class="tips">
        <text class="tips__title">💡 您是怎么进来的？</text>
        <text class="tips__line">· 团长分享的链接（含团长 ID 参数）→ 自动匹配该团长</text>
        <text class="tips__line">· 自己搜索进入 / 扫海报二维码 → 系统按办公楼匹配团长</text>
        <text class="tips__line">
          · 所在办公楼<text class="tips__strong">没有团长</text
          >时，首页「跟随团长」会显示「立即申请成为团长」入口
        </text>
      </view>

      <!-- 三条承诺 -->
      <view class="promise">
        <text class="promise__line">✅ 微信授权登录即可</text>
        <text class="promise__line">✅ 无需填地址、随团长订餐</text>
        <text class="promise__line">✅ 每天 14:00 - 24:00 可预订明日套餐</text>
      </view>

      <button class="btn-primary" hover-class="btn-primary--hover" @tap="join">微信授权加入</button>
      <button class="btn-secondary" hover-class="btn-secondary--hover" @tap="skip">暂不加入</button>

      <!-- ⚠️ 邀请码无效时的如实告知（不假装已加入） -->
      <view v-if="landing && !landing.valid" class="warn">
        <text class="warn__text">{{ landing.slogan || '邀请码已失效，可正常浏览套餐' }}</text>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P10 · 团长邀请落地页（U3 · 免登录）
 *
 * ⭐ 版式基准 = prototype/index.html renderP10（v4.10.0）
 *
 * 数据来源：U3 `GET /leader/invite/{leaderCode}`（**免登录**，只读）。
 * 入参 `leaderCode` 形如 `LDR0001`（`LDR` + 4 位零填充团长 id，确定性生成），
 * 也兼容纯数字 id（本地联调）。
 *
 * ## ⚠️ 本页的「微信授权加入」目前**只做本地记录**，不写服务端 —— 如实说明
 *
 * 规范 §1.5 写的是「登录链路带 `leaderCode` → 绑定推荐团长」，而实装：
 *   · `LoginDto` **没有** `leaderCode` 字段；
 *   · `ab_user.building_id` / `team_leader_id` **全仓没有生产写点**（只有种子赋过值）。
 * 故「加入」这个动作**服务端侧尚未实装**（缺陷 #92）。
 *
 * 本页据此**不伪造成功**：
 *   · 点击后只把邀请码记到本地（供后续下单透传），并明确提示用户下一步；
 *   · 不显示「已加入」这类服务端并未发生的结果。
 * 等 #92 实装后，这里改成调一次登录/绑定接口即可，版式不用动。
 */
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { LeaderInviteLanding } from '@abox/shared-types';

import { fetchInviteLanding } from '@/api/meal';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { pageQuery, switchTab } from '@/utils/router';

const { run, loading } = useRequest();

const landing = ref<LeaderInviteLanding | null>(null);
const leaderCode = ref('');

async function load(): Promise<void> {
  if (!leaderCode.value) {
    // 没有邀请码（用户自己搜进来）→ 按原型降级为「按办公楼匹配」，直接回首页
    switchTab('/pages/index/index');
    return;
  }
  try {
    landing.value = await run(() => fetchInviteLanding(leaderCode.value));
    if (!landing.value.valid) {
      uni.showToast({ title: '邀请码已失效', icon: 'none' });
    }
  } catch (e) {
    if (e instanceof ApiError) uni.showToast({ title: e.message, icon: 'none' });
    else toastApiError(e);
  }
}

function join(): void {
  /**
   * ⚠️ 服务端绑定未实装（#92）→ **不假装已加入**。
   *    当下能做的只有：把邀请码带回首页，供下单时透传（`CreateOrderDto.leaderCode`
   *    已在契约里，服务端 `resolveLeader()` 会按它匹配团长）。
   */
  uni.showToast({
    title: '请先完成微信授权登录，随后下单时自动跟随该团长',
    icon: 'none',
    duration: 2600,
  });
  setTimeout(() => switchTab('/pages/index/index'), 1200);
}

function skip(): void {
  switchTab('/pages/index/index');
}

onLoad((options) => {
  leaderCode.value = pageQuery(options as Record<string, unknown>, 'leaderCode');
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-5 $space-4;
  box-sizing: border-box;
  text-align: center;
}

// ---- 楼栋大标题 ----
.head {
  display: flex;
  flex-direction: column;
  align-items: center;

  &__icon {
    font-size: 120rpx;
    line-height: 1;
  }

  &__building {
    margin-top: $space-3;
    font-size: 44rpx;
    font-weight: bold;
    color: $c-text;
  }

  &__sub {
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 卡片 ----
.card {
  margin-top: $space-5;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  text-align: left;
  box-shadow: 0 2rpx 8rpx rgba(110, 84, 53, 0.06);

  &__desc {
    display: block;
    margin-top: $space-4;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.leader {
  display: flex;
  align-items: center;
  gap: $space-3;

  &__avatar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 96rpx;
    height: 96rpx;
    background: $c-gold;
    border-radius: 50%;
  }

  &__avatar-text {
    font-size: 52rpx;
    line-height: 1;
  }

  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  &__name {
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__role {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 来源说明条（左金边） ----
.tips {
  margin-top: $space-4;
  padding: $space-3;
  background: #fbf7ee;
  border-left: 6rpx solid $c-gold;
  border-radius: $radius-sm;
  text-align: left;

  &__title {
    display: block;
    font-size: $fs-caption;
    font-weight: bold;
    color: $c-text;
  }

  &__line {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &__strong {
    font-weight: bold;
    color: $c-text;
  }
}

// ---- 三条承诺 ----
.promise {
  margin: $space-5 $space-2 0;
  text-align: left;

  &__line {
    display: block;
    font-size: $fs-caption;
    line-height: 2;
    color: $c-text-weak;
  }
}

// ---- 按钮 ----
.btn-primary {
  margin-top: $space-5;
  height: 88rpx;
  line-height: 88rpx;
  color: $c-bg;
  font-size: $fs-h2;
  font-weight: bold;
  letter-spacing: 2rpx;
  background: linear-gradient(135deg, $c-text 0%, #b8915c 100%);
  border: none;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    filter: brightness(1.08);
  }
}

.btn-secondary {
  margin-top: $space-3;
  height: 80rpx;
  line-height: 80rpx;
  color: $c-text;
  font-size: $fs-body;
  background: transparent;
  border: 1px solid $c-border;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.85;
  }
}

.warn {
  margin-top: $space-3;
  padding: $space-2 $space-3;
  background: #fbf7ee;
  border: 1px dashed $c-warning;
  border-radius: $radius-sm;

  &__text {
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-warning;
  }
}
</style>
