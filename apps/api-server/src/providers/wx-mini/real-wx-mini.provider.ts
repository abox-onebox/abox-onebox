import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { WxAccessTokenService } from '../wx-access-token.service';
import {
  Code2SessionResult,
  PhoneNumberResult,
  UnlimitedQrcodeResult,
  WxMiniProvider,
} from './wx-mini.provider';

/**
 * 微信小程序 · 真实实现（PROVIDER_MODE=real）
 * 需在 .env 配好 WX_MINI_APPID / WX_MINI_SECRET
 */
@Injectable()
export class RealWxMiniProvider extends WxMiniProvider {
  private readonly logger = new Logger('WxMini:real');
  private readonly appId: string;
  private readonly appSecret: string;

  constructor(
    private readonly config: ConfigService,
    /**
     * ⚠️ 取手机号要 access_token，而微信 token 全局唯一 —— 这里**不能再自取**
     * （原先每次调用都打 `/cgi-bin/token`，用户每登录一次就把订阅消息侧的 token 顶掉一次，
     * 导致之后第一条通知必然 40001）。共用 `WxAccessTokenService` 的同一份缓存。
     */
    private readonly tokens: WxAccessTokenService,
  ) {
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
    let accessToken: string;
    try {
      accessToken = await this.tokens.get();
    } catch (e) {
      this.logger.error(`获取 access_token 失败：${e instanceof Error ? e.message : String(e)}`);
      throw new BizException(ErrorCode.INTERNAL_ERROR, '获取微信 access_token 失败');
    }

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

  async getUnlimitedQRCode(scene: string, width: number): Promise<UnlimitedQrcodeResult> {
    let accessToken: string;
    try {
      accessToken = await this.tokens.get();
    } catch (e) {
      this.logger.error(`获取 access_token 失败：${e instanceof Error ? e.message : String(e)}`);
      throw new BizException(ErrorCode.INTERNAL_ERROR, '获取微信 access_token 失败');
    }

    // scene 最长 32 个可见字符（微信硬限制）；调用方传的是团长邀请码 `LDR0001`，远小于此。
    // ⚠️ 必须指定 page 为邀请落地页：不传则微信默认跳首页，而首页不读 scene ⇒ 扫码用户绑不到团长。
    //    落地页直接把 scene 当邀请码读（2026-11-20 起 scene 与邀请码同源，旧 `l=<id>` 已废弃）。
    const { data, headers } = await axios.post(
      `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${accessToken}`,
      {
        scene,
        width,
        check_path: false,
        page: 'pages/leader-invite/leader-invite',
      },
      { responseType: 'arraybuffer', timeout: 10000 },
    );

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // ⭐ 微信失败时返回 JSON（errcode/errmsg）而非图片 —— 必须识别，否则会把错误 JSON
    //    当图片存下来，端上得到一张打不开的"图"。
    const contentType = String(headers?.['content-type'] ?? '');
    if (
      contentType.includes('application/json') ||
      (buf.length < 64 && buf.toString('utf-8').includes('errcode'))
    ) {
      let msg = '';
      try {
        msg = JSON.parse(buf.toString('utf-8'))?.errmsg ?? '';
      } catch {
        msg = buf.toString('utf-8').slice(0, 120);
      }
      this.logger.error(`getwxacodeunlimit 失败：${msg}`);
      throw new BizException(ErrorCode.INTERNAL_ERROR, '生成小程序码失败，请稍后重试');
    }

    return { buffer: buf, contentType: contentType || 'image/png' };
  }
}
