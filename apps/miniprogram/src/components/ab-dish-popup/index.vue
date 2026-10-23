<template>
  <view v-if="rendered" class="dp">
    <!-- 遮罩（点按关闭） -->
    <view class="dp__mask" :style="maskStyle" @tap="requestClose" />

    <!-- 居中模态卡（方案B） -->
    <view class="dp__sheet" :style="sheetStyle">
      <!-- 顶部手势区：拖拽指示条 + 头图（下拉关闭的手势起点） -->
      <view
        class="dp__header"
        @touchstart="onTouchStart($event, true)"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
      >
        <view class="dp__grabber" @tap="requestClose" />
        <view class="dp__hero" :class="{ 'dp__hero--fallback': !item?.imageUrl }">
          <image
            v-if="item?.imageUrl"
            class="dp__hero-img"
            :src="item.imageUrl"
            mode="aspectFill"
            @tap="openZoom(item.imageUrl)"
          />
          <text v-else class="dp__hero-letter">{{ firstChar }}</text>
          <view v-if="item?.imageUrl" class="dp__hero-scrim" />
          <view v-if="item?.category" class="dp__badge">{{ item.category }}</view>
        </view>
      </view>

      <!-- 可滚动主体 -->
      <scroll-view
        class="dp__body"
        :scroll-y="!dragging"
        @scroll="onScroll"
        @touchstart="onTouchStart($event, false)"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
      >
        <view class="dp__content">
          <text class="dp__name">{{ item?.name }}</text>
          <text v-if="item?.supplierName" class="dp__supplier"
            >由 {{ item.supplierName }} 供应</text
          >

          <!-- 关于这道菜（description 为空时优雅降级为中性说明，与 C8 不冲突） -->
          <view class="dp__section">
            <text class="dp__section-title">
              <text class="abi abi-16">{{ I.info }}</text> 关于这道菜
            </text>
            <text class="dp__desc">{{ descriptionText }}</text>
          </view>

          <!-- 门店实拍（决策2·方案B 保留照片墙；后端已补 store_photos 列 + 下发字段，见迁移 1700000000015） -->
          <view v-if="photos.length" class="dp__section">
            <text class="dp__section-title">
              <text class="abi abi-16">{{ I.camera }}</text> 门店实拍
            </text>
            <view class="dp__photos">
              <view
                v-for="(p, i) in photos"
                :key="i"
                class="dp__photo"
                hover-class="dp__photo--hover"
                @tap="openZoom(p.url)"
              >
                <image class="dp__photo-img" :src="p.url" mode="aspectFill" />
              </view>
            </view>
          </view>

          <!-- 查看完整资质 ›（supplierId 缺失时整块不渲染） -->
          <view
            v-if="item?.supplierId"
            class="dp__qual"
            hover-class="dp__qual--hover"
            @tap="goQualification"
          >
            <text class="abi abi-16 dp__qual-icon">{{ I.shield }}</text>
            <text class="dp__qual-text">查看完整资质</text>
            <text class="abi abi-16 dp__qual-arrow">{{ I.chev }}</text>
          </view>

          <view class="dp__pad" />
        </view>
      </scroll-view>
    </view>

    <!-- 图片放大预览（点按关闭；contain 全图不裁切） -->
    <view v-if="previewUrl" class="dp__preview" @tap="closeZoom">
      <image class="dp__preview-img" :src="previewUrl" mode="aspectFit" />
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * dish-popup —— 首页「本日精选」菜品点击弹窗（方案B 居中模态卡）
 *
 * ## 关闭系统（四条路径，与高保真稿一致）
 * ① 顶部 iOS 风格拖拽指示条（grabber）点按；
 * ② 卡片下拉手势（跟手位移 + 缩放 + 遮罩渐隐，>90px 阈值关闭，未过回弹）；
 * ③ 点遮罩；
 * ④ Esc（H5 / Web 预览环境；小程序实体无 Esc，前三条覆盖）。
 *
 * ⚠️ 手势与内部滚动的冲突：滚动主体 `scroll-view` 的 `scroll-y` 在 `dragging` 时强制
 *    为 false，避免下拉时卡片与内容同时滚动。手势仅在「内容已滚到顶（scrollTop<=0）
 *    且向下拉」时接管，否则让原生滚动优先。
 *
 * ## 数据
 * · `item`：U1 套餐内一道菜的展示视图（MealItemView），含 imageUrl / description /
 *   category / supplierName / supplierId —— **无需新增后端字段**即可落地头图与资质入口。
 * · `photos`：门店实拍（决策2·方案B 保留）。⭐ 后端已落地 `store_photos` 列（迁移 1700000000015）
 *   与 `SupplierQualificationDetail.photos` / `SupplierQualificationItem.photos` 下发字段；
 *   本组件把照片墙做成「有则显示、无则整体隐藏」的可选增强，数据由首页 `openDish` 按 supplierId 注入。
 *
 * ## 图标（icons:lock）
 * 仅用 `<text class="abi">{{ I.xxx }}</text>` 模板形态，script 段不写 `I.xxx` 字面量。
 */
