<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP11（v4.10.0）：
         状态战报卡（渐变）→ 等级卡（深棕→金 + 进度条）→ 四宫格入口 -->

    <ab-loading v-if="loading && !data" text="正在加载今日战报" />

    <ab-empty-state
      v-else-if="!data"
      text="今日战报加载失败"
      :hint="errorText"
      illustration="warn-tri"
      action-text="重新加载"
      @action="reload"
    />

    <template v-else>
      <!-- ① 状态战报卡（渐变随状态切换） -->
      <view class="war" :class="`war--${war.kind}`">
        <text v-if="war.kind === 'arrived'" class="war__head"
          ><text class="abi abi-16">{{ I.box }}</text> {{ war.head }}</text
        >
        <text v-else class="war__head">{{ war.head }}</text>
        <text class="war__main"
          ><text class="abi abi-24">{{ I[war.mainIcon] }}</text> {{ war.main }}</text
        >

        <block v-if="war.kind === 'arrived'">
          <text class="war__sub">
            {{ data.today.quantity }} 份（{{ data.today.refundCount }} 单退款已跳过） · 佣金
            {{ fenToYuanText(data.today.commissionFen) }}（{{ ratePercent }}%）
          </text>
          <button class="war__btn" hover-class="war__btn--hover" @tap="goPickup">
            <text class="abi abi-20">{{ I.rice }}</text> 立即去取餐分发 ›
          </button>
          <text class="war__foot"
            ><text class="abi abi-16">{{ I.info }}</text>
            佣金按「实发份数」结算，取餐确认后才计佣</text
          >
        </block>

        <block v-else-if="war.kind === 'delivered'">
          <text class="war__sub">{{ war.sub }}</text>
          <text class="war__foot"
            ><text class="abi abi-16">{{ I.info }}</text> 已计佣
            {{ fenToYuanText(data.today.commissionFen) }} · 待次日入账</text
          >
        </block>

        <block v-else>
          <text v-if="war.sub" class="war__sub">{{ war.sub }}</text>
          <text v-if="war.kind === 'open'" class="war__foot">
            <text class="abi abi-16">{{ I.info }}</text>
            <!-- ⚠️ 原句后半截「分享给同事可提升本月单量」把「分享」与「收益」直接挂钩，
                 属诱导分享红线表述，已删除。前半截「截单后不可自助取消」是对用户权利的
                 如实告知，必须保留。 -->
            截单后不可自助取消
          </text>
        </block>
      </view>

      <!-- ② 等级卡（深棕 → 金渐变 + 进度条 + 双按钮） -->
      <view class="level">
        <view class="level__top">
          <view class="level__left">
            <text class="level__label">我的团长等级</text>
            <text class="level__name">{{ levelLabel }}团长</text>
            <text class="level__rate">
              <!-- ⚠️ 原写「分佣」——「分佣」是分销语境词，改用项目正式口径「佣金」 -->
              佣金 {{ ratePercent }}%{{ isTopLevel ? ' · 已达最高等级' : '' }}
            </text>
          </view>
          <text class="abi abi-deco-34 level__icon">{{ I[isTopLevel ? 'crown' : 'medal'] }}</text>
        </view>

        <view class="level__bar">
          <view class="level__bar-fill" :style="{ width: `${progressPercent}%` }" />
        </view>

        <view class="level__meta">
          <text class="level__meta-item">本月 {{ monthOrders }} 单</text>
          <text class="level__meta-item">已推荐 {{ invitedFormalCount }} 名团长</text>
        </view>

        <view class="level__acts">
          <button class="level__btn" hover-class="level__btn--hover" @tap="goShare">
            <text class="abi abi-20">{{ I.share }}</text> 邀请同事拼饭
          </button>
          <button
            class="level__btn level__btn--ghost"
            hover-class="level__btn--hover"
            @tap="goCommission"
          >
            <text class="abi abi-20">{{ I.cash }}</text> 佣金与等级
          </button>
        </view>
      </view>

      <!-- ③ 四宫格入口 -->
      <view class="grid">
        <view
          v-for="entry in entries"
          :key="entry.path"
          class="grid__item"
          hover-class="grid__item--hover"
          @tap="go(entry.path)"
        >
          <text class="abi abi-deco-28 grid__icon">{{ I[entry.icon] }}</text>
          <text class="grid__label">{{ entry.label }}</text>
          <text class="grid__desc">{{ entry.desc }}</text>
        </view>
      </view>

      <!-- 取餐点（原型未画，但配送信息对团长有用 → 保留为轻量行） -->
      <view class="pickup">
        <text class="pickup__hd"
          ><text class="abi abi-16">{{ I.truck }}</text> 取餐点 · {{ data.pickup.statusText }}</text
        >
        <text class="pickup__point">{{ displayOr(data.pickup.point, '待分配办公楼 / 楼层') }}</text>
        <text class="pickup__meta">
          预计到达 {{ data.pickup.expectAt }}
          <text v-if="data.pickup.driverName"> · {{ data.pickup.driverName }}</text>
          <text v-if="data.pickup.plateNo"> · {{ data.pickup.plateNo }}</text>
        </text>
        <text v-if="data.pickup.actualAt" class="pickup__actual">
          实际送达 {{ formatDateTime(data.pickup.actualAt) }}
        </text>
      </view>
    </template>

    <ab-bottom-bar active="leader" />
  </view>
