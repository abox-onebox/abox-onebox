<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP20（v4.10.0）：
         头像卡（三指标）→ 服务办公楼 → 团长晋升进度 → 账户设置（菜单式） -->

    <ab-loading v-if="loading && !profile" text="正在加载团长资料" />

    <ab-empty-state
      v-else-if="!profile"
      text="资料加载失败"
      hint="请稍后重试"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <!-- ① 头像卡 -->
      <view class="card card--center">
        <view class="avatar">
          <text class="avatar__icon">👨‍💼</text>
        </view>
        <text class="hero__name">{{ profile.realName }}</text>
        <view class="hero__tags">
          <text class="hero__tag">{{ profile.levelLabel }}团长</text>
          <text class="hero__tag hero__tag--gold">
            分佣 {{ (Number(profile.commissionRate) * 100).toFixed(0) }}%
          </text>
        </view>

        <view class="stats">
          <view class="stats__item">
            <text class="stats__value stats__value--gold">{{ totalCommissionText }}</text>
            <text class="stats__label">累计佣金</text>
          </view>
          <view class="stats__item">
            <text class="stats__value">{{ profile.totalOrders }}</text>
            <text class="stats__label">累计单量</text>
          </view>
          <view class="stats__item">
            <text class="stats__value">{{ profile.invitedFormalCount }}</text>
            <text class="stats__label">推荐成功</text>
          </view>
        </view>
      </view>

      <!-- ② 服务办公楼 -->
      <view class="card">
        <view class="card__hd">
          <text class="card__title">🏢 服务办公楼</text>
          <text class="card__link" @tap="askSwitchBuilding">切换 ›</text>
        </view>

        <view class="bld">
          <view class="bld__left">
            <text class="bld__name">{{ displayOr(profile.buildingName, '未分配楼栋') }}</text>
            <text class="bld__floor">{{ displayOr(profile.floor, '未设楼层') }}</text>
          </view>
          <text class="bld__status">✅ 当前服务</text>
        </view>

        <view class="note">
          <text class="note__text">
            💡 办公楼变更需运营审核（L15 刻意不接受端上改楼栋），请通过客服提交；
            同楼同事扫码时会自动绑定到你这栋。
          </text>
        </view>
      </view>

      <!-- ③ 晋升进度 -->
      <view class="card">
        <text class="card__title">📈 团长晋升进度</text>

        <view class="prog__hd">
          <text class="prog__text">
            本月 {{ rules?.mine.monthOrders ?? 0 }} 单 · 已推荐
            {{ rules?.mine.invitedFormalCount ?? 0 }} 名团长
          </text>
          <text class="prog__next">
            {{
              nextLevelLabel
                ? `下一级 ${nextLevelLabel}`
                : `已达${profile?.levelLabel ?? ''}（最高等级）`
            }}
          </text>
        </view>

        <view class="prog__bar">
          <view class="prog__bar-fill" :style="{ width: `${progressPercent}%` }" />
        </view>

        <text v-if="levelNote" class="prog__rule">⚠️ {{ levelNote }}</text>

        <text v-if="rules?.expireRule" class="prog__rule">⚠️ {{ rules.expireRule }}</text>

        <view class="pair">
          <button class="btn btn--gold" hover-class="btn--hover" @tap="goShare">
            📤 推荐新团长
          </button>
          <button class="btn btn--ghost" hover-class="btn--hover" @tap="goCommission">
            升级规则
          </button>
        </view>
      </view>

      <!-- ④ 账户设置（折叠菜单） -->
      <view class="card">
        <text class="card__title">⚙️ 账户设置</text>

        <!-- 联系方式 -->
        <view class="menu" hover-class="menu--hover" @tap="toggle('phone')">
          <text class="menu__label">📞 联系方式</text>
          <text class="menu__value">{{ maskPhone(profile.phone) }}</text>
          <text class="menu__arrow">{{ open === 'phone' ? '⌄' : '›' }}</text>
        </view>
        <view v-if="open === 'phone'" class="panel">
          <view class="field">
            <text class="field__label">新手机号</text>
            <input
              v-model="form.phone"
              class="field__input"
              type="number"
              maxlength="11"
              placeholder="不修改请留空"
              placeholder-class="field__ph"
            />
          </view>
          <view class="field">
            <text class="field__label">当前楼层 / 新楼层</text>
            <input
              v-model="form.floor"
              class="field__input"
              type="text"
              maxlength="32"
              :placeholder="`当前 ${displayOr(profile.floor, '未设置')}，不修改请留空`"
              placeholder-class="field__ph"
            />
          </view>
          <button class="btn btn--gold btn--block" hover-class="btn--hover" @tap="saveProfile">
            保存资料
          </button>
        </view>

        <!-- 提现账户 -->
        <view class="menu" hover-class="menu--hover" @tap="toggle('payout')">
          <text class="menu__label">🏦 提现账户</text>
          <text class="menu__value">
            {{ profile.payoutBound ? displayOr(profile.payoutAccount) : '未绑定' }}
          </text>
          <text class="menu__arrow">{{ open === 'payout' ? '⌄' : '›' }}</text>
        </view>
        <view v-if="open === 'payout'" class="panel">
          <view class="field">
            <text class="field__label">类型</text>
            <view class="picks">
              <view
                v-for="t in payoutTypes"
                :key="t.value"
                class="picks__item"
                :class="{ 'is-active': form.payoutType === t.value }"
                @tap="form.payoutType = t.value"
              >
                <text class="picks__label">{{ t.label }}</text>
              </view>
            </view>
          </view>

          <view class="field">
            <text class="field__label">账号</text>
            <input
              v-model="form.payoutAccount"
              class="field__input"
              type="text"
              maxlength="64"
              :placeholder="profile.payoutBound ? '重新录入完整账号' : '银行卡号 / 支付宝账号'"
              placeholder-class="field__ph"
            />
          </view>

          <view class="field">
            <text class="field__label">收款人</text>
            <input
              v-model="form.payoutName"
              class="field__input"
              type="text"
              maxlength="32"
              :placeholder="profile.payoutName || '与账号实名一致'"
              placeholder-class="field__ph"
            />
          </view>

          <text class="field__note">
            账号在服务端脱敏存储，回显为 6217****0123 形态；再次修改须完整重新录入。
          </text>

          <button class="btn btn--gold btn--block" hover-class="btn--hover" @tap="savePayout">
            保存收款方式
          </button>
        </view>

        <!-- 团长合作协议 -->
        <view class="menu" hover-class="menu--hover" @tap="toggle('agree')">
          <text class="menu__label">📄 团长合作协议</text>
          <text class="menu__value">{{ displayOr(profile.agreeVersion, '未签署') }}</text>
          <text class="menu__arrow">{{ open === 'agree' ? '⌄' : '›' }}</text>
        </view>
        <view v-if="open === 'agree'" class="panel">
          <text class="field__note"> 签署时间：{{ formatDateTime(profile.agreedAt) }} </text>
          <button class="btn btn--ghost btn--block" hover-class="btn--hover" @tap="resign">
            重新签署 v1.1
          </button>
        </view>

        <!-- 客服 -->
        <view class="menu" hover-class="menu--hover" @tap="goSupport">
          <text class="menu__label">💬 联系客服</text>
          <text class="menu__value">人工处理</text>
          <text class="menu__arrow">›</text>
        </view>

        <!-- 退出团长身份 -->
        <view class="menu menu--danger" hover-class="menu--hover" @tap="toggle('quit')">
          <text class="menu__label menu__label--danger">退出团长身份</text>
          <text class="menu__arrow">{{ open === 'quit' ? '⌄' : '›' }}</text>
        </view>
        <view v-if="open === 'quit'" class="panel panel--danger">
          <text class="field__note">
            退出后不再展示团长入口，历史佣金与订单记录仍保留，
            日后仍可重新提交申请（重新从见习等级开始）。
          </text>
          <text class="field__note">
            ⚠️ 退出前需先结清资金：可用余额与冻结额须为 ¥0.00，
            且不能有处理中的提现或待结算佣金。不满足时服务端会逐条告知原因。
          </text>

          <!-- 阻碍明细（服务端 20008 的 data.blockers，逐条引导） -->
          <view v-if="quitBlockers.length" class="blockers">
            <text class="blockers__title">暂不能退出：</text>
            <view v-for="b in quitBlockers" :key="b.code" class="blockers__item">
              <text class="blockers__dot">·</text>
              <text class="blockers__text">{{ b.text }}</text>
            </view>
            <text class="blockers__hint">
              请先在「提现」页结清余额并等待到账，或联系客服协助处理。
            </text>
          </view>

          <button
            class="btn btn--danger btn--block"
            hover-class="btn--hover"
            :disabled="quitting"
            @tap="confirmQuit"
          >
            {{ quitting ? '处理中…' : '退出团长身份' }}
          </button>
        </view>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * P20 · 团长资料（含退出团长身份）
 *
 * ⭐ 版式基准 = prototype/index.html renderP20（v4.10.0）
 *
 * 数据来源：L14 资料 / L15 修改 / L16 等级规则 / L18 协议重签 / **L20 退出**。
 *
 * ⚠️ 手机号展示用 `maskPhone` 兜一层（§1.6）：即便服务端返回明文（本人数据），
 *    端上也不在「非导出场景」展示完整号，避免截图泄露。
 * ⚠️ L15 的 DTO 刻意**不含 `buildingId`**，且服务端 `forbidNonWhitelisted: true` ——
 *    只提交发生变化的字段，不要整表回传。原型的「切换办公楼」实装为**引导到客服**
 *    （变更须运营审核），不做一个点了没用的假入口。
 * ⚠️ 收款方式 `payoutAccount` 服务端**落库前脱敏**，故回显值带 `****`，属预期；
 *    再次修改时需**完整重新录入**（脱敏值不能再作为账号提交）。
 * ⚠️ 「累计佣金」字段 `totalCommission` 是**元·字符串**（历史遗留），不是整数分，
 *    故单独走 `totalCommissionText` 加千分位；其余统计为数字。
 *
 * 【L20 退出（2026-09-15 补）】语义 = **停职保留档案**：`status` 置 2、清空
 * `ab_user.team_leader_id`，但订单/佣金/推荐关系全留，日后可重新申请。
 *   · 服务端有**资金闸门**：余额/冻结未清零、有在途提现、有待结算佣金 → `20008`，
 *     明细在 `error.payload.blockers`，本页逐条展示（不吞掉后端解释）。
 *   · 幂等键**必传**：同一个「退出意图」复用同一个 key；成功后本页清 `isLeader`
 *     并回到底部 4 项的普通用户视图。
 * ⚠️ 退出团长属人工可介入事项，本页同时提供「联系客服」入口（U17 · 客服微信号）。
 */