import { computed, ref, watch, nextTick } from 'vue';
import type { MealItemView } from '@abox/shared-types';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';
import { navigateTo, buildUrl } from '@/utils/router';

interface DishPhoto {
  /** 照片地址（营业执照 / 门头 / 大厅 / 仓库 等，无文字标签） */
  url: string;
}

const props = defineProps<{
  /** 是否可见（由父组件 v-model:visible 控制） */
  visible: boolean;
  /** 当前菜品（null 时不渲染内容） */
  item: MealItemView | null;
  /** 门店实拍（可选增强，默认无） */
  photos?: DishPhoto[];
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

// ---- 挂载 / 进出动画 ----
const rendered = ref(false);
const active = ref(false);
const previewUrl = ref<string | null>(null);

// ---- 拖拽关闭手势状态 ----
const dragY = ref(0);
const dragging = ref(false);
const bodyScrollTop = ref(0);
let startY = 0;
let startScrollTop = 0;
let gestureActive = false;

watch(
  () => props.visible,
  (v) => {
    if (v) {
      rendered.value = true;
      // 先以「未激活」态挂载（scale .92 / opacity 0），下一帧再激活 → 触发 CSS 过渡
      nextTick(() => {
        setTimeout(() => {
          active.value = true;
        }, 20);
      });
    } else if (rendered.value) {
      active.value = false;
      dragging.value = false;
      setTimeout(() => {
        rendered.value = false;
        dragY.value = 0;
        gestureActive = false;
      }, 300);
    }
  },
);

// ---- 样式计算 ----
const sheetStyle = computed(() => {
  if (dragging.value) {
    const scale = Math.max(0.85, 1 - dragY.value * 0.0003);
    return {
      transform: `translateY(${dragY.value}px) scale(${scale})`,
      opacity: Math.max(0.4, 1 - dragY.value * 0.0008),
      transition: 'none',
    };
  }
  return {
    transform: active.value ? 'translateY(0) scale(1)' : 'translateY(0) scale(0.92)',
    opacity: active.value ? 1 : 0,
    transition: 'transform .28s ease, opacity .26s ease',
  };
});

const maskStyle = computed(() => {
  if (dragging.value) {
    return { opacity: Math.max(0.12, 0.5 - dragY.value / 900), transition: 'none' };
  }
  return { opacity: active.value ? 0.5 : 0, transition: 'opacity .28s ease' };
});

// ---- 派生内容 ----
const photos = computed(() => props.photos ?? []);
const firstChar = computed(() => (props.item?.name?.charAt(0) ?? '').toUpperCase() || '菜');

const descriptionText = computed(() => {
  const d = props.item?.description;
  if (d && d.trim()) return d.trim();
  // 优雅降级：不报错，给一句中性说明
  return props.item?.supplierName ? `由 ${props.item.supplierName} 供应` : '暂无更多介绍';
});

// ---- 手势 ----
// uni-app 的 `view` 触摸事件实参即 DOM `TouchEvent`（含 `touches: TouchList`，
// 每项 `Touch` 有 `clientY`）；直接用它即可，不必再定义局部最小接口。
function onTouchStart(e: TouchEvent, fromHeader: boolean): void {
  if (!rendered.value) return;
  const t = e.touches?.[0];
  if (!t) return;
  startY = t.clientY;
  startScrollTop = fromHeader ? 0 : bodyScrollTop.value;
  gestureActive = false;
}

function onTouchMove(e: TouchEvent): void {
  if (!rendered.value) return;
  const t = e.touches?.[0];
  if (!t) return;
  const dy = t.clientY - startY;
  // 仅在「已滚到顶且向下拉」时接管；否则让原生滚动优先（不启动手势）
  if (!gestureActive) {
    if (dy > 8 && startScrollTop <= 0) {
      gestureActive = true;
      dragging.value = true;
    } else {
      return;
    }
  }
  dragY.value = Math.max(0, dy);
}

function onTouchEnd(): void {
  if (!gestureActive) {
    dragging.value = false;
    return;
  }
  if (dragY.value > 90) {
    dragging.value = false;
    active.value = false;
    emit('close');
  } else {
    dragY.value = 0;
    dragging.value = false;
  }
  gestureActive = false;
}

function onScroll(e: { detail?: { scrollTop?: number } }): void {
  bodyScrollTop.value = e.detail?.scrollTop ?? 0;
}

// ---- 关闭 / 导航 / 放大 ----
function requestClose(): void {
  emit('close');
}

function goQualification(): void {
  const id = props.item?.supplierId;
  if (!id) return;
  navigateTo(buildUrl('/pages/supplier/detail', { id }));
}

function openZoom(url: string): void {
  if (!url) return;
  previewUrl.value = url;
}

function closeZoom(): void {
  previewUrl.value = null;
}
</script>

<style lang="scss" scoped>
.dp {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 200;
}

// 遮罩
.dp__mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: #000000;
}

