<template>
  <view class="page">
    <!-- ① 已注销：终态屏。⚠️ 刻意**不给任何跳转按钮** —— 见 script 段头注「为什么终态屏里没有返回」 -->
    <template v-if="done">
      <view class="hero hero--done">
        <text class="hero__title">账号已注销</text>
        <text class="hero__desc">{{ doneNote }}</text>
      </view>

      <view class="section">
        <view class="section__hd">
          <text class="section__title">如需恢复</text>
        </view>
        <view class="card">
          <view class="card__row">
            <text class="card__label"
              ><text class="abi abi-16">{{ I.phone }}</text> 客服微信号</text
            >
            <text class="card__value card__value--link" @tap="copyWechat">
              {{ wechatId || '见客服页' }}
            </text>
          </view>
          <view class="card__row">
            <text class="card__label">服务时间</text>
            <text class="card__value">{{ supportHours || '工作日 9:00 – 18:00' }}</text>
          </view>
        </view>
        <text class="hint">点客服微信号可复制。注销后本小程序将无法再为你登录。</text>
      </view>
    </template>

    <!-- ② 正常态：后果告知 → 打确认词 → 勾选 → 提交 -->
    <template v-else>
      <view class="hero hero--warn">
        <text class="hero__title"
          ><text class="abi abi-16">{{ I.alert }}</text> 注销账号</text
        >
        <text class="hero__desc">注销不可恢复，请确认你已了解下列后果后再操作。</text>
      </view>

      <view class="section">
        <view class="section__hd">
          <text class="section__title">注销会发生什么</text>
        </view>
        <view class="card card--list">
          <view v-for="(c, i) in CONSEQUENCES" :key="`c${i}`" class="cons">
            <text class="cons__mark">·</text>
            <text class="cons__text">{{ c }}</text>
          </view>
        </view>
      </view>

      <!-- 服务端闸门：一次列出全部「为什么现在不能注销」 -->
      <view v-if="blockedMsg" class="block">
        <text class="block__title"
          ><text class="abi abi-16">{{ I.alert }}</text> 现在还不能注销</text
        >
        <text class="block__text">{{ blockedMsg }}</text>
        <text class="block__hint">处理完上面的事项后回到本页重试即可。</text>
      </view>

      <view class="section">
        <view class="section__hd">
          <text class="section__title">确认操作</text>
        </view>

        <view class="card">
          <text class="card__label">请输入「{{ CONFIRM_TEXT }}」四个字以确认</text>
          <input
            v-model="confirmText"
            class="confirm__input"
            type="text"
            :maxlength="20"
            :placeholder="CONFIRM_TEXT"
            placeholder-class="confirm__ph"
          />
          <text class="card__label">注销原因（选填，仅供客服在恢复时参考）</text>
          <input
            v-model="reason"
            class="confirm__input"
            type="text"
            :maxlength="50"
            placeholder="例如：换用其他小程序"
            placeholder-class="confirm__ph"
          />
          <view class="agree" hover-class="agree--hover" @tap="agreed = !agreed">
            <view class="agree__box">
              <text class="abi abi-16" :class="{ 'agree__tick--on': agreed }">{{ I.check }}</text>
            </view>
            <text class="agree__text">我已阅读并了解上述后果，确认注销本账号</text>
          </view>
        </view>
      </view>

      <view class="actions">
        <button
          class="btn btn--danger"
          hover-class="btn--hover"
          :disabled="!canSubmit || submitting"
          @tap="submit"
        >
          {{ submitting ? '正在注销…' : '确认注销' }}
        </button>
        <button class="btn btn--ghost" hover-class="btn--hover" @tap="goBack">暂不注销</button>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * U19 · 账号注销（M5-20 · **提审硬条件**）
 *
 * ## 为什么这一页必须存在
 *
 * 微信小程序提审要求「提供账号注销入口」（《提审自检清单 v1.2》第 10 条
 * 「缺失不通过」）。它与 U16 协议阅读页（M5-18）是**同一对提审阻塞项**：
 * 协议页已收口，本项此前只有协议正文里一句「可通过我的 → 客服微信号申请注销」。
 *
 * ## 三条端上纪律
 *
 * | 纪律 | 为什么 |
 * |------|--------|
 * | **入口在「我的 → 设置」里**（与协议页并列） | 提审要点是「**找得到**」。放在设置弹窗里，与《用户协议》《隐私政策》同一区，是行业通行位置 |
 * | **确认词必须用户手打**（不是点一个「我同意」） | 注销不可逆。服务端只认 `confirmText === '注销账号'`（逐字），端上**不得**在点击回调里写死这个值 |
 * | **闸门一律以服务端为准** | 端上不自己判「有没有余额 / 有没有在途订单」—— 那是第二份口径。服务端返回 `20015` 时把它的 `message` 原样呈现，`data.reasons` 只用于埋点 |
 *
 * ## ⚠️ 为什么终态屏里**没有「返回 / 回首页」按钮**
 *
 * 注销成功即清本地登录态；此时**任何页面**再发请求都会走 `ensureLogin()`
 * → 登录被服务端拦 `20014`（该账号已注销）→ 弹一个错误提示。
 * 一个「已注销」的终态屏上出现报错，用户会以为**注销失败**了。
 * 故终态屏只做两件事：**说清后果** + **给出恢复通道（客服微信号，注销前已预取）**，
 * 并明确告知可以关闭小程序。这与线下窗口「办完就出」的收尾是一致的。
 *
 * ⚠️ 反过来也如实说明：**注销后重新进入小程序**，端上会因登录被拦而提示
 *    「该账号已注销，如需恢复请联系客服」——**这是预期行为**，不是白屏故障。
 *
 * ## 数据来源
 *
 * | 展示项 | 来源 |
 * |--------|------|
 * | 注销结果口径说明（`note`） | **服务端** `POST /me/cancel` 出参（端上不复制文案） |
 * | 被拒原因 | **服务端** `20015` 的 `message`（附 `data.reasons` 键） |
 * | 客服微信号 / 服务时间 | U17 `GET /me/support`（**注销前预取并缓存** —— 注销后就取不到了） |
 * | 「注销会发生什么」四条 | **界面文案**（不是数据）；与后端 `UserService` 的清理字段一一对应，改字段必须同步这里 |
 */
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { ApiError, CODE_ACCOUNT_CANCELED, CODE_ACCOUNT_CANCEL_BLOCKED } from '@/api/request';
import { ACCOUNT_CANCEL_CONFIRM_TEXT, cancelAccount } from '@/api/user';
import { fetchSupportContact } from '@/api/support';
import { apiErrorMessage, toastApiError, useRequest } from '@/composables/use-request';
import { useUserStore } from '@/stores/user';
import { useLeaderStore } from '@/stores/leader';
import { clearAuthStorage } from '@/utils/storage';
import { navigateBack } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const { run } = useRequest();

