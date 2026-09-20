/**
 * utils/dev-identity —— 本地联调**身份切换**（⭐ 仅 demo 模式生效）
 *
 * ## 为什么需要它（2026-09-20 · M5-15 人工测试缺陷 #1 的根因）
 *
 * 端上取登录 code 只有一条路径：`fetchWxCode()` → `ENV.wxDevLoginCode`
 * （`constants/env.ts:12`，默认 `dev:1001`，且 `VITE_WX_DEV_LOGIN_CODE` 全仓无人设置）。
 * 于是**任何入口、任何设备、任何一次冷启动都是同一个用户**（user#1001 · 李明）。
 *
 * 人工测试想验「普通用户 / 团员 / 团长」三种身份时，无论怎么退出团长、
 * 怎么"重新注册其他用户名"，拿回来的还是 1001 —— 现场被描述成
 * 「退出团长后重新注册其他用户名作为团长，但'我的'页面仍显示李明的身份」。
 *
 * ⭐ 这是**测试环境限制**，不是服务端缺陷：服务端 mock provider 本就支持
 *   `dev:<任意标识>`（`providers/wx-mini/mock-wx-mini.provider.ts:52` 的
 *   `/^dev:(.+)$/`），可指定任意身份反复登录。缺的只是**端上把它透出来**。
 *
 * ## 用法（仅本地联调）
 *
 *   H5：            `http://<ip>:5180/?devCode=1002`
 *   微信开发者工具：编译模式里给页面配 query `devCode=1002`
 *
 * 之后每次冷启动都以该身份登录；**换一个 `devCode` 即换人** ——
 * 本模块会返回「已换人」，由 `App.vue` 清掉上一个人的登录态后重新登录。
 * 不带 `devCode` 时回落到 `ENV.wxDevLoginCode`，保持既有行为不变。
 *
 * ## 安全边界（为什么这不是"线上可指定任意用户"的口子）
 *
 *   · 读取方 `fetchWxCode()` **只在 `ENV.demoMode` 分支**里问本模块；
 *     `demoMode = MODE !== 'production'` ⇒ 生产下走真实 `uni.login`，本模块的值从不被读。
 *   · 写入动作（`applyDevIdentity`）同样由 `App.vue` 在 demo 分支调用；
 *     为稳妥，本模块内部再自检一次 `ENV.demoMode`，非 demo 一律拒绝写入。
 *   · `devCode` 白名单式校验（`^[A-Za-z0-9_-]{1,32}$`），不接受任意串注入。
 */
import { ENV } from '@/constants/env';
import { STORAGE_KEYS, readStorage, writeStorage } from '@/utils/storage';

/**
 * 归一化 `devCode`：接受 `1002` 或 `dev:1002` 两种写法，输出恒为 `dev:<标识>`。
 * 非法（空 / 含路径字符 / 超长）返回 `null` —— 静默拒绝，不抛错阻断启动。
 */
export function normalizeDevCode(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const body = s.startsWith('dev:') ? s.slice(4) : s;
  return /^[A-Za-z0-9_-]{1,32}$/.test(body) ? `dev:${body}` : null;
}

/**
 * 当前生效的登录 code。
 * 有本地记录用本地记录，否则用出厂默认（`ENV.wxDevLoginCode`）。
 */
export function currentDevCode(): string {
  const saved = readStorage<string>(STORAGE_KEYS.devIdentity, '');
  return saved || ENV.wxDevLoginCode;
}

/**
 * 应用一次身份切换（由 `App.vue#onLaunch` 调用）。
 *
 * @returns `true` = **换人了** —— 调用方**必须**清掉旧登录态并重新登录
 *          （旧 token 属于上一个人；`restore()` 会把它当成"已登录"从而不重新授权）。
 *          `false` = 无需处理（没给 devCode / 与当前一致 / 非 demo 模式）。
 */
export function applyDevIdentity(raw: string | null | undefined): boolean {
  // 非 demo 模式：本机制整体不生效（双保险，调用点本就在 demo 分支）
  if (!ENV.demoMode) return false;

  const next = normalizeDevCode(raw);
  if (!next) return false;

  const prev = readStorage<string>(STORAGE_KEYS.devIdentity, '');
  if (prev === next) return false;
  // 首次启动且给的正是出厂默认身份 → 不算"换人"，避免无故清掉已有登录态
  if (prev === '' && next === ENV.wxDevLoginCode) return false;

  writeStorage(STORAGE_KEYS.devIdentity, next);
  return true;
}