</template>

<script setup lang="ts">
/**
 * P11 · 团长工作台
 *
 * ⭐ 版式基准 = prototype/index.html renderP11（v4.10.0）
 *
 * 数据来源：
 *   · L1 `GET /leader/workbench` —— 今日战报 + 明日进度 + 取餐点（主数据，必需）
 *   · L14 `GET /leader/profile` —— 本月单量 / 已推荐人数 / 累计单量（等级卡统计，best-effort）
 *   · L8 `GET /leader/pickup/today` —— 待分发份数（四宫格副标题，best-effort）
 *
 * ⚠️ **与原型的一处刻意不同**：原型的战报卡按**客户端当前小时**分支
 *    （`hour>=11.5 && <12` → 送达提醒 / `<14` → 已取餐 / `<24` → 等待接单），
 *    那是原型为演示同一屏四种效果写的假逻辑。实装改为**服务端真实状态驱动**：
 *    配送单已送达 → 送达提醒；今日已有分发 → 已分发；明日可下单 → 分享拉单；
 *    否则等待接单。否则会出现「后端说还在配送中、端上按 11:40 显示『已送达』」。
 * ⚠️ 佣金口径（M2 最高风险项）：**计佣基数 = 实发份数**（`completedQuantity`），
 *    不是下单份数 —— 故「取餐确认 / 一键分发」（P15 · L9）之前佣金恒为 0。
 *    佣金两段式（M4-2）：确认只计佣（`pending`），次日才入账到余额。
 * ⚠️ 不写死「14:00 / 24:00」这类时刻文案（可配，见 `order-timeline.ts`）；
 *    截单只显示服务端给的 `tomorrow.cutoffAt` 派生值。
 */
import { computed, onUnmounted, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchLeaderProfile, fetchWorkbench } from '@/api/leader';
import type { LeaderProfile, LeaderWorkbenchData } from '@/api/leader';
import { fetchPickupToday } from '@/api/leader-order';
import type { PickupTodayData } from '@/api/leader-order';
import { fetchDaily } from '@/api/meal';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useCountdown } from '@/composables/use-countdown';
import { useLeaderStore } from '@/stores/leader';
import {
  displayOr,
  fenToYuanText,
  formatCountdown,
  formatDateTime,
  formatMealDate,
  formatTime,
} from '@/utils/format';
import { navigateTo } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';
import type { AboxIconName } from '@abox/shared-utils';

const { run, loading, error } = useRequest();
const leaderStore = useLeaderStore();

const data = ref<LeaderWorkbenchData | null>(null);
const profile = ref<LeaderProfile | null>(null);
const pickup = ref<PickupTodayData | null>(null);

/**
 * ⭐ 截单倒计时 —— 走 `useCountdown`（**以服务端剩余秒数起表**，本地只做递减）
 *
 * ⚠️ 为什么不拿 `tomorrow.cutoffAt − Date.now()` 自己算（这是本页此前的写法）：
 *    那样 `now` 取的是**设备本地时钟**，用户改系统时间或设备漂移时倒计时直接失准，
 *    而团长正是拿这个数字判断「还能不能再拉一单」。同一个数字，首页 P1 走 U1 的
 *    `countdownSec`（服务端时钟），本页走本地时钟 ⇒ 两端同屏对不上。
 *    判据见 `composables/use-countdown.ts` 头注第 4-8 行。
 *
 * 【本页的取数路径】L1 战报**不带** `countdownSec`（服务端 `workbench.service.ts`
 * 只下发 `cutoffAt`）。按「不为此新增后端字段」的约束，复用**已存在的** U1：
 * `GET /home/daily?mealDate=<tomorrow.mealDate>` ⇒ `countdownSec`
 * （服务端实现 `apps/api-server/src/modules/meal/meal.service.ts`：`targetDate =
 * mealDate ?? tomorrowBj()`，故显式传餐日时二者严格同源）。
 */
