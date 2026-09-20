<script setup lang="ts">
import { onLaunch, onShow } from '@dcloudio/uni-app';
import { useUserStore } from '@/stores/user';
import { useLeaderStore } from '@/stores/leader';
import { applyDevIdentity } from '@/utils/dev-identity';
import { clearAuthStorage } from '@/utils/storage';

/**
 * 从多来源读取本地联调用的 `devCode`（**仅 demo 模式会真正被采纳**）
 *
 * 三条来源都要看，因为两端把参数放在不同位置：
 *   · 小程序端：`onLaunch` 的 `options.query`（编译模式 / 二维码 scene）；
 *   · H5：参数在 `location.search`（`?devCode=1002`）或 hash 段
 *     （`#/pages/index/index?devCode=1002`）。
 * 用正则而非 `URLSearchParams` —— 后者在小程序端不存在，虽然本函数在小程序端
 * 会在 `location` 缺失处提前返回，但**不引用**它更稳妥（避免打包差异）。
 */
function readDevCode(options: unknown): string | null {
  const fromQuery = (options as { query?: Record<string, string | undefined> } | undefined)?.query
    ?.devCode;
  if (fromQuery) return fromQuery;

  const loc = (globalThis as { location?: { search?: string; hash?: string } }).location;
  if (!loc) return null;

  const pick = (s: string): string | null => {
    const m = /[?&]devCode=([^&#]+)/.exec(s);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  };

  return pick(loc.search ?? '') ?? pick(loc.hash ?? '');
}

onLaunch((options) => {
  /*
   * ⭐ 本地联调身份切换（M5-15 · 仅 demo 模式，见 `utils/dev-identity.ts`）：
   *   `?devCode=1002` → 以 openid `mock_openid_1002` 登录，**换人**。
   *   换人后必须清掉上一个人的登录态 —— 否则 `restore()` 读到旧 token 便认为
   *   "已登录"，`ensureLogin()` 不会重新授权，人还停在旧身份上
   *   （这正是"退出团长、重注册另一用户名，'我的'仍显示李明"的另一半原因）。
   */
  if (applyDevIdentity(readDevCode(options))) {
    clearAuthStorage();
  }

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