import { computed, reactive, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { LeaderLevel } from '@abox/shared-types';

import {
  fetchLeaderProfile,
  fetchLevelRules,
  quitLeader,
  signAgreement,
  updateLeaderProfile,
} from '@/api/leader';
import type { LevelRulesResult, LeaderProfile, PayoutType, QuitBlocker } from '@/api/leader';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useLeaderStore } from '@/stores/leader';
import { displayOr, formatDateTime, maskPhone, uuid } from '@/utils/format';
import { navigateTo, switchTab } from '@/utils/router';

const payoutTypes: Array<{ label: string; value: PayoutType }> = [
  { label: '银行卡', value: 'bank' },
  { label: '支付宝', value: 'alipay' },
];

const { run, loading } = useRequest();
const leaderStore = useLeaderStore();

const profile = ref<LeaderProfile | null>(null);
const rules = ref<LevelRulesResult | null>(null);

/** 折叠面板：同时只展开一个（原型为菜单式 list，展开态由本批补） */
const open = ref<'' | 'phone' | 'payout' | 'agree' | 'quit'>('');

const form = reactive({
  phone: '',
  floor: '',
  payoutType: 'bank' as PayoutType,
  payoutAccount: '',
  payoutName: '',
});

/**
 * ⭐ 头部等级 + 晋升进度
 *
 * 头部那个等级取 `profile.level`（L14）—— 由平台按晋级审计写入 `ab_team_leader.level`，
 * 是**实际生效等级**；「下一级 / 进度」直接取 L16 `mine.nextLevel` / `mine.progress`
 * （服务端已按**生效等级**在阶梯上推导完毕）。
 *
 * ⚠️ 契约已把「等级」拆成两个名字（缺陷 #94 · 2026-09-18 服务端改名）：
 *     · `effectiveLevel`（L11/L14 `level`、L16 `mine.effectiveLevel`）= 实际生效等级；
 *     · `derivedLevel`（L16）= **按本月业绩反推的「应处等级」**，是晋级审计的**输入**，
 *       **不是**「我的等级」（首席但本月只做 7 单 → 同时命中 `chief` 与 `trainee`）。
 *     旧出参两个端点**都叫 `level`**（同名不同义）→ 端上照抄就是「头部首席团长 +
 *     进度条见习 → 正式 23%」的同屏矛盾（本批实测踩到）。改名后误用才拦得住。
 * ⚠️ 端上**不再自建第二份推导** —— 阶梯顺序与门槛的单一真相都在服务端。
 */
