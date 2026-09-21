<template>
  <view class="page">
    <!-- ⭐ 版式基准 = prototype/index.html renderP13（v4.10.0）：
         金棕汇总卡（三指标 + 异常醒目入口）→ 成员订单行式列表 → 点击发起退款 -->

    <!-- ① 汇总卡 -->
    <view class="hero">
      <view class="hero__stats">
        <view class="hero__stat">
          <text class="hero__value">{{ summary.quantity }}</text>
          <text class="hero__unit">总份数</text>
        </view>
        <view class="hero__stat">
          <text class="hero__value">{{ fenToYuanText(summary.amountFen) }}</text>
          <text class="hero__unit">总金额</text>
        </view>
        <view class="hero__stat">
          <text class="hero__value">{{ fenToYuanText(summary.commissionFen) }}</text>
          <text class="hero__unit">佣金 {{ ratePercent }}%</text>
        </view>
      </view>

      <text class="hero__foot">{{ summaryFoot }}</text>

      <!-- 异常订单醒目入口（原型：红底框，嵌在汇总卡内） -->
      <view
        v-if="abnormalCount > 0"
        class="hero__alert"
        hover-class="hero__alert--hover"
        @tap="goAbnormal"
      >
        <text class="abi abi-24 hero__alert-icon">{{ I['warn-tri'] }}</text>
        <view class="hero__alert-body">
          <text class="hero__alert-title">异常订单（待你处理）</text>
          <text class="hero__alert-sub">
            {{ abnormalCount }} 单待支付 · 共 {{ abnormalQuantity }} 份
          </text>
        </view>
        <text class="hero__alert-arrow"
          ><text class="abi abi-16">{{ I.chev }}</text></text
        >
      </view>
    </view>

    <!-- 筛选（原型无此条，保留为可用性优化：本楼订单可到 40+ 单） -->
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

    <!-- ② 成员订单 -->
    <view class="card">
      <view class="card__hd">
        <text class="card__title"
          ><text class="abi abi-16">{{ I.list }}</text> 成员订单（脱敏信息）</text
        >
        <text class="card__count">{{ formatMealDate(mealDate) }} · 共 {{ total }} 单</text>
      </view>

      <ab-loading v-if="loading && !list.length" text="正在加载订单" />

      <ab-empty-state
        v-else-if="!list.length"
        text="本日暂无订单"
        hint="换个筛选条件，或检查是否已到开团时间"
        illustration="receipt"
      />

      <template v-else>
        <view
          v-for="item in list"
          :key="item.orderNo"
          class="row"
          hover-class="row--hover"
          @tap="goRefund(item.orderNo)"
        >
          <view class="row__left">
            <text class="row__name">{{ displayOr(item.userName, '匿名用户') }}</text>
            <text class="row__sub">
              {{ item.quantity }} 份 ·
              {{ displayOr(item.phoneMasked, '未留手机号') }}
            </text>
            <text v-if="item.remark" class="row__remark">备注：{{ item.remark }}</text>
          </view>

          <view class="row__right">
            <text class="row__amount">{{ fenToYuanText(item.totalAmountFen) }}</text>
            <ab-status-badge :text="item.statusText" :status="item.status" />
          </view>
        </view>

        <view class="more">
          <text v-if="hasMore" class="more__btn" @tap="loadMore">
            {{ loading ? '加载中…' : '加载更多' }}
          </text>
          <text v-else class="more__end">没有更多了</text>
        </view>
      </template>
    </view>

    <text class="hint"
      ><text class="abi abi-16">{{ I.info }}</text>
      点击任意成员可查看订单详情并发起代退申请（截单后用户不可自助退款）</text
    >

    <!--
      导出（⚠️ 原型此页标注「去导出」，实装**保留**）：
      L5 是含完整手机号的合规导出（服务端写 ab_operation_log 留痕），
      对账 / 配送交接要用；删掉等于功能回退，故仅作视觉弱化，不移除。
    -->
    <view class="footer">
      <button class="footer__btn" hover-class="footer__btn--hover" @tap="doExport">导出明细</button>
      <text class="footer__hint">导出含完整手机号，仅用于对账 / 配送，请勿外传</text>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * P13 · 订单明细（本办公楼 · 团长视角）
 *
 * ⭐ 版式基准 = prototype/index.html renderP13（v4.10.0）
 *
 * 数据来源：
 *   · L4 `GET /leader/orders`          —— 成员订单列表（手机号**已脱敏**）
 *   · L6 `/leader/orders/abnormal`     —— 待支付催促（异常入口）
 *   · L1 `GET /leader/workbench`       —— 汇总卡三指标（L4 只回 `total` 单数，无份数/金额）
 *   · L5 `/leader/orders/export`       —— 导出（含完整手机号 + 服务端留痕）
 *
 * ⚠️ 脱敏纪律（§1.6）：本页所有手机号一律取服务端 `phoneMasked`，端上**不还原**明文；
 *    唯一能拿到完整号的是「导出」（L5），服务端会写 `ab_operation_log`，端上不落盘留存。
 * ⚠️ 汇总卡三指标取 **L1 今日战报**而非端上累加列表 —— 列表是分页的（一页 20 条），
 *    端上累加只能得到「当前页合计」，用户会拿它跟本楼总份数对不上。
 * ⚠️ 点击订单行 → P14 代退：截单后退款**用户不可自助**（C6），团长是唯一发起人。
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { OrderStatus } from '@abox/shared-types';