const { remainSec, start: startTick, stop: stopTick } = useCountdown();

/** 倒计时是否拿到了**与本次战报同一出餐日**的服务端秒数；拿不到就不展示倒计时 */
const countdownReady = ref(false);

const errorText = computed(() => error.value?.message ?? '请稍后重试');
const ratePercent = computed(() => (data.value ? (data.value.today.rate * 100).toFixed(0) : '--'));
const levelLabel = computed(
  () => profile.value?.levelLabel ?? data.value?.today.levelLabel ?? '见习',
);
const isTopLevel = computed(() => (profile.value?.level ?? data.value?.today.level) === 'chief');
const monthOrders = computed(() => profile.value?.monthOrders ?? data.value?.today.orderCount ?? 0);
const invitedFormalCount = computed(() => profile.value?.invitedFormalCount ?? 0);

/**
 * 进度条：首席 = 100%；其余按**首席门槛（月 100 单）**折算相对进度。
 * ⚠️ 这里只做视觉进度，不做「还差几单」的判断 —— 真正的升级判定 = L22 + C2 双条件
 *    （月单 + 介绍转正**须同时满足**），端上不自造。
 */
const progressPercent = computed(() => {
  if (isTopLevel.value) return 100;
  const pct = Math.round((monthOrders.value / 100) * 100);
  return Math.min(100, Math.max(4, pct));
});

/** 战报卡四态（真实状态驱动，非时刻驱动） */
type WarKind = 'arrived' | 'delivered' | 'open' | 'waiting';

const war = computed<{
  kind: WarKind;
  head: string;
  mainIcon: AboxIconName;
  main: string;
  sub: string;
}>(() => {
  const d = data.value;
  if (!d) return { kind: 'waiting', head: '', mainIcon: 'clock', main: '', sub: '' };

  if (d.pickup.status === 'arrived') {
    return {
      kind: 'arrived',
      head: '餐已送达办公楼下！',
      mainIcon: 'clock',
      main: `${displayOr(d.pickup.buildingName, '本办公楼')} · ${d.pickup.expectAt}`,
      sub: '',
    };
  }

  if (d.today.completedQuantity > 0) {
    return {
      kind: 'delivered',
      head: `今日 ${formatMealDate(d.today.mealDate)}`,
      mainIcon: 'check',
      main:
        `已取餐分发 ${d.today.completedQuantity}/${d.today.quantity}` +
        (d.today.refundCount > 0 ? `（${d.today.refundCount} 单退款已跳过）` : ''),
      sub: '佣金已计，次日自动入账到余额',
    };
  }

  if (d.tomorrow.canOrder) {
    return {
      kind: 'open',
      head: `明日 ${formatMealDate(d.tomorrow.mealDate)} · 预订已开放`,
      mainIcon: 'share',
      main: '现在分享拉单',
      // ⚠️ 拿不到服务端秒数（`countdownReady=false`）就**不显示倒计时这一行**，
      //    而不是拿本地时钟硬算一个出来 —— 理由见上面 `remainSec` 处的头注。
      sub: countdownReady.value ? `截单倒计时：${formatCountdown(remainSec.value)}` : '',
    };
  }

  return {
    kind: 'waiting',
    head: `明日 ${formatMealDate(d.tomorrow.mealDate)}`,
    mainIcon: 'clock',
    main: '等待开始接单',
    sub: d.tomorrow.cutoffAt ? `本日截单 ${formatTime(d.tomorrow.cutoffAt)}` : '下单窗口未开放',
  };
});

const pendingDesc = computed(() => {
  const p = pickup.value;
  if (!p) return '待确认分发';
  return p.pendingQuantity > 0 ? `${p.pendingQuantity} 份待取` : '今日已全部分发';
});

