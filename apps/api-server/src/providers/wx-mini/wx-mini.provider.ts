/**
 * 微信小程序能力抽象
 *   mock —— 无需 AppID/Secret，code 稳定映射出同一 openid，便于本地反复登录
 *   real —— 真实调用微信 jscode2session
 */
export const WX_MINI_PROVIDER = Symbol('WX_MINI_PROVIDER');

export interface Code2SessionResult {
  openid: string;
  unionid?: string;
  sessionKey: string;
}

export interface PhoneNumberResult {
  phoneNumber: string;
  purePhoneNumber: string;
  countryCode: string;
}

export abstract class WxMiniProvider {
  /** 登录凭证校验：code → openid + session_key */
  abstract code2Session(code: string): Promise<Code2SessionResult>;

  /** 手机号快速验证（button open-type=getPhoneNumber） */
  abstract getPhoneNumber(code: string): Promise<PhoneNumberResult>;

  /** 是否 mock 实现（供调试端点判定是否放行「模拟登录」） */
  abstract get isMock(): boolean;
}