const CONFIRM_TEXT = ACCOUNT_CANCEL_CONFIRM_TEXT;

/**
 * 「注销会发生什么」——**界面文案**
 *
 * ⚠️ 这四条与后端 `UserService.cancelAccount` 实际做的事必须一一对应
 *    （置 `status=3` / 匿名化 7 个字段 / 保留 `openid` 以便拦住再登录 /
 *     订单与资金记录依法保留）。后端改了清理范围而这里没改，
 *    就是在**对用户说假话** —— 这类不一致没有任何机器门禁能发现。
 */
const CONSEQUENCES = [
  '同一微信号将无法再登录本小程序（旧会话在有效期内仍可能继续，重新登录即被拦下）',
  '个人资料将被匿名化：昵称、头像、手机号、所属办公楼与团长绑定都会被清空',
  '账户余额与未完成订单必须先结清：有余额、冻结额或未完成订单时，注销会被拒绝',
  '与订单、退款、佣金相关的交易记录按法律法规要求保留，不随注销删除',
];

const confirmText = ref('');
const reason = ref('');
const agreed = ref(false);
const submitting = ref(false);
const done = ref(false);
const doneNote = ref('');
const blockedMsg = ref('');
const wechatId = ref('');
const supportHours = ref('');

const canSubmit = computed(() => agreed.value && confirmText.value.trim() === CONFIRM_TEXT);

/** 预取客服配置（best-effort）：注销后本地登录态已清，届时就取不到了 */
async function preloadSupport(): Promise<void> {
  try {
    const c = await run(() => fetchSupportContact());
    wechatId.value = c.wechatId;
    supportHours.value = c.hours;
  } catch {
    // 取不到不阻断注销 —— 终态屏会退回「见客服页」这句文案
  }
}

