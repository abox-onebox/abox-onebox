<template>
  <view class="page">
    <ab-loading v-if="loading && !contact" text="正在加载客服信息" />

    <ab-empty-state
      v-else-if="!contact"
      text="客服信息加载失败"
      hint="请稍后重试"
      illustration="warn-tri"
      action-text="重试"
      @action="reload"
    />

    <template v-else>
      <view class="hero">
        <text class="hero__title">联系客服</text>
        <text class="hero__sub">{{ heroSub }}</text>
      </view>

      <!-- 主通道：按 `csMode` 分流（三档是降级关系，越往下越兜底） -->
      <view class="card card--center">
        <text class="card__label">{{ primaryLabel }}</text>
        <text v-if="orderNo" class="ctx">当前订单 {{ orderNo }}</text>

        <!-- ① 微信客服：由 JS 在用户手势内唤起（客服在企业微信里接） -->
        <button
          v-if="csMode === 'wechat_kf'"
          class="btn"
          hover-class="btn--hover"
          @tap="onPrimaryTap"
        >
          {{ actionLabel }}
        </button>

        <!-- ② 小程序原生客服消息：⚠️ 只能由真实按钮触发，无法用 JS 调起 -->
        <button
          v-else-if="isContactButton"
          class="btn"
          hover-class="btn--hover"
          open-type="contact"
          :session-from="sessionFrom"
        >
          {{ actionLabel }}
        </button>

        <!-- ③ 兜底：复制微信号人工加好友 -->
        <button v-else class="btn" hover-class="btn--hover" @tap="onPrimaryTap">
          {{ actionLabel }}
        </button>

        <text class="hint">{{ primaryHint }}</text>
      </view>

      <!-- 兜底区：在线客服档位下默认折叠；`none` 或唤起失败时展开 -->
      <view class="card">
        <view class="fold" @tap="toggleFallback">
          <text class="fold__t">{{ showFallback ? '收起其他联系方式' : '其他联系方式' }}</text>
          <text class="fold__i">{{ showFallback ? '−' : '+' }}</text>
        </view>

        <template v-if="showFallback">
          <view class="wxrow">
            <text class="card__label">客服微信号</text>
            <text class="wxid wxid--sm">{{ contact.wechatId }}</text>
            <button class="btn btn--ghost" hover-class="btn--hover" @tap="copyWechat">
              复制微信号
            </button>
          </view>

          <view v-if="contact.wechatQrcodeUrl" class="qr">
            <image class="qr__img" :src="contact.wechatQrcodeUrl" mode="aspectFit" />
            <text class="qr__hint">也可长按识别二维码添加</text>
          </view>
        </template>
      </view>

      <!-- 服务时间与提示 -->
      <view class="card">
        <view class="row">
          <text class="row__k">服务时间</text>
          <text class="row__v">{{ contact.hours }}</text>
        </view>
        <view v-if="contact.phone" class="row">
          <text class="row__k">客服电话</text>
          <text class="row__v">{{ contact.phone }}</text>
        </view>
        <text class="note">{{ contact.tips }}</text>
      </view>

      <!-- 常见问题：都指向同一条人工通道，避免用户四处找入口 -->
      <view class="card">
        <text class="card__label">这些问题请找客服</text>
        <view v-for="item in faqs" :key="item" class="faq">
          <text class="faq__dot">·</text>
          <text class="faq__text">{{ item }}</text>
        </view>
      </view>

      <text class="foot">
        我们是人工客服（不是机器人）：请直接说明遇到的问题（附上订单号或截图），
        会尽快为你处理，不需要重复发送。
      </text>
    </template>
  </view>
</template>

