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
        <!-- ⚠️ 时刻来自响应（`landing.deliverAt`）—— 曾写死 `11:30`（PR-02 收口）；
             本页**免登录**，无法借其它接口取值，故随落地响应一并下发 -->
        <text class="card__desc">
          加入后，你将自动跟随该办公楼订餐，明天 {{ landing?.deliverAt || '' }} 由团长统一取餐分发。
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

      <button
        class="btn-primary"
        hover-class="btn-primary--hover"
        :loading="joining"
        :disabled="joining"
        @tap="join"
      >
        微信授权加入
      </button>
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
 * ## ✅ 「微信授权加入」已接服务端（2026-09-18 收口缺陷 #92）
 *
 * 规范 §1.5 的「登录链路带邀请码 → 绑定推荐团长」现已实装：
 *   · `AuthService.login` 读 `LoginDto.inviteCode` → 写 `ab_user.team_leader_id` /
 *     `building_id`，并落 `ab_leader_invite`（`InviteService.bindOnInvite`）；
 *   · 端上由 `utils/auth.ts#bindLeaderByInvite` 调用（**登录 + 绑定同一趟**）。
 *
 * ⚠️ 修正一条**此前写错的事实**（原注释称「`ab_user` 两列全仓没有生产写点」）：
 *    它们**有**写点，但只在另外两条路径 ——「申请成为团长」（L17）与「后台任命」；
 *    **扫码绑定这条确实没有**。这正是「入口有、写点无」，#92 补的就是这条。
 *
 * ⚠️ 失效码的兜底：服务端对无效 / 停职团长返回 `30007`（**整趟登录失败**，
 *    刻意不静默忽略 —— 否则又是「用户以为加入了、服务端什么也没发生」）。
 *    故 `bindLeaderByInvite` 捕获后**回落成普通登录**，只把「没绑上」如实告诉用户。
 */
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { LeaderInviteLanding } from '@abox/shared-types';

import { fetchInviteLanding } from '@/api/meal';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { bindLeaderByInvite } from '@/utils/auth';
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

/**
 * 「微信授权加入」→ 登录 + 绑定推荐团长（同一趟）
 *
 * ⭐ 2026-09-18 起**真的写服务端**了（#92 收口）。本函数仍然**不伪造成功**：
 *   · 绑上了 → 「已加入，下单自动跟随该团长」；
 *   · 绑定失败（码失效 / 团长停职）→ 如实说「邀请码已失效」，但**登录仍然成功**
 *     （`bindLeaderByInvite` 内部回落普通登录），用户可以正常浏览下单。
 *
 * ⚠️ 实装后**不再需要「本地记一笔」**（旧注释里的那套兜底从未落地、现在也不需要了）：
 *   归属的真源是 `ab_user.team_leader_id`，下单链路 `resolveLeader()` 缺省就用它。
 *   再造一个本地缓存 + 透传 `CreateOrderDto.leaderCode` 只会让「归属」有两处真源。
 */
const joining = ref(false);

async function join(): Promise<void> {
  if (joining.value) return;
  joining.value = true;
  try {
    const { bound, message } = await bindLeaderByInvite(leaderCode.value);
    uni.showToast({
      title: bound ? '已加入，下单将自动跟随该团长' : `邀请码未生效（${message}）`,
      icon: bound ? 'success' : 'none',
      duration: 2200,
    });
  } catch (e) {
    // 连兜底的普通登录都失败 → 网络层问题，如实提示
    if (e instanceof ApiError) uni.showToast({ title: e.message, icon: 'none' });
    else toastApiError(e);
  } finally {
    joining.value = false;
    setTimeout(() => switchTab('/pages/index/index'), 1400);
  }
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
