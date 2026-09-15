import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { Code2SessionResult, PhoneNumberResult, WxMiniProvider } from './wx-mini.provider';

/**
 * 微信小程序 · 真实实现（PROVIDER_MODE=real）
 * 需在 .env 配好 WX_MINI_APPID / WX_MINI_SECRET
 */
@Injectable()
export class RealWxMiniProvider extends WxMiniProvider {
  private readonly logger = new Logger('WxMini:real');
  private readonly appId: string;
  private readonly appSecret: string;

  constructor(private readonly config: ConfigService) {
    super();
    this.appId = this.config.get<string>('wechat.mini.appId') ?? '';
    this.appSecret = this.config.get<string>('wechat.mini.appSecret') ?? '';
    if (!this.appId || !this.appSecret) {
      this.logger.warn('WX_MINI_APPID / WX_MINI_SECRET 未配置，真实登录将失败');
    }
  }

  get isMock(): boolean {
    return false;
  }

  async code2Session(code: string): Promise<Code2SessionResult> {
    const url = 'https://api.weixin.qq.com/sns/jscode2session';
    const { data } = await axios.get(url, {
      params: {
        appid: this.appId,
        secret: this.appSecret,
        js_code: code,
        grant_type: 'authorization_code',
      },
      timeout: 5000,
    });

    if (!data?.openid) {
      this.logger.error(`jscode2session 失败：errcode=${data?.errcode} errmsg=${data?.errmsg}`);
      // §九 20001：code2session 失败 = 微信登录凭证失效（非「未登录」，不可映射 10002）
      throw new BizException(ErrorCode.WX_CODE_INVALID);
    }

    return {
      openid: data.openid,
      unionid: data.unionid,
      sessionKey: data.session_key,
    };
  }

  async getPhoneNumber(code: string): Promise<PhoneNumberResult> {
    // 需先用 code2Session 取得的 access_token；此处按正式实现补全
    const tokenRes = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: { grant_type: 'client_credential', appid: this.appId, secret: this.appSecret },
      timeout: 5000,
    });
    const accessToken: string | undefined = tokenRes.data?.access_token;
    if (!accessToken)
      throw new BizException(ErrorCode.INTERNAL_ERROR, '获取微信 access_token 失败');

    const { data } = await axios.post(
      `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${accessToken}`,
      { code },
      { timeout: 5000 },
    );
    const info = data?.phone_info;
    if (!info?.phoneNumber) {
      throw new BizException(ErrorCode.PARAM_INVALID, '获取手机号失败');
      // 注：手机号获取失败属入参/凭证问题，非业务码，保持 10001 不占用号段
    }
    return {
      phoneNumber: info.phoneNumber,
      purePhoneNumber: info.purePhoneNumber,
      countryCode: info.countryCode,
    };
  }
}
