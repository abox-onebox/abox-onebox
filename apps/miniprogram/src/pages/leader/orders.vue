<template>
  <view class="page">
    <!-- 筛选 -->
    <scroll-view class="tabs" scroll-x :show-scrollbar="false">
      <view class="tabs__inner">
        <view
          v-for="tab in tabs"
          :key="tab.value"
          class="tabs__item"
          :class="{ 'is-active': tab.value === activeStatus }"
          @tap="switchStatus(tab.value)"
        >
          <text class="tabs__label">{{ tab.label }}</text>
        </view>
      </view>
    </scroll-view>

    <!-- 搜索（订单号） -->
    <view class="search">
      <input
        v-model="keyword"
        class="search__input"
        type="text"
        placeholder="搜索订单号"
        placeholder-class="search__ph"
        confirm-type="search"
        @confirm="reload"
      />
      <text class="search__btn" @tap="reload">搜索</text>
    </view>

    <!-- 异常提示（L6 待支付催促） -->
    <view v-if="abnormalCount > 0" class="alert" @tap="goAbnormal">
      <text class="alert__text">
        {{ abnormalCount }} 单待支付（共 {{ abnormalQuantity }} 份），可提醒用户尽快付款
      </text>
      <text class="alert__link">去催促 ›</text>
    </view>

    <view class="meta">
      <text class="meta__date">{{ formatMealDate(mealDate) }}</text>
      <text class="meta__count">共 {{ total }} 单</text>
    </view>

    <ab-loading v-if="loading && !list.length" text="正在加载订单" />

    <ab-empty-state
      v-else-if="!list.length"
      text="本日暂无订单"
      hint="换个筛选条件，或检查是否已到开团时间（T-1 14:00）"
    />

    <template v-else>
      <view class="list">
        <view v-for="item in list" :key="item.orderNo" class="order" @tap="goRefund(item.orderNo)">
          <view class="order__hd">
            <text class="order__user">{{ displayOr(item.userName, '匿名用户') }}</text>
            <ab-status-badge :text="item.statusText" :status="item.status" />
          </view>

          <view class="order__row">
            <text class="order__phone">{{ displayOr(item.phoneMasked, '未留手机号') }}</text>
            <text class="order__qty">{{ item.quantity }} 份</text>
            <text class="order__amount">{{ fenToYuanText(item.totalAmountFen) }}</text>
          </view>

          <view class="order__ft">
            <text class="order__no">{{ item.orderNo }}</text>
            <text class="order__time">{{ formatDateTime(item.createdAt) }}</text>
          </view>

          <text v-if="item.remark" class="order__remark">备注：{{ item.remark }}</text>
        </view>
      </view>

      <view class="more">
        <text v-if="hasMore" class="more__btn" @tap="loadMore">
          {{ loading ? '加载中…' : '加载更多' }}
        </text>
        <text v-else class="more__end">没有更多了</text>
      </view>
    </template>

    <!-- 底部导出（涉完整手机号 → 服务端写操作日志留痕） -->
    <view class="footer">
      <button class="footer__btn" hover-class="footer__btn--hover" @tap="doExport">导出明细</button>
      <text class="footer__hint">导出含完整手机号，仅用于对账 / 配送，请勿外传</text>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * P13 · 订单明细（含异常入口）
 *
 * 数据来源：L4 `GET /leader/orders`（手机号**已脱敏**）、
 *          L6 `/leader/orders/abnormal`（待支付催促）、L5 `/leader/orders/export`（导出）。
 *
 * ⚠️ 脱敏纪律（§1.6）：本页所有手机号一律取服务端 `phoneMasked`，端上**不还原**明文；
 *    唯一能拿到完整号的是「导出」（L5），服务端会写 `ab_operation_log`，端上不落盘留存。
 * ⚠️ 点击订单行进入 P14 代退：截单后退款**用户不可自助**（C6），团长是唯一发起人。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { OrderStatus } from '@abox/shared-types';

import { exportLeaderOrders, fetchLeaderAbnormal, fetchLeaderOrders } from '@/api/leader-order';
import type { LeaderOrderItem } from '@/api/leader-order';
import { toastApiError, useRequest } from '@/composables/use-request';
import { PAGE_SIZE } from '@/constants';
import { displayOr, fenToYuanText, formatDateTime, formatMealDate } from '@/utils/format';
import { buildUrl, navigateTo } from '@/utils/router';

const tabs = [
  { label: '全部', value: '' },
  { label: '待支付', value: OrderStatus.PENDING_PAY },
  { label: '待出餐', value: OrderStatus.PAID },
  { label: '已送达', value: OrderStatus.DELIVERED },
  { label: '已完成', value: OrderStatus.COMPLETED },
  { label: '退款中', value: OrderStatus.REFUND_APPLYING },
];

const { run, loading } = useRequest();

const list = ref<LeaderOrderItem[]>([]);
const activeStatus = ref('');
const keyword = ref('');
const page = ref(1);
const hasMore = ref(false);
const total = ref(0);
const mealDate = ref('');
const abnormalCount = ref(0);
const abnormalQuantity = ref(0);

async function fetchPage(target: number): Promise<void> {
  const res = await run(() =>
    fetchLeaderOrders({
      status: activeStatus.value || undefined,
      keyword: keyword.value.trim() || undefined,
      page: target,
      pageSize: PAGE_SIZE,
    }),
  );
  list.value = target === 1 ? res.list : [...list.value, ...res.list];
  page.value = res.page;
  hasMore.value = res.hasMore;
  total.value = res.total;
  mealDate.value = res.mealDate;
}