const effectiveLevel = computed<LeaderLevel | null>(() => {
  const lv = profile.value?.level as LeaderLevel | undefined;
  return lv ?? null;
});
const nextLevelKey = computed<LeaderLevel | null>(() => rules.value?.mine.nextLevel ?? null);
const nextLevelLabel = computed(() => {
  const k = nextLevelKey.value;
  return k ? (rules.value?.levels.find((l) => l.key === k)?.name ?? k) : '';
});

/** 已达最高等级 → 恒 100%（原型 P20「已达首席（最高等级）」+ 满格进度条） */
const progressPercent = computed(() => {
  if (!effectiveLevel.value) return 0;
  return Math.round((rules.value?.mine.progress ?? 0) * 100);
});

/** 业绩测算等级与生效等级不一致时的如实说明（不隐藏差异，也不把它当「我的等级」） */
const levelNote = computed(() => {
  const derived = rules.value?.mine.derivedLevel;
  const cur = effectiveLevel.value;
  if (!derived || !cur || derived === cur) return '';
  return `等级由平台按业绩审核调整；本月业绩测算对应 ${
    rules.value?.levels.find((l) => l.key === derived)?.name ?? derived
  }。`;
});

/** L20 退出：提交中标记 + 服务端返回的阻碍明细 */
const quitting = ref(false);
const quitBlockers = ref<QuitBlocker[]>([]);