<script setup lang="ts">
/**
 * 联系客服（U17 · 在线客服 + 人工兜底）
 *
 * ⚠️ 本页**不占用产品页面清单的 P 编号**（P1–P20 为小程序页面、P21+ 属供应商/后台 Web），
 *    它是「联系运营 / 联系客服」类入口的**统一落地页**：全站 5 处入口都跳到这里。
 *
 * 数据来源：U17 `GET /me/support`。
 *
 * ## 主按钮按 `csMode` 三档分流（2026-10-04 定为终态 = `wechat_kf`）
 * | 档位 | 渲染 | 触发方式 |
 * |---|---|---|
 * | `wechat_kf` | 普通 button | JS 调 `wx.openCustomerServiceChat`（客服在**企业微信**接） |
 * | `contact`   | `<button open-type="contact">` | ⚠️ **只能由真实按钮点击触发**，JS 调不起来 |
 * | `none`      | 普通 button | 复制微信号（兜底） |
 *
 * ⭐ **三档是降级关系，不是并列功能**：`wechat_kf` 唤不起会话（未开通 / 企业 ID 与主体不一致 /
 *    开发者工具里不生效）时**必须自动展开兜底区**，绝不让用户点到一个没反应的按钮。
 *
 * ⚠️ 微信号 / 电话 / 服务时间 / 提示文案 / 客服账号**全部由服务端下发**（`ab_config.service.*`）；
 *    端上不硬编码任何联系方式，换号或换客服账号只需运营改配置。
 * ⚠️ `contact.wechatQrcodeUrl` 为空时**整块隐藏**（不占位、不伪造二维码图）。
 * ⚠️ 本页登录即可访问，**不要求团长身份** —— 已退出团长的用户同样需要这条通道。
 * ⚠️ 可带 `orderNo` 进入（订单详情页「咨询这一单」），客服端会收到带订单的卡片。
 */
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';

import { CustomerServiceMode } from '@abox/shared-types';

import { fetchSupportContact } from '@/api/support';
import type { SupportContact } from '@/api/support';
import {
  buildSessionFrom,
  csActionLabel,
  openCustomerServiceChat,
} from '@/composables/use-customer-service';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useUserStore } from '@/stores/user';

/** 常见问题清单（文案端上固定；答案统一为「联系客服」） */
const faqs = [
  '退出团长身份（需先结清余额与在途提现）',
  '佣金提现异常 / 到账金额不符',
  '截单后的退款与代退进度',
  '发票、团长合作协议与资质相关',
];

const { run, loading } = useRequest();
const contact = ref<SupportContact | null>(null);

/** 订单详情页可带 `orderNo` 进来，让客服一眼看到是哪一单 */
const orderNo = ref('');
/** 在线客服唤起失败后置 true —— 兜底区从折叠变展开（不让用户卡在死路上） */
const fallbackOpen = ref(false);

const userStore = useUserStore();

const csMode = computed(() => contact.value?.csMode ?? CustomerServiceMode.NONE);
const actionLabel = computed(() =>
  csActionLabel(contact.value?.csMode ?? CustomerServiceMode.NONE),
);
/** 微信客服可用 = 模式对 + 服务端两个参数都给到了（缺一即视为没配好，走降级） */
const canOpenKf = computed(
  () => csMode.value === 'wechat_kf' && !!contact.value?.csCorpId && !!contact.value?.csUrl,
);
/** `contact` 模式只能由真实按钮触发，所以模板里要渲染一个 open-type 的 button */
const isContactButton = computed(() => csMode.value === 'contact');
const sessionFrom = computed(() =>
  buildSessionFrom(orderNo.value || undefined, userStore.info?.id),
);

/** 兜底区是否展开：`none` 档它就是主通道，其余档位只有失败后才展开 */
const showFallback = computed(() => csMode.value === 'none' || fallbackOpen.value);

const heroSub = computed(() => {
  if (csMode.value === 'wechat_kf') return '人工处理 · 在线对话，无需加好友';
  if (csMode.value === 'contact') return '人工处理 · 在线对话，无需加好友';
  return '人工处理 · 添加客服微信即可';
});

const primaryLabel = computed(() => {
  if (csMode.value !== 'none') return '在线客服';
  return '客服微信号';
});

const primaryHint = computed(() => {
  if (csMode.value === 'wechat_kf')
    return '点上方按钮进入客服会话，我们会看到你的用户编号与订单信息（无需加好友）。';
  if (csMode.value === 'contact') return '点上方按钮进入客服会话，直接说明遇到的问题即可。';
  return '打开微信 → 点右上角「+」→ 添加朋友 → 粘贴搜索，即可添加客服。';
});

function toggleFallback(): void {
  fallbackOpen.value = !fallbackOpen.value;
}

async function reload(): Promise<void> {
  try {
    contact.value = await run(() => fetchSupportContact());
  } catch (e) {
    toastApiError(e, '客服信息加载失败');
  }
}