/** 异常订单为辅信息：失败不打断主列表 */
async function loadAbnormal(): Promise<void> {
  try {
    const res = await run(() => fetchLeaderAbnormal());
    abnormalCount.value = res.count;
    abnormalQuantity.value = res.totalQuantity;
  } catch {
    abnormalCount.value = 0;
  }
}

async function reload(): Promise<void> {
  try {
    await fetchPage(1);
    void loadAbnormal();
  } catch (e) {
    toastApiError(e, '订单加载失败');
  }
}

async function loadMore(): Promise<void> {
  if (loading.value || !hasMore.value) return;
  try {
    await fetchPage(page.value + 1);
  } catch (e) {
    toastApiError(e);
  }
}

function switchStatus(value: string): void {
  if (value === activeStatus.value) return;
  activeStatus.value = value;
  list.value = [];
  void reload();
}

function goRefund(orderNo: string): void {
  navigateTo(buildUrl('/pages/leader/refund', { orderNo }));
}

function goAbnormal(): void {
  navigateTo('/pages/leader/refund');
}

/** CSV 单元格转义（含逗号 / 引号 / 换行时须加引号并转义内部引号） */
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * L5 · 导出明细
 *
 * 端侧落成 CSV 后分享给「文件传输助手」转发（小程序无法直接下载到本地）。
 * 数据由服务端组装并在服务端写操作日志 —— 端上只做格式拼装，不额外缓存明文。
 */
async function doExport(): Promise<void> {
  try {
    const res = await run(() => exportLeaderOrders({ mealDate: mealDate.value || undefined }));
    if (!res.count) {
      uni.showToast({ title: '当日无可导出订单', icon: 'none' });
      return;
    }

    // \uFEFF = BOM，避免 Excel 打开中文乱码
    const csv =
      '\uFEFF' + [res.headers, ...res.list].map((row) => row.map(csvCell).join(',')).join('\r\n');

    const uniLike = uni as unknown as {
      env?: { USER_DATA_PATH?: string };
      getFileSystemManager?: () => { writeFileSync: (p: string, d: string, e?: string) => void };
      shareFileMessage?: (o: {
        filePath: string;
        fileName: string;
        fail?: (e: unknown) => void;
      }) => void;
    };

    const base = uniLike.env?.USER_DATA_PATH;
    const fs = uniLike.getFileSystemManager?.();

    if (base && fs) {
      const filePath = `${base}/${res.fileName}`;
      fs.writeFileSync(filePath, csv, 'utf8');
      if (uniLike.shareFileMessage) {
        uniLike.shareFileMessage({
          filePath,
          fileName: res.fileName,
          fail: () => {
            uni.setClipboardData({ data: csv });
          },
        });
        return;
      }
    }

    // 兜底：复制 CSV 文本（端能力缺失时仍可用）
    uni.setClipboardData({ data: csv });
  } catch (e) {
    toastApiError(e, '导出失败');
  }
}

onShow(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: 0 $space-4 260rpx;
  box-sizing: border-box;
}

.tabs {
  padding: $space-3 0;
  white-space: nowrap;

  &__inner {
    display: inline-flex;
    align-items: center;
  }

  &__item {
    padding: $space-2 $space-3;
    margin-right: $space-3;
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

.search {
  display: flex;
  align-items: center;
  padding: $space-2 $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-pill;

  &__input {
    flex: 1;
    height: 56rpx;
    font-size: $fs-caption;
    color: $c-text;
  }

  &__ph {
    color: $c-text-weak;
  }

  &__btn {
    flex: none;
    padding-left: $space-3;
    font-size: $fs-caption;
    color: $c-gold;
  }
}

.alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: $space-3;
  padding: $space-3;
  background: rgba(196, 69, 54, 0.08);
  border-radius: $radius-md;

  &__text {
    flex: 1;
    font-size: $fs-caption;
    color: $c-warning;
  }

  &__link {
    flex: none;
    margin-left: $space-2;
    font-size: $fs-caption;
    color: $c-warning;
  }
}

.meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: $space-3 0;

  &__date {
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__count {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.order {
  margin-bottom: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__user {
    font-size: $fs-body;
    font-weight: 600;
    color: $c-text;
  }

  &__row {
    display: flex;
    align-items: baseline;
    padding: $space-3 0 $space-2;
  }

  &__phone {
    flex: 1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__qty {
    flex: none;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__amount {
    flex: none;
    margin-left: $space-3;
    font-size: $fs-h2;
    font-weight: 600;
    color: $c-text;
  }

  &__ft {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding-top: $space-2;
    border-top: 1px solid rgba(228, 216, 195, 0.5);
  }

  &__no,
  &__time {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__remark {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-gold;
  }
}

.more {
  padding: $space-4 0;
  text-align: center;

  &__btn {
    font-size: $fs-caption;
    color: $c-gold;
  }

  &__end {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.footer {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  padding: $space-3 $space-4;
  padding-bottom: calc(#{$space-3} + env(safe-area-inset-bottom));
  background: $c-bg;
  border-top: 1px solid $c-border;

  &__btn {
    height: 80rpx;
    font-size: $fs-body;
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
  }

  &__hint {
    display: block;
    margin-top: $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
    text-align: center;
  }
}
</style>