// 卡片（方案B：左右留 20rpx，底部贴边，max-height 84% 内部滚动）
.dp__sheet {
  position: absolute;
  right: 20rpx;
  bottom: 0;
  left: 20rpx;
  display: flex;
  flex-direction: column;
  max-height: 84vh;
  background: $c-surface;
  border-radius: 36rpx 36rpx 0 0;
  overflow: hidden;
  box-shadow: 0 -16rpx 48rpx rgba(110, 84, 53, 0.28);
  transform-origin: center bottom;
  will-change: transform;
}

// 顶部手势区（grabber + 头图）
.dp__header {
  position: relative;
  flex: none;
}

// iOS 风格拖拽指示条：38×4px 圆角白条，零布局开销悬浮顶部；纯视觉 + 可点按关闭
.dp__grabber {
  position: absolute;
  top: 14rpx;
  left: 50%;
  z-index: 3;
  width: 76rpx;
  height: 8rpx;
  margin-left: -38rpx;
  background: rgba(255, 255, 255, 0.92);
  border-radius: 999rpx;
  box-shadow: 0 1rpx 3rpx rgba(0, 0, 0, 0.25);
}

// 头图
.dp__hero {
  position: relative;
  width: 100%;
  height: 320rpx;
  background: linear-gradient(135deg, $c-gold 0%, $c-gold-deep 100%);
}

.dp__hero-img {
  width: 100%;
  height: 100%;
}

// 有图时在底部压一层 scrim，保证角标白字可读
.dp__hero-scrim {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 120rpx;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.62), rgba(0, 0, 0, 0));
}

// 无图：渐变 + 首字水印兜底（不写死色块，真实拍照就位后自动走全图）
.dp__hero--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
}

.dp__hero-letter {
  font-size: 120rpx;
  font-weight: bold;
  color: rgba(255, 255, 255, 0.85);
}

// 角标（类别，如「主菜 / 素品」）—— 纯文字，不另加图标
.dp__badge {
  position: absolute;
  top: 28rpx;
  left: 24rpx;
  z-index: 2;
  padding: 6rpx 18rpx;
  font-size: $fs-caption;
  color: #ffffff;
  background: rgba(110, 84, 53, 0.72);
  border-radius: $radius-pill;
}

// 滚动主体
.dp__body {
  flex: 1 1 auto;
  min-height: 0;
}

.dp__content {
  padding: $space-4 $space-4 0;
}

.dp__name {
  display: block;
  font-size: $fs-h1;
  font-weight: bold;
  line-height: 1.3;
  color: $c-text;
}

.dp__supplier {
  display: block;
  margin-top: $space-1;
  font-size: $fs-caption;
  color: $c-text-weak;
}

// 段落
.dp__section {
  margin-top: $space-4;
}

.dp__section-title {
  display: flex;
  align-items: center;
  gap: 8rpx;
  font-size: $fs-body;
  font-weight: bold;
  color: $c-text;
}

.dp__desc {
  display: block;
  margin-top: $space-2;
  font-size: $fs-body;
  line-height: 1.8;
  color: $c-text-weak;
}

// 门店实拍：1:1 网格，纯图无文字标签
.dp__photos {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: $space-2;
  margin-top: $space-2;
}

.dp__photo {
  position: relative;
  height: 220rpx;
  border-radius: $radius-md;
  overflow: hidden;
  background: $c-surface-2;

  &--hover {
    opacity: 0.85;
  }
}

.dp__photo-img {
  width: 100%;
  height: 100%;
}

// 查看完整资质入口
.dp__qual {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-top: $space-4;
  padding: $space-3 $space-4;
  background: $c-gold-bg;
  border: 1px solid $c-gold-bd;
  border-radius: $radius-md;

  &--hover {
    opacity: 0.85;
  }
}

.dp__qual-icon {
  color: $c-gold-fg;
}

.dp__qual-text {
  flex: 1;
  font-size: $fs-body;
  font-weight: bold;
  color: $c-gold-fg;
}

.dp__qual-arrow {
  color: $c-gold-fg;
}

.dp__pad {
  height: $space-4;
}

// 图片放大预览
.dp__preview {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.92);
}

.dp__preview-img {
  width: 100%;
  height: 100%;
}
</style>