const entries = computed(
  (): Array<{ icon: AboxIconName; label: string; desc: string; path: string }> => [
    { icon: 'share', label: '分享拉单', desc: '2 种分享方式', path: '/pages/leader/share' },
    {
      icon: 'list',
      label: '本办公楼订单',
      desc: `${data.value?.today.quantity ?? 0} 份 · 退款中 ${data.value?.today.refundCount ?? 0} 单`,
      path: '/pages/leader/orders',
    },
    {
      icon: 'rice',
      label: '今日取餐',
      desc: pickup.value ? pendingDesc.value : (data.value?.pickup.statusText ?? '待确认分发'),
      path: '/pages/leader/pickup',
    },
    {
      icon: 'users',
      label: '团长资料',
      desc: `累计 ${profile.value?.totalOrders ?? 0} 单`,
      path: '/pages/leader/profile',
    },
  ],
);

/**
 * 起表：向 U1 要**本次战报那个出餐日**的服务端剩余秒数
 *
 * ⚠️ U1 在该楼群当日未编排时会抛 `MEAL_NOT_PUBLISHED`，也有可能与战报的餐日对不上
 *    （战报刷新的瞬间跨日）。这两种情况都**不当错误弹出去**，而是：
 *    停表 + `countdownReady=false` ⇒ 战报卡那行自动不显示倒计时 —— 与首页
 *    「取不到就整行隐藏」的同一条纪律（`pages/index/index.vue` `cutoffTimeText`）。
 */
async function startCountdown(mealDate: string): Promise<void> {
  stopCountdown();
  countdownReady.value = false;

  try {
    // ⚠️ `{ keepAuthState: true }` —— 本请求由 `reload()` 里那句 `void startCountdown(...)`
    //    **发射后不管**：响应落到哪一个 tick 完全不受 await 约束，是全页最有可能「晚回来
    //    一步」的一条腿。它无权裁决登录态 —— 否则会把 `run()` 刚重登写进去的新 token 清掉。
    const daily = await fetchDaily(mealDate, { keepAuthState: true });
    // 服务端可能忽略入参回落成「它的明天」——餐日对不上就不能用作本卡的依据
    if (daily.mealDate !== mealDate) return;
    countdownReady.value = true;
    startTick(daily.countdownSec);
  } catch {
    countdownReady.value = false;
  }
}

function stopCountdown(): void {
  stopTick();
}

async function reload(): Promise<void> {
  try {
    data.value = await run(() => fetchWorkbench());
    void startCountdown(data.value.tomorrow.mealDate);
  } catch (e) {
    toastApiError(e, '今日战报加载失败');
    return;
  }

  // 等级统计与待分发份数：best-effort，失败不挡主内容
  // ⚠️ 两条都带 `{ keepAuthState: true }`：与上面那条 `run()` 共用同一枚 token，token 到期
  //    是齐射；`allSettled` 让它们连错都不报，若允许这里清态没人会知道发生过什么。
  //    注意 `startCountdown()` 里那条 `fetchDaily` 与本批并发（fire-and-forget）。
  const [p, k] = await Promise.allSettled([
    fetchLeaderProfile({ keepAuthState: true }),
    fetchPickupToday({}, { keepAuthState: true }),
  ]);
  if (p.status === 'fulfilled') {
    profile.value = p.value;
    // 档案里的余额/等级是权威值，顺手刷新本地身份缓存（避免与 P8 显示两个等级）
    if (leaderStore.isLeader) {
      leaderStore.setLeader({
        id: p.value.id,
        realName: p.value.realName,
        level: p.value.level,
        commissionRate: p.value.commissionRate,
        balance: p.value.balance,
        balanceFen: p.value.balanceFen,
        frozenFen: p.value.frozenFen,
      });
    }
  }
  if (k.status === 'fulfilled') pickup.value = k.value;
}

function go(path: string): void {
  navigateTo(path);
}

function goPickup(): void {
  navigateTo('/pages/leader/pickup');
}

function goShare(): void {
  navigateTo('/pages/leader/share');
}

function goCommission(): void {
  navigateTo('/pages/leader/commission');
}

onShow(() => {
  void reload();
});