import { fetchWorkbench } from '@/api/leader';
import { exportLeaderOrders, fetchLeaderAbnormal, fetchLeaderOrders } from '@/api/leader-order';
import type { LeaderOrderItem } from '@/api/leader-order';
import { toastApiError, useRequest } from '@/composables/use-request';
import { PAGE_SIZE } from '@/constants';
import { displayOr, fenToYuanText, formatMealDate } from '@/utils/format';
import { buildUrl, navigateTo } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

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

/** 汇总卡三指标（L1 今日战报；未取到时显示 0 而非估算） */
const summary = ref({
  quantity: 0,
  amountFen: 0,
  commissionFen: 0,
  refundCount: 0,
  completedQuantity: 0,
  rate: 0,
});

const ratePercent = computed(() =>
  summary.value.rate ? (summary.value.rate * 100).toFixed(0) : '--',
);

/** 汇总卡页脚：如实说明佣金基数（原型「1 单退款已跳过，佣金按实发 45 份结算」） */
const summaryFoot = computed(() => {
  const s = summary.value;
  const skip = s.refundCount > 0 ? `${s.refundCount} 单退款已跳过，` : '';
  return `（${skip}佣金按实发 ${s.completedQuantity} 份结算）`;
});

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

/** 汇总卡：辅信息，失败只影响那张卡，不挡列表 */
async function loadSummary(): Promise<void> {
  try {
    const res = await run(() => fetchWorkbench());
    summary.value = {
      quantity: res.today.quantity,
      amountFen: res.today.amountFen,
      commissionFen: res.today.commissionFen,
      refundCount: res.today.refundCount,
      completedQuantity: res.today.completedQuantity,
      rate: res.today.rate,
    };
  } catch {
    // 保留默认 0 值
  }
}

async function reload(): Promise<void> {
  try {
    await fetchPage(1);
    void loadAbnormal();
    void loadSummary();
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

// ---- ① 汇总卡 ----
.hero {
  margin-top: $space-4;
  padding: 32rpx $space-4;
  background: linear-gradient(135deg, $c-gold, $c-gold-deep);
  border-radius: 32rpx;
  color: #ffffff;
  box-shadow: 0 10rpx 26rpx rgba(110, 84, 53, 0.2);

  &__stats {
    display: flex;
    align-items: center;
    justify-content: space-around;
  }

  &__stat {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  &__value {
    font-size: 40rpx;
    font-weight: bold;
  }

  &__unit {
    margin-top: 4rpx;
    font-size: 22rpx;
    opacity: 0.9;
  }

  &__foot {
    display: block;
    margin-top: $space-3;
    font-size: 22rpx;
    line-height: 1.6;
    text-align: center;
    opacity: 0.88;
  }

  &__alert {
    display: flex;
    align-items: center;
    margin-top: $space-3;
    padding: $space-3;
    background: rgba(196, 69, 54, 0.22);
    border: 1px solid rgba(196, 69, 54, 0.5);
    border-radius: $radius-lg;

    &--hover {
      opacity: 0.86;
    }
  }

  &__alert-icon {
    flex: none;
  }

  &__alert-body {
    flex: 1;
    min-width: 0;
    margin-left: $space-2;
  }

  &__alert-title {
    display: block;
    font-size: $fs-body;
    font-weight: bold;
  }

  &__alert-sub {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    opacity: 0.9;
  }

  &__alert-arrow {
    flex: none;
    opacity: 0.9;
  }
}

// ---- 筛选 / 搜索 ----
.tabs {
  padding: $space-3 0 $space-2;
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
    color: $c-gold-fg;
  }
}

// ---- ② 成员订单卡 ----
.card {
  margin-top: $space-3;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;

  &__hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: $space-2;
  }

  &__title {
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__count {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $space-3 0;
  border-bottom: 1px dashed $c-border-strong;

  &:last-of-type {
    border-bottom: none;
  }

  &--hover {
    opacity: 0.82;
  }

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

  &__sub {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-text-weak;
  }

  &__remark {
    display: block;
    margin-top: 4rpx;
    font-size: 22rpx;
    color: $c-gold-fg;
  }

  &__right {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin-left: $space-3;
  }

  &__amount {
    margin-bottom: 6rpx;
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }
}

.more {
  padding: $space-4 0 0;
  text-align: center;

  &__btn {
    font-size: $fs-caption;
    color: $c-gold-fg;
  }

  &__end {
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.hint {
  display: block;
  margin-top: $space-3;
  font-size: 22rpx;
  line-height: 1.7;
  color: $c-text-weak;
  text-align: center;
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
