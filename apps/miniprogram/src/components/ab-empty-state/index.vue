<template>
  <view class="ab-empty-state">
    <text v-if="illustration" class="abi abi-deco-34 ab-empty-state__ico">{{
      I[illustration]
    }}</text>
    <text class="ab-empty-state__text">{{ text }}</text>
    <text v-if="hint" class="ab-empty-state__hint">{{ hint }}</text>
    <button
      v-if="actionText"
      class="ab-empty-state__action"
      hover-class="ab-empty-state__action--hover"
      @tap="emit('action')"
    >
      {{ actionText }}
    </button>
  </view>
</template>

<script setup lang="ts">
/**
 * ab-empty-state —— 空状态（列表无数据、未绑定楼群、已截单等）
 *
 * 规格来源 =《设计系统 v2.1》§八「空状态」：**装饰插图 34px + 一句说明；不使用 emoji**。
 *
 * ⚠️ 插图为「装饰性插图」，走**独立通道**（规格 §五：14 / 28 / 34 / 40px），
 *    **不受**功能图标三档（16 / 20 / 24）约束 —— 两者登记在同一处的话，
 *    「尺寸锁三档」这条规则就名存实亡。
 *
 * ⚠️ 渲染写法必须是 `<text class="abi abi-deco-34">{{ I[名字] }}</text>`：
 *    ① `<text>` 不能内嵌自定义组件（会被渲染层静默丢弃），故图标只能走「字符 + class 约定」；
 *    ② **尺寸只允许有 `abi-deco-34` 这一份表述** —— 早先这里另写了一句 `font-size: 68rpx`，
 *       而 `scripts/check-icon-lock.mjs` 是按「档位 class」取数的：那份自写数值既让档位
 *       形同虚设（改档位类不会改到它），又让本文件对门禁**不可见**（判据数的是 `{{ I… }}`）。
 *       同理，取值一律经别名 `I[...]`，不得直取 `ABOX_ICON_CHARS[...]`（门禁 ②-c 会报）。
 *
 * ⚠️ 组件内不引 `vue` 的 `computed`：不要在这里把字符算出来再 `{{ ico }}`——
 *    那种写法逃得过本门禁的「被档位 class 包裹的 `{{ I… }}`」判据（同上 ②）。
 *
 * 配色判据（`_tmp/icons/s6-contrast.py`）：插图 `$c-gold-deep #936f3a`
 *    压卡片面 4.51 / 压米色底 4.05 —— 二者均 ≥ 3.0（WCAG 1.4.11 非文本对比）✅
 */
import { ABOX_ICON_CHARS as I, type AboxIconName } from '@abox/shared-utils';

withDefaults(
  defineProps<{
    /** 主文案 */
    text: string;
    /** 次级说明 */
    hint?: string;
    /** 操作按钮文案（不传则不渲染按钮） */
    actionText?: string;
    /**
     * 装饰插图（语义名，34px）。
     * ⚠️ 默认值刻意留 `undefined`：20 处空状态各有语义（加载失败 / 无订单 / 无佣金 / 找不到订单），
     *    配同一张图会变成千篇一律的模板味 ⇒ 一律由调用点显式标注。
     *    （写 `undefined` 只是为满足 lint 的 `vue/require-default-prop`，语义上仍是「必须显式传」。）
     */
    illustration?: AboxIconName;
  }>(),
  { hint: '', actionText: '', illustration: undefined },
);

const emit = defineEmits<{ action: [] }>();
</script>

<style lang="scss" scoped>
.ab-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 120rpx $space-5;

  // 装饰插图 34px（= 68rpx）· 尺寸由全局 `.abi-deco-34` 承载（唯一表述，勿在此另写 font-size）
  // 颜色与间距是本组件私有语义，留在组件内
  &__ico {
    color: $c-gold-deep;
    margin-bottom: $space-3;
  }

  &__text {
    font-size: $fs-body;
    color: $c-text;
  }

  &__hint {
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
    text-align: center;
  }

  &__action {
    margin-top: $space-5;
    padding: 0 $space-5;
    height: 72rpx;
    font-size: $fs-body;
    line-height: 72rpx;
    color: $c-surface;
    background: $c-text;
    border-radius: $radius-pill;

    &::after {
      border: none;
    }

    &--hover {
      opacity: 0.85;
    }
  }
}
</style>
