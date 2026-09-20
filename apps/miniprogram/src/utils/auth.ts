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
import { currentDevCode } from '@/utils/dev-identity';

/**
 * 取微信登录 code
 *
 * ⚠️ demo（非 production）模式直接返回 `currentDevCode()`：
 *    `PROVIDER_MODE=mock` 时服务端据此后定 openid，
 *    从而「反复登录同一账号」成为可能 —— 否则每次 `uni.login` 都是新用户，
 *    本地根本无法验证「同一天重复下单」这类业务规则。
 *
 * ⭐ M5-15：`currentDevCode()` = 本地身份记录 ?? `ENV.wxDevLoginCode`（默认 `dev:1001`）。
 *    于是 `?devCode=1002` 可以**在同一台设备上换成另一个人**（见 `utils/dev-identity.ts`
 *    —— 此前写死 `ENV.wxDevLoginCode`，导致"怎么退出重注册都还是李明"）。
 */
export function fetchWxCode(): Promise<string> {
  if (ENV.demoMode) return Promise.resolve(currentDevCode());

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

/**
 * U3 落地页「微信授权加入」：**登录 + 绑定推荐团长同一趟完成**
 *
 * ⭐ 这是「扫码进来的人归谁」在端上的唯一入口（缺陷 #92 收口 · 2026-09-18）：
 *   规范 §1.5 的「登录链路带邀请码 → 绑定推荐团长」正是这个调用。
 *
 * ⚠️ **失效码不能把人锁在门外**：服务端对无效 / 停职团长返回 `30007`（整趟登录失败），
 *   故这里**必须兜底**——捕获后回落成「不带邀请码的普通登录」，登录照常成功，
 *   只有绑定这件事没发生（由调用方提示用户）。
 *
 * @returns `bound` = 绑定是否真的生效（false 表示码已失效，只登录成功）
 */
export async function bindLeaderByInvite(
  inviteCode: string,
): Promise<{ bound: boolean; message: string }> {
  const code = await fetchWxCode();
  try {
    const res = await login({ code, inviteCode });
    applyLoginResult(res);
    console.warn(`[auth] 邀请码绑定成功 userId=${res.user.id} leaderId=${res.user.teamLeaderId}`);
    return { bound: true, message: '' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '邀请码绑定失败';
    console.warn(`[auth] 邀请码绑定失败（回落普通登录）：${msg}`);
    // 兜底：不带邀请码再登一次 —— 让用户能正常用，而不是卡在落地页
    await ensureLogin(true);
    return { bound: false, message: msg };
  }
}

/** 退出登录（清空双身份） */
export function logout(): void {
  useUserStore().clear();
  useLeaderStore().clear();
}
