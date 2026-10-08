<template>
  <view class="page">
    <!-- 当前所属（来自 A2） -->
    <view class="current">
      <text class="current__label">当前办公楼</text>
      <text class="current__name">{{ displayOr(currentName, '未选择') }}</text>
      <text v-if="currentLeader" class="current__leader">跟随团长：{{ currentLeader }}</text>
    </view>

    <text class="note">{{ note }}</text>

    <ab-loading v-if="loading && !list.length" text="正在取办公楼列表" />

    <view v-else-if="list.length" class="card">
      <view
        v-for="b in list"
        :key="b.id"
        class="bld"
        :class="{ 'is-current': b.id === currentId }"
        :hover-class="b.id === currentId ? 'none' : 'bld--hover'"
        @tap="pick(b)"
      >
        <view class="bld__main">
          <text class="bld__name">{{ b.name }}</text>
          <text class="bld__addr">{{ b.address }}</text>
          <text class="bld__leader">
            {{ b.leaderName ? `该楼团长：${b.leaderName}` : '该楼暂无在职团长' }}
          </text>
        </view>
        <text v-if="b.id === currentId" class="bld__tag">当前</text>
        <text v-else class="ab-icon-arrow"
          ><text class="abi abi-16">{{ I.chev }}</text></text
        >
      </view>
    </view>

    <ab-empty-state
      v-else
      text="暂无可选办公楼"
      hint="运营还没登记营业中的办公楼，请联系客服"
      illustration="building"
      action-text="重新加载"
      @action="load"
    />

    <view class="tip">
      <text class="tip__text">
        换楼会按新办公楼重新匹配跟随团长（佣金归属随之改变）。在职团长不能自助换楼，需运营审核。
      </text>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 自助选择 / 更换办公楼（`GET /building` + `PUT /me/building`）
 *
 * ## 为什么会有这一页
 *
 * `ab_user.building_id` 此前**只有团长邀请链接一个写入口**。于是没有链接的人
 * （同事扫码进来联调、老用户换楼）在首页看到的是「本楼今日未开团」——
 * 真实原因（未绑定办公楼）被首页 `emptyText` 的兜底文案吞掉，且**没有任何自助出口**。
 * 本页 + 首页空态的「选择办公楼」按钮把这条链路补成闭环。
 *
 * ## ⭐ 换楼后不回带团长，交给 A2
 *
 * `PUT /me/building` 的出参**刻意不含团长信息**（换楼会清空 `team_leader_id`，
 * 归属由服务端按新楼重算）。故本页成功后只 `navigateBack()` ——
 * 上一页的 `onShow` 会重新拉 `/home/daily` 与 A2，显示自然就是最新的。
 * 端上在此另算一份 leaderName 就是第二份归属判据（M5-17 缺陷 ⑫ 的形状）。
 *
 * ## ⚠️ 列表里必须显示「该楼有没有团长」
 *
 * 用户选楼的真正目的是「跟着谁取餐」，只有楼名他判断不了。
 * 且「暂无在职团长」的楼即便绑了也是未开团 —— 提前讲清楚，
 * 好过让用户绑完才发现还是下不了单。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { fetchMe } from '@/api/auth';
import { fetchBuildings } from '@/api/building';
import type { BuildingOptionItem } from '@/api/building';
import { bindBuilding } from '@/api/user';
import { toastApiError, useRequest } from '@/composables/use-request';
import { useUserStore } from '@/stores/user';
import { displayOr } from '@/utils/format';
import { navigateBack } from '@/utils/router';
import { ABOX_ICON_CHARS as I } from '@abox/shared-utils';

const { run } = useRequest();
const userStore = useUserStore();

const list = ref<BuildingOptionItem[]>([]);
const note = ref('');
const loading = ref(false);
const submitting = ref(false);

/** 当前所属楼（A2 快照优先；本地缓存只作首帧兜底 —— 与 P8 同一纪律） */
const currentId = ref<number | null>(null);
const currentName = ref<string | null>(null);
const currentLeader = ref<string | null>(null);

