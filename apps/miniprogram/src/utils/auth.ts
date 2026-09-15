/**
 * utils/auth —— 登录编排（微信授权 → JWT → 写入双身份）
 *
 * 口径：
 *   · C3 / L9 —— 仅微信授权登录，**不取手机号、不取地址**
 *   · L10 —— 团长是**叠加身份**：登录出参同时给 `isLeader` + `leader`，
 *            同时写入 user store 与 leader store，保证「底部 tab 数量」正确
 */
import { ENV } from '@/constants/env';
import { login } from '@/api/auth';
import type { LoginResult } from '@/api/auth';
import { useUserStore } from '@/stores/user';
import { useLeaderStore } from '@/stores/leader';

/**
 * 取微信登录 code
 *
 * ⚠️ demo（非 production）模式直接返回固定 `dev:<userId>`：
 *    `PROVIDER_MODE=mock` 时服务端据此后定 openid，
 *    从而「反复登录同一账号」成为可能 —— 否则每次 `uni.login` 都是新用户，
 *    本地根本无法验证「同一天重复下单」这类业务规则。
 */
export function fetchWxCode(): Promise<string> {
  if (ENV.demoMode) return Promise.resolve(ENV.wxDevLoginCode);

  return new Promise<string>((resolve, reject) => {
    uni.login({
      provider: 'weixin',
      success: (res) => {
        if (res.code) resolve(res.code);
        else reject(new Error('微信登录未返回 code'));
      },
      fail: (err) => reject(new Error(err.errMsg || '微信登录失败')),
    });
  });
}

/** 把登录结果写入 store（用户身份 + 团长叠加身份同写同清） */
export function applyLoginResult(res: LoginResult): void {
  useUserStore().setLogin(res.token, res.user, res.isNewUser);

  const leader = useLeaderStore();
  if (res.isLeader && res.leader) {
    leader.setLeader({ ...res.leader, realName: null });
  } else {
    // 非团长 / 已被取消资格：清掉本地残留，避免 tab 多出一项
    leader.clear();
  }
}

/** 正在进行的登录（并发去重：多页同时初始化只走一次授权） */
let pending: Promise<void> | null = null;

/**
 * 确保已登录
 * @param force true = 忽略本地 token 强制重新登录（token 失效后使用）
 */
export function ensureLogin(force = false): Promise<void> {
  const user = useUserStore();
  if (!force && user.isLoggedIn) return Promise.resolve();

  if (!pending) {
    pending = (async () => {
      const code = await fetchWxCode();
      const res = await login({ code });
      applyLoginResult(res);
      console.warn(
        `[auth] 登录成功 userId=${res.user.id} isLeader=${res.isLeader} new=${res.isNewUser}`,
      );
    })().finally(() => {
      // 无论成功失败都释放，失败后允许重试（否则一次网络抖动会永久卡住登录）
      pending = null;
    });
  }
  return pending;
}

/** 退出登录（清空双身份） */
export function logout(): void {
  useUserStore().clear();
  useLeaderStore().clear();
}
