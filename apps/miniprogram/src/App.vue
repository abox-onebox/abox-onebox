<script setup lang="ts">
import { onLaunch, onShow } from '@dcloudio/uni-app';
import { useUserStore } from '@/stores/user';
import { useLeaderStore } from '@/stores/leader';

onLaunch(() => {
  // C3 · 登录态：仅微信授权，不取手机号与地址（L9）
  useUserStore().restore();
  // L10 · 团长为叠加身份，本地持久化后动态决定是否展示团长入口
  useLeaderStore().restore();
});

onShow(() => {
  // 每次前台恢复时校正倒计时（截单 T-1 24:00）
});
</script>

<style lang="scss">
@import '@/styles/common.scss';

page {
  background-color: $c-bg;
  color: $c-text;
  font-family: $font-family-base;
  font-size: $fs-body;
}
</style>
