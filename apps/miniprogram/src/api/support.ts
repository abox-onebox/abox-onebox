/**
 * api/support —— 客服入口（U17 · 《接口规范》§3.5）
 *
 * ## 三档模式（2026-10-04 定为终态 = `wechat_kf`）
 * `none` 复制微信号人工加好友（**兜底档**）· `contact` 小程序原生客服消息 ·
 * `wechat_kf` 微信客服（同事在**企业微信**里接，提醒可靠）。
 *
 * 三档是**降级关系**：高档位唤不起会话时**必须自动退回下一档**，
 * 永远不让用户点到一个没反应的按钮（具体分流见 `use-customer-service`）。
 *
 * ⚠️ 微信号 / 电话 / 服务时间 / 客服账号**全部由服务端下发**（运营在后台 `ab_config` 维护）——
 *    端上不得内置任何硬编码联系方式，否则换号或换客服账号时必须重新发版。
 *
 * ⭐ **`csCorpId` / `csUrl` 只在 `csMode === 'wechat_kf'` 时才可能有值**，
 *    其余模式服务端一律下发 `null` —— 端上因此无需判断「配了一半」，只认 `csMode`。
 */
import type { CustomerServiceMode } from '@abox/shared-types';

import { http } from './request';

export interface SupportContact {
  /** 客服微信号（用户手动搜索添加） */
  wechatId: string;
  /** 客服微信二维码图片 URL；为空则端上**隐藏二维码区**（不占位、不伪造） */
  wechatQrcodeUrl: string | null;
  /** 客服电话；为空则隐藏 */
  phone: string | null;
  /** 服务时间文案，如「工作日 9:00 – 18:00」 */
  hours: string;
  /** 提示文案（端上不自造，服务端下发） */
  tips: string;
  /** 在线客服接入模式（端上主按钮行为的**唯一依据**） */
  csMode: CustomerServiceMode;
  /** 微信客服企业 ID（仅 `wechat_kf` 有值） */
  csCorpId: string | null;
  /** 微信客服链接（仅 `wechat_kf` 有值） */
  csUrl: string | null;
}

/**
 * U17 · 客服入口配置（登录即可访问，不要求团长身份）
 *
 * @param options 透传给请求层：best-effort 旁路取数（如只为决定入口叫法）请传
 *                `{ keepAuthState: true }` —— 它无权裁决登录态的有效性，
 *                语义见 `api/request.ts` 的 `RequestOptions.keepAuthState`。
 *                ⚠️ 客服页 `pages/support/contact` 走主路径，保持默认。
 */
export function fetchSupportContact(
  options: { keepAuthState?: boolean } = {},
): Promise<SupportContact> {
  return http.get<SupportContact>('/me/support', options);
}
