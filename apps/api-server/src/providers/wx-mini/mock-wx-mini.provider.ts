import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

import { Code2SessionResult, PhoneNumberResult, WxMiniProvider } from './wx-mini.provider';

/**
 * 微信小程序 · 本地假实现
 *
 * 设计要点：
 *  1. **稳定映射**：同一 code 恒定映射出同一 openid（sha1 摘要），反复登录得到同一账号；
 *  2. **可指定身份**：code 形如 `dev:1001` 时直接使用 `1001` 作为 openid 后缀，
 *     方便本地构造「老用户 / 团长 / 新用户」三类测试账号；
 *  3. 不发起任何网络请求。
 */
@Injectable()
export class MockWxMiniProvider extends WxMiniProvider {
  private readonly logger = new Logger('WxMini:mock');
  private readonly prefix: string;

  constructor(private readonly config: ConfigService) {
    super();
    this.prefix = this.config.get<string>('app.mock.wxOpenidPrefix') ?? 'mock_openid_';
  }

  get isMock(): boolean {
    return true;
  }

  async code2Session(code: string): Promise<Code2SessionResult> {
    const openid = this.toOpenid(code);
    this.logger.debug(`[mock] code2Session code=${code} → openid=${openid}`);
    return {
      openid,
      unionid: `mock_unionid_${openid}`,
      sessionKey: 'mock_session_key',
    };
  }

  async getPhoneNumber(_code: string): Promise<PhoneNumberResult> {
    // 固定返回一个测试号码，便于团长申请 / 绑定手机号流程联调
    this.logger.debug('[mock] getPhoneNumber → 13800138000');
    return {
      phoneNumber: '+86 13800138000',
      purePhoneNumber: '13800138000',
      countryCode: '86',
    };
  }

  /** code → 稳定 openid */
  private toOpenid(code: string): string {
    const explicit = /^dev:(.+)$/.exec(code);
    if (explicit) return `${this.prefix}${explicit[1]}`;
    return `${this.prefix}${createHash('sha1').update(code).digest('hex').slice(0, 16)}`;
  }
}