async function loadMe(): Promise<void> {
  try {
    // 会话裁决者：走 `run()` ⇒ token 过期时自动重登后重试一次（它**不挂** `keepAuthState`，
    //    否则本页没有别的腿来裁决登录态；纪律见 `pages/order-list/order-list.vue` 的 P1-16）
    const res = await run(() => fetchMe());
    currentId.value = res.buildingId ?? null;
    currentName.value = res.buildingName ?? null;
    currentLeader.value = res.leaderName ?? null;
    userStore.setLogin(userStore.token, {
      id: res.id,
      nickname: res.nickname,
      avatarUrl: res.avatarUrl,
      phone: res.phone,
      buildingId: res.buildingId,
      teamLeaderId: res.teamLeaderId,
    });
  } catch (e) {
    toastApiError(e);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await run(() => fetchBuildings());
    list.value = res.list;
    note.value = res.note;
  } catch (e) {
    toastApiError(e);
  } finally {
    loading.value = false;
  }
}

/** 选楼（当前楼点了不动，避免一次误触就发一次写请求） */
async function pick(b: BuildingOptionItem): Promise<void> {
  if (submitting.value || b.id === currentId.value) return;

  const noLeader = !b.leaderName;
  const content = noLeader
    ? `「${b.name}」目前没有在职团长，绑定后仍可能看不到次日套餐。确定选择？`
    : `确定把办公楼切换为「${b.name}」？跟随团长会按新楼重新匹配。`;

  try {
    await new Promise<void>((resolve, reject) => {
      uni.showModal({
        title: '切换办公楼',
        content,
        confirmText: '确定',
        cancelText: '再看看',
        success: (r) => (r.confirm ? resolve() : reject(new Error('__cancel__'))),
        fail: () => reject(new Error('__cancel__')),
      });
    });
  } catch {
    return; // 用户取消
  }

  submitting.value = true;
  try {
    // 同上：用户主动写操作要能透明重登后重试 —— 标 `keepAuthState` 会让它永远失败
    // （点一次没反应，再点一次才好），那才是用户可感知的坏体验。
    const res = await run(() => bindBuilding(b.id));
    uni.showToast({ title: res.changed ? '已切换办公楼' : '你已在该办公楼', icon: 'none' });
    navigateBack();
  } catch (e) {
    toastApiError(e);
  } finally {
    submitting.value = false;
  }
}

onShow(() => {
  // 先取 A2（要判「当前是哪栋楼」，也顺带保证后续写请求已有 token），再取列表
  void (async () => {
    await loadMe();
    await load();
  })();
});
</script>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  padding: $space-3 $space-4 200rpx;
  box-sizing: border-box;
}

.current {
  display: flex;
  flex-direction: column;
  padding: $space-4;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;

  &__label {
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__name {
    margin-top: $space-1;
    font-size: $fs-h2;
    font-weight: bold;
    color: $c-text;
  }

  &__leader {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.note {
  display: block;
  margin-top: $space-3;
  font-size: $fs-caption;
  line-height: 1.7;
  color: $c-text-weak;
}

.card {
  margin-top: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-lg;
  overflow: hidden;
}

.bld {
  display: flex;
  align-items: center;
  gap: $space-2;
  padding: $space-4;
  border-bottom: 1px solid rgba(228, 216, 195, 0.6);

  &:last-child {
    border-bottom: none;
  }

  &--hover {
    opacity: 0.85;
  }

  &.is-current {
    background: $c-surface-2;
  }

  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  &__name {
    font-size: $fs-body;
    font-weight: bold;
    color: $c-text;
  }

  &__addr {
    margin-top: 2rpx;
    font-size: $fs-caption;
    color: $c-text-weak;
  }

  &__leader {
    margin-top: $space-1;
    font-size: $fs-caption;
    color: $c-gold-fg;
  }

  &__tag {
    flex: none;
    padding: 0 $space-2;
    font-size: $fs-caption;
    color: $c-text-weak;
  }
}

.ab-icon-arrow {
  flex: none;
  color: $c-text-weak;
}

.tip {
  margin-top: $space-3;
  padding: 0 $space-1;

  &__text {
    font-size: $fs-caption;
    line-height: 1.7;
    color: $c-text-weak;
  }
}
</style>
