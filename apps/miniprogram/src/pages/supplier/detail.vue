<template>
  <view class="page">
    <ab-loading v-if="loading && !data" text="正在取证照信息" />

    <template v-else-if="data">
      <view class="hd">
        <text class="hd__name">{{ data.name }}</text>
        <text v-if="data.category" class="hd__cat">{{ data.category }}</text>
      </view>

      <!-- 说明（服务端生成；无资质时它会说明「是哪一种事实」而不是留白） -->
      <view class="note" :class="{ 'note--off': !data.serving }">
        <text class="abi abi-16 note__icon">{{ I.shield }}</text>
        <text class="note__text">{{ data.note }}</text>
      </view>

      <!-- 证照逐条 -->
      <view v-if="data.entries.length" class="card">
        <text class="card__title">在册证照</text>
        <view v-for="e in data.entries" :key="e.key" class="lic">
          <view class="lic__hd">
            <text class="lic__label">{{ e.label }}</text>
            <text class="lic__ok">
              <text class="abi abi-16">{{ I.check }}</text>
            </text>
          </view>
          <text v-if="e.code" class="lic__code">编号 {{ e.code }}</text>
          <text v-if="e.expireAt" class="lic__expire">有效期至 {{ e.expireAt }}</text>
        </view>
      </view>

      <!-- 在册菜品（规模陈述，不是菜单） -->
      <view v-if="data.dishes.length" class="card">
        <text class="card__title">在册菜品</text>
        <view class="dishes">
          <text v-for="(d, i) in data.dishes" :key="`${d}-${i}`" class="dishes__tag">
            {{ d }}
          </text>
        </view>
      </view>

      <text class="page__ft">
        证照编号可至国家企业信用信息公示系统核对；本页不提供任何跳转与复制入口。
      </text>
    </template>

    <ab-empty-state
      v-else
      :text="emptyText"
      :hint="emptyHint"
      illustration="search"
      action-text="重新加载"
      @action="load"
    />
  </view>
</template>

<script setup lang="ts">
/**
 * 供应商资质墙 · 详情（2026-10-03 新增）
 *
 * ## 展示什么
 * 证照名称 / 编号 / 有效期，以及在册菜品。就这些。
 *
 * ## ⚠️ 刻意不做什么（改版时勿加回来）
 *   ① **没有跳转**：不出现任何第三方平台名与入口（5.10 互推 → 下架；
 *      5.20 / 5.15.4 / 5.16 亦禁止以剪切板方式诱导跳转 APP）。
 *   ② **没有复制**：证照编号是**纯文本展示**，不给复制按钮、不调 `setClipboardData`。
 *      往剪贴板写东西正是 5.15.4 盯的形态，而用户核对编号并不需要复制。
 *   ③ **不展示环境照片**：一期没有证照图片与环境照的落库列（零 DDL），
 *      有列之后由本页扩展，不在此处伪造占位图。
 *
 * ## 为什么不在供时也要进得来
 * 列表的「暂未供应」组是可点的：用户点了却看到一个 404 式的空白页，只会以为坏了。
 * 进来后由服务端下发的 `note` 说明具体是「核验中」还是「已过期」——
 * 这两种事实不能合成为一句「暂无资质」。
 */
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import type { SupplierQualificationDetail } from '@abox/shared-types';

import { fetchSupplierQualification } from '@/api/traceability';
import { ApiError } from '@/api/request';
import { toastApiError, useRequest } from '@/composables/use-request';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const { run, loading } = useRequest();

const data = ref<SupplierQualificationDetail | null>(null);
const loadError = ref<ApiError | null>(null);
const supplierId = ref<number | null>(null);

const emptyText = computed(() => (supplierId.value ? '取不到该出品方的证照' : '缺少出品方编号'));
const emptyHint = computed(() => loadError.value?.message ?? '请返回列表重新选择一家出品方');

async function load(): Promise<void> {
  const id = supplierId.value;
  if (!id) return;
  try {
    data.value = await run(() => fetchSupplierQualification(id));
    loadError.value = null;
  } catch (e) {
    loadError.value = e instanceof ApiError ? e : null;
    toastApiError(e);
  }
}

onLoad((query) => {
  const id = Number(query?.id);
  supplierId.value = Number.isFinite(id) && id > 0 ? id : null;
  void load();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding-bottom: $space-5;
  box-sizing: border-box;

  &__ft {
    display: block;
    margin: $space-4 $space-4 0;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
    text-align: center;
  }
}

.hd {
  display: flex;
  align-items: center;
  padding: $space-4 $space-4 0;

  &__name {
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__cat {
    margin-left: $space-2;
    padding: 2rpx $space-1;
    font-size: $fs-caption;
    color: #ffffff;
    background: $c-gold;
    border-radius: $radius-sm;
  }
}

.note {
  display: flex;
  align-items: flex-start;
  margin: $space-3 $space-4 0;
  padding: $space-3;
  background: linear-gradient(135deg, $c-trace-card-from, $c-trace-card-to);
  border: 1px solid $c-gold;
  border-radius: $radius-md;

  &__icon {
    flex: none;
    line-height: 1;
  }

  &__text {
    flex: 1;
    margin-left: $space-2;
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text;
  }

  // 不在供：去掉金底描边，改灰底虚边 ——「这不是一份有效证照」要一眼看得出
  &.note--off {
    background: $c-bg;
    border: 1px dashed $c-border;
  }
}

.card {
  margin: $space-4 $space-4 0;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &__title {
    display: block;
    margin-bottom: $space-2;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }
}

.lic {
  padding: $space-3 0;
  border-top: 1px solid $c-border;

  &__hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__label {
    font-size: $fs-body;
    color: $c-text;
  }

  &__ok {
    color: $c-ok-fg;
  }

  &__code {
    display: block;
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text;
  }

  &__expire {
    display: block;
    margin-top: 2rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.dishes {
  display: flex;
  flex-wrap: wrap;
  gap: $space-1;

  &__tag {
    padding: 2rpx $space-2;
    font-size: $fs-caption;
    color: $c-text;
    background: $c-bg;
    border: 1px solid $c-border;
    border-radius: $radius-sm;
  }
}
</style>