/** 当前「退出意图」的幂等键：失败重试沿用，成功后作废 */
let quitKey = '';

/** ⚠️ `totalCommission` 是**元·字符串**（历史遗留），加千分位单独格式化 */
const totalCommissionText = computed(() => {
  const n = Number(profile.value?.totalCommission ?? 0);
  if (!Number.isFinite(n)) return '¥0.00';
  return `¥${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
});

function toggle(key: '' | 'phone' | 'payout' | 'agree' | 'quit'): void {
  open.value = open.value === key ? '' : key;
}

async function reload(): Promise<void> {
  try {
    const [p, r] = await Promise.all([
      run(() => fetchLeaderProfile()),
      run(() => fetchLevelRules()),
    ]);
    profile.value = p;
    rules.value = r;
    form.payoutType = p.payoutType ?? 'bank';
  } catch (e) {
    toastApiError(e, '团长资料加载失败');
  }
}

/** 只提交填写了的字段（避免用空值覆盖服务端已有资料） */
async function saveProfile(): Promise<void> {
  const payload: { phone?: string; floor?: string } = {};
  if (form.phone.trim()) payload.phone = form.phone.trim();
  if (form.floor.trim()) payload.floor = form.floor.trim();

  if (!payload.phone && !payload.floor) {
    uni.showToast({ title: '请先填写要修改的内容', icon: 'none' });
    return;
  }
  if (payload.phone && !/^1[3-9]\d{9}$/.test(payload.phone)) {
    uni.showToast({ title: '手机号格式不正确', icon: 'none' });
    return;
  }

  try {
    profile.value = await run(() => updateLeaderProfile(payload));
    form.phone = '';
    form.floor = '';
    uni.showToast({ title: '已保存', icon: 'none' });
  } catch (e) {
    toastApiError(e, '保存失败');
  }
}

async function savePayout(): Promise<void> {
  const account = form.payoutAccount.trim();
  const name = form.payoutName.trim();
  if (!account || account.length < 4) {
    uni.showToast({ title: '请填写完整收款账号', icon: 'none' });
    return;
  }

  try {
    profile.value = await run(() =>
      updateLeaderProfile({
        payoutType: form.payoutType,
        payoutAccount: account,
        payoutName: name || undefined,
      }),
    );
    form.payoutAccount = '';
    form.payoutName = '';
    uni.showToast({ title: '收款方式已保存', icon: 'none' });
  } catch (e) {
    toastApiError(e, '保存失败');
  }
}

async function resign(): Promise<void> {
  try {
    await run(() => signAgreement('v1.1'));
    await reload();
    uni.showToast({ title: '已签署 v1.1', icon: 'none' });
  } catch (e) {
    toastApiError(e, '签署失败');
  }
}

/** 去客服页（U17 · 客服微信号）—— 退出/资金争议/换楼栋的人工通道 */
function goSupport(): void {
  navigateTo('/pages/support/contact');
}

/** 「切换办公楼」= 引导到客服（L15 不收 buildingId，变更须运营审核） */
function askSwitchBuilding(): void {
  uni.showModal({
    title: '切换服务办公楼',
    content: '办公楼变更需运营审核，请联系客服提交。同一栋楼只能有一名在职团长。',
    confirmText: '联系客服',
    success: (res) => {
      if (res.confirm) goSupport();
    },
  });
}

function goShare(): void {
  navigateTo('/pages/leader/share');
}

function goCommission(): void {
  navigateTo('/pages/leader/commission');
}

/**
 * L20 · 退出团长身份（二次确认 → 提交 → 清本地身份回到 4 项视图）
 *
 * 错误分支全部按「服务端说了算」处理：
 *   · `20008` → 取 `payload.blockers` 逐条展示（退出阻碍，本页就地引导）
 *   · 其余    → 走统一 toast
 */
function confirmQuit(): void {
  quitBlockers.value = [];
  uni.showModal({
    title: '确认退出团长身份？',
    content:
      '退出后底部将不再展示团长入口，你需要先在「提现」页结清全部余额。历史订单与佣金记录会保留。',
    confirmText: '确认退出',
    confirmColor: '#C44536',
    success: (res) => {
      if (res.confirm) void doQuit();
    },
  });
}

async function doQuit(): Promise<void> {
  if (quitting.value) return;
  if (!quitKey) quitKey = uuid(); // 失败沿用同一 key；服务端失败会释放占位键，可立即重试

  quitting.value = true;
  try {
    await run(() => quitLeader({ reason: '用户端主动退出' }, quitKey));
    quitKey = ''; // 成功即作废，避免下一次操作被回放成同一结果
    leaderStore.clear(); // isLeader=false → 底栏重渲染回 4 项
    uni.showToast({ title: '已退出团长身份', icon: 'none', duration: 2000 });
    setTimeout(() => switchTab('/pages/index/index'), 900);
  } catch (e) {
    if (e instanceof ApiError && e.code === 20008) {
      const payload = e.payload as { blockers?: QuitBlocker[] } | null;
      quitBlockers.value = payload?.blockers ?? [];
      uni.showToast({ title: '暂不能退出，请先看下方原因', icon: 'none', duration: 2400 });
      return;
    }
    toastApiError(e, '退出失败，请稍后重试');
  } finally {
    quitting.value = false;
  }
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

// ---- 通用卡片 ----
.card {
  margin-bottom: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &--center {
    text-align: center;
  }

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-2;
  }

  &__title {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__hd &__title {
    margin-bottom: 0;
  }

  &__link {
    font-size: $fs-caption;
    color: $c-gold;
  }
}

// ---- ① 头像卡 ----
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 144rpx;
  height: 144rpx;
  margin: 0 auto;
  background: linear-gradient(135deg, $c-gold, #b8892f);
  border-radius: 50%;

  &__icon {
    font-size: 72rpx;
  }
}

.hero {
  &__name {
    display: block;
    margin-top: $space-3;
    font-size: 40rpx;
    font-weight: bold;
    color: $c-text;
  }

  &__tags {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: $space-2;
  }

  &__tag {
    margin: 0 $space-1;
    padding: 4rpx $space-2;
    font-size: $fs-caption;
    color: $c-text;
    background: rgba(201, 168, 118, 0.24);
    border-radius: $radius-sm;

    &--gold {
      color: #ffffff;
      background: #b8892f;
    }
  }
}

.stats {
  display: flex;
  align-items: flex-end;
  margin-top: $space-4;

  &__item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  &__value {
    font-size: 38rpx;
    font-weight: bold;
    color: $c-text;
    font-variant-numeric: tabular-nums;

    &--gold {
      color: #b8892f;
    }
  }

  &__label {
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }
}

// ---- ② 服务办公楼 ----
.bld {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-2 0;

  &__left {
    flex: 1;
    min-width: 0;
  }

  &__name {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__floor {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__status {
    flex: none;
    margin-left: $space-3;
    font-size: $fs-caption;
    color: $c-success;
  }
}

.note {
  padding: $space-2 $space-3;
  background: #fbf7ee;
  border-radius: $radius-sm;

  &__text {
    font-size: 22rpx;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

// ---- ③ 晋升进度 ----
.prog {
  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__text {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__next {
    font-size: 22rpx;
    color: $c-gold;
  }

  &__bar {
    height: 12rpx;
    margin-top: $space-2;
    overflow: hidden;
    background: $c-bg;
    border-radius: $radius-pill;
  }

  &__bar-fill {
    height: 100%;
    background: linear-gradient(90deg, $c-gold, #b8892f);
    border-radius: $radius-pill;
    transition: width 0.4s ease;
  }

  &__rule {
    display: block;
    margin-top: $space-2;
    font-size: 22rpx;
    line-height: 1.6;
    color: $c-text-weak;
  }
}

// ---- ④ 账户设置菜单 ----
.menu {
  display: flex;
  align-items: center;
  padding: $space-3 0;
  border-bottom: 1px solid rgba(228, 216, 195, 0.6);

  &--hover {
    opacity: 0.82;
  }

  &--danger {
    border-bottom: none;
  }

  &__label {
    flex: 1;
    font-size: $fs-body;
    color: $c-text;

    &--danger {
      color: $c-warning;
    }
  }

  &__value {
    flex: none;
    margin-right: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__arrow {
    flex: none;
    font-size: 28rpx;
    color: $c-text-weak;
  }
}

.panel {
  padding: $space-3 0 $space-1;
  border-bottom: 1px solid rgba(228, 216, 195, 0.6);

  &--danger {
    border-bottom: none;
  }
}

.field {
  margin-bottom: $space-3;

  &__label {
    display: block;
    margin-bottom: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__input {
    width: 100%;
    height: 72rpx;
    padding: 0 $space-3;
    font-size: $fs-caption;
    color: $c-text;
    background: $c-bg;
    border-radius: $radius-md;
    box-sizing: border-box;
  }

  &__ph {
    color: $c-text-weak;
  }

  &__note {
    display: block;
    margin-bottom: $space-3;
    font-size: 22rpx;
    line-height: 1.7;
    color: $c-text-weak;
  }
}

.picks {
  display: flex;

  &__item {
    padding: $space-2 $space-4;
    margin-right: $space-2;
    border: 1px solid $c-border;
    border-radius: $radius-pill;

    &.is-active {
      background: $c-text;
      border-color: $c-text;
    }
  }

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__item.is-active &__label {
    color: $c-surface;
  }
}

.blockers {
  margin-bottom: $space-3;
  padding: $space-3;
  background: rgba(196, 69, 54, 0.06);
  border-radius: $radius-md;

  &__title {
    display: block;
    margin-bottom: $space-1;
    font-size: $fs-caption;
    font-weight: bold;
    color: $c-warning;
  }

  &__item {
    display: flex;
    align-items: flex-start;
  }

  &__dot {
    flex: none;
    margin-right: $space-1;
    font-size: $fs-caption;
    color: $c-warning;
  }

  &__text {
    flex: 1;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text;
  }

  &__hint {
    display: block;
    margin-top: $space-2;
    font-size: 22rpx;
    line-height: 1.6;
    color: $c-text-weak;
  }
}

// ---- 按钮 ----
.pair {
  display: flex;
  margin-top: $space-3;
}

.btn {
  flex: 1;
  height: 76rpx;
  line-height: 76rpx;
  font-size: $fs-caption;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.88;
  }

  &--block {
    display: block;
  }

  &--gold {
    color: #ffffff;
    font-weight: bold;
    background: linear-gradient(135deg, $c-gold, #b8892f);
    border: none;
  }

  &--ghost {
    color: $c-text;
    background: $c-surface;
    border: 1px solid $c-border;

    & + & {
      margin-left: $space-2;
    }
  }

  &--danger {
    color: $c-warning;
    background: rgba(196, 69, 54, 0.06);
    border: 1px solid rgba(196, 69, 54, 0.4);
  }

  &[disabled] {
    opacity: 0.45;
  }
}
</style>