onUnmounted(() => {
  stopCountdown();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

// ---- ① 状态战报卡 ----
.war {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 36rpx $space-4;
  border-radius: 36rpx;
  color: #ffffff;
  text-align: center;
  box-shadow: 0 10rpx 28rpx rgba(110, 84, 53, 0.18);

  // 送达提醒（暖红）
  // ⚠️ 色停必须两头不同 —— 原为 `$c-warning, $c-warning`（同值 ⇒ 渲染是纯色，
  //    「渐变」纯属摆设）。按本组其余三态的同一个写法对齐（`原色 → 加强档`，
  //    如 `--delivered` 的 `$c-success → $c-ok-fg`）。此处过渡刻意很轻。
  &--arrived {
    background: linear-gradient(135deg, $c-warning, $c-warn-fg);

    .war__btn {
      color: $c-warn-fg;
    }
  }

  // 已分发（成功绿）
  &--delivered {
    background: linear-gradient(135deg, $c-success, $c-ok-fg);
  }

  // 预订开放（金棕）
  &--open {
    background: linear-gradient(135deg, $c-gold-deep, $c-text);
  }

  // 等待接单（暖棕）
  &--waiting {
    background: linear-gradient(135deg, $c-text-weak, $c-text);
  }

  &__head {
    font-size: $fs-caption;
    opacity: 0.92;
  }

  &__main {
    margin: $space-2 0;
    font-size: 46rpx;
    font-weight: bold;
    line-height: 1.35;
  }

  &__sub {
    font-size: $fs-caption;
    line-height: 1.6;
    opacity: 0.92;
  }

  &__btn {
    height: 72rpx;
    margin-top: $space-3;
    padding: 0 $space-5;
    line-height: 72rpx;
    color: $c-text;
    font-size: $fs-body;
    font-weight: bold;
    background: #ffffff;
    border: none;
    border-radius: $radius-pill;

    &::after {
      border: none;
    }

    &--hover {
      opacity: 0.88;
    }
  }

  &__foot {
    width: 100%;
    margin-top: $space-3;
    padding-top: $space-2;
    border-top: 1px solid rgba(255, 255, 255, 0.24);
    font-size: 22rpx;
    line-height: 1.6;
    opacity: 0.88;
  }
}

// ---- ② 等级卡 ----
.level {
  margin-top: $space-3;
  padding: $space-4;
  background: linear-gradient(135deg, $c-text, $c-gold-deep);
  border-radius: 32rpx;
  color: #ffffff;
  box-shadow: 0 8rpx 22rpx rgba(110, 84, 53, 0.2);

  &__top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__left {
    flex: 1;
    min-width: 0;
  }

  &__label {
    display: block;
    font-size: $fs-caption;
    opacity: 0.9;
  }

  &__name {
    display: block;
    margin: 6rpx 0;
    font-size: 40rpx;
    font-weight: bold;
  }

  &__rate {
    display: block;
    font-size: $fs-caption;
    opacity: 0.9;
  }

  &__icon {
    flex: none;
    margin-left: $space-3;
  }

  &__bar {
    height: 14rpx;
    margin-top: $space-3;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.22);
    border-radius: $radius-pill;
  }

  &__bar-fill {
    height: 100%;
    background: linear-gradient(90deg, $c-gold-deep, #ffffff);
    border-radius: $radius-pill;
    transition: width 0.4s ease;
  }

  &__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: $space-2;
  }

  &__meta-item {
    font-size: 22rpx;
    opacity: 0.95;
  }

  &__acts {
    display: flex;
    margin-top: $space-3;
  }

  &__btn {
    flex: 1;
    height: 68rpx;
    line-height: 68rpx;
    color: #ffffff;
    font-size: $fs-caption;
    font-weight: bold;
    background: rgba(255, 255, 255, 0.22);
    border: none;
    border-radius: $radius-pill;

    &::after {
      border: none;
    }

    &--hover {
      opacity: 0.85;
    }

    &--ghost {
      margin-left: $space-2;
      font-weight: normal;
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.45);
    }
  }
}

// ---- ③ 四宫格 ----
.grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  margin-top: $space-3;

  &__item {
    width: 48.5%;
    margin-bottom: $space-3;
    padding: $space-4 0;
    background: $c-surface;
    border: 1px solid $c-border;
    border-radius: $radius-lg;
    box-shadow: $shadow-card;
    text-align: center;

    &--hover {
      opacity: 0.86;
    }
  }

  &__icon {
    display: block;
  }

  &__label {
    display: block;
    margin-top: $space-2;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__desc {
    display: block;
    margin-top: 4rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

// ---- 取餐点 ----
.pickup {
  padding: $space-3 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;

  &__hd {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__point {
    display: block;
    margin-top: $space-1;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__meta {
    display: block;
    margin-top: 6rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__actual {
    display: block;
    margin-top: 6rpx;
    font-size: $fs-caption;
    color: $c-ok-fg;
  }
}
</style>