/** 主按钮：按模式分流；`wechat_kf` 唤起失败 → 提示并展开兜底区 */
async function onPrimaryTap(): Promise<void> {
  if (!contact.value) return;

  if (csMode.value === 'wechat_kf') {
    if (!canOpenKf.value) {
      fallbackOpen.value = true;
      uni.showToast({ title: '在线客服未配置完成，可先复制微信号', icon: 'none', duration: 2400 });
      return;
    }
    const res = await openCustomerServiceChat({
      corpId: contact.value.csCorpId as string,
      url: contact.value.csUrl as string,
      orderNo: orderNo.value || undefined,
      userId: userStore.info?.id,
    });
    if (res.ok) return;
    // 唤不起来（未开通 / 企业 ID 与主体不一致 / 真机以外环境）→ 退回人工通道
    fallbackOpen.value = true;
    uni.showToast({ title: '在线客服暂时不可用，可先复制微信号', icon: 'none', duration: 2400 });
    return;
  }

  copyWechat();
}

function copyWechat(): void {
  if (!contact.value) return;
  uni.setClipboardData({
    data: contact.value.wechatId,
    success: () => {
      uni.showToast({ title: '微信号已复制，去微信添加', icon: 'none', duration: 2200 });
    },
  });
}

onLoad((options?: Record<string, string>) => {
  if (options?.orderNo) orderNo.value = options.orderNo;
});

onShow(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-4 $space-4 120rpx;
  box-sizing: border-box;
}

.hero {
  padding: $space-3 $space-1 $space-5;

  &__title {
    display: block;
    font-size: $fs-h1;
    font-weight: 600;
    color: $c-text;
  }

  &__sub {
    display: block;
    margin-top: $space-3;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.card {
  margin-bottom: $space-4;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &--center {
    text-align: center;
  }

  &__label {
    display: block;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.wxid {
  display: block;
  margin: $space-3 0 $space-4;
  font-size: $fs-display;
  font-weight: 600;
  letter-spacing: 2rpx;
  color: $c-gold-fg;
  word-break: break-all;

  /** 折叠区里不再当主视觉，降一档 */
  &--sm {
    margin: $space-2 0 $space-3;
    font-size: $fs-body;
  }
}

/** 从订单详情页带进来的上下文（让客服一眼知道在说哪一单） */
.ctx {
  display: block;
  margin-top: $space-2;
  font-size: $fs-caption;
  color: $c-text-weak;
}

.wxrow {
  margin-top: $space-3;
  text-align: center;
}

.fold {
  display: flex;
  align-items: center;
  justify-content: space-between;

  &__t {
    font-size: $fs-caption;
    color: $c-text;
  }

  &__i {
    font-size: $fs-body;
    color: $c-text-weak;
  }
}

.hint {
  display: block;
  margin-top: $space-3;
  font-size: $fs-caption;
  line-height: 1.7;
  color: $c-text-weak;
}

.qr {
  margin-top: $space-4;
  padding-top: $space-4;
  border-top: 1px solid rgba(228, 216, 195, 0.6);

  &__img {
    width: 320rpx;
    height: 320rpx;
    background: $c-bg;
    border-radius: $radius-sm;
  }

  &__hint {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: $space-2 0;

  &__k {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__v {
    font-size: $fs-caption;
    color: $c-text;
  }
}

.note {
  display: block;
  margin-top: $space-3;
  padding-top: $space-3;
  font-size: $fs-caption;
  line-height: 1.7;
  color: $c-text-weak;
  border-top: 1px solid rgba(228, 216, 195, 0.6);
}

.faq {
  display: flex;
  margin-top: $space-2;

  &__dot {
    flex: none;
    margin-right: $space-2;
    font-size: $fs-caption;
    color: $c-gold-fg;
  }

  &__text {
    flex: 1;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text;
  }
}

.foot {
  display: block;
  padding: 0 $space-1;
  font-size: $fs-caption;
  line-height: 1.8;
  color: $c-text-weak;
}

.btn {
  width: 100%;
  height: 80rpx;
  font-size: $fs-caption;
  line-height: 80rpx;
  color: $c-surface;
  background: $c-text;
  border-radius: $radius-pill;

  &::after {
    border: none;
  }

  &--hover {
    opacity: 0.85;
  }

  /** 次要动作（兜底区里的复制） */
  &--ghost {
    color: $c-text;
    background: transparent;
    border: 1px solid $c-border;
  }
}
</style>