async function submit(): Promise<void> {
  if (submitting.value || !canSubmit.value) return;
  submitting.value = true;
  blockedMsg.value = '';
  try {
    const res = await run(() =>
      cancelAccount({
        confirmText: confirmText.value.trim(),
        ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
      }),
    );
    doneNote.value = res.note;
    done.value = true;
    // 注销即登出：**先切终态再清态**，避免清态引发的任何重登尝试抢在前面
    clearAuthStorage();
    useUserStore().clear();
    useLeaderStore().clear();
  } catch (e) {
    if (e instanceof ApiError && e.code === CODE_ACCOUNT_CANCELED) {
      // 20014：早就注销过了 ⇒ 同样进终态（**不做静默幂等**的服务端语义见 U19 头注）
      doneNote.value = apiErrorMessage(e);
      done.value = true;
      clearAuthStorage();
      useUserStore().clear();
      useLeaderStore().clear();
      return;
    }
    if (e instanceof ApiError && e.code === CODE_ACCOUNT_CANCEL_BLOCKED) {
      // 20015：把服务端给的原因**原样**呈现（端上不重写一份文案）
      blockedMsg.value = apiErrorMessage(e, '存在未结清事项，暂不能注销');
      return;
    }
    toastApiError(e);
  } finally {
    submitting.value = false;
  }
}

function copyWechat(): void {
  if (!wechatId.value) return;
  uni.setClipboardData({
    data: wechatId.value,
    success: () => uni.showToast({ title: '客服微信号已复制', icon: 'none', duration: 2000 }),
  });
}

function goBack(): void {
  navigateBack();
}

onLoad(() => {
  uni.setNavigationBarTitle({ title: '账号注销' });
  void preloadSupport();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 200rpx;
  box-sizing: border-box;
}

.hero {
  padding: $space-5 0 $space-3;

  &__title {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__desc {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }

  &--warn &__title {
    color: $c-warn-fg;
  }
}

.section {
  margin-top: $space-4;

  &__hd {
    margin-bottom: $space-3;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }
}

.card {
  padding: $space-2 $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: $space-3 0;
    border-bottom: 1px solid rgba(228, 216, 195, 0.5);

    &:last-child {
      border-bottom: none;
    }
  }

  &__label {
    display: block;
    margin: $space-3 0 $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__value {
    font-size: $fs-caption;
    color: $c-text;

    &--link {
      color: $c-info-fg; // 文字位一律走加强档（原色只作图标/描边）
    }
  }
}

.cons {
  display: flex;
  padding: $space-2 0;

  &__mark {
    flex: none;
    width: 32rpx;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-gold-fg;
  }

  &__text {
    flex: 1;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text;
  }
}

.block {
  margin-top: $space-4;
  padding: $space-3 $space-4;
  background: $c-surface;
  border-left: 4rpx solid $c-warning;
  border-radius: $radius-sm;

  &__title {
    display: block;
    font-size: $fs-caption;
    font-weight: 600;
    color: $c-warn-fg;
  }

  &__text {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text;
  }

  &__hint {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.confirm {
  &__input {
    height: 80rpx;
    padding: 0 $space-3;
    font-size: $fs-body;
    color: $c-text;
    background: $c-bg;
    border: 1px solid $c-border;
    border-radius: $radius-sm;
  }

  &__ph {
    color: $c-text-weak;
  }
}

.agree {
  display: flex;
  align-items: center;
  margin-top: $space-4;

  &--hover {
    opacity: 0.7;
  }

  &__box {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 40rpx;
    height: 40rpx;
    margin-right: $space-2;
    color: transparent; // 未勾选 = 空框（图标字符透明但仍占位，勾选态只换颜色）
    border: 1px solid $c-border;
    border-radius: $radius-sm;
  }

  &__tick--on {
    color: $c-text;
  }

  &__text {
    flex: 1;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text;
  }
}

.hint {
  display: block;
  margin-top: $space-3;
  font-size: $fs-caption;
  line-height: 1.7;
  color: $c-text-weak;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  margin-top: $space-5;
}

.btn {
  height: 80rpx;
  font-size: $fs-body;
  line-height: 80rpx;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--danger {
    color: $c-surface;
    background: $c-warning;

    &[disabled] {
      color: $c-text-weak;
      background: $c-border;
    }
  }

  &--ghost {
    color: $c-text;
    background: transparent;
    border: 1px solid $c-text;
  }

  &--hover {
    opacity: 0.85;
  }
}
</style>
