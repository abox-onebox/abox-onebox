import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/** 提前刷新窗口（秒）：微信给 7200s，提前 300s 换新，避免临界失效 */
const TOKEN_AHEAD_SECONDS = 300;

/**
 * 微信小程序 `access_token` 的**唯一持有者**
 *
 * ## 为什么必须集中成一处
 *
 * 微信的 `access_token` 是**全局唯一**的：同一 AppID 每取一次新 token，上一个立刻作废
 * （不是"两个都能用"，是"后取的把前一个顶掉"）。所以任何"各自持有自己的缓存"的写法，
 * 都会在并发时互相踢 —— A 侧刚取到，B 侧一取，A 手里的立刻变成 40001。
 *
 * 此前这个坑**已经存在**：`RealWxMiniProvider.getPhoneNumber()` 每次调用都去
 * `/cgi-bin/token` 取一次（用户每用手机号登录一次就顶一次），而
 * `RealWxNotifyProvider` 手里缓存着 token 发订阅消息。结果是登录高峰之后，
 * 第一次通知发送必然 40001（靠 `send()` 里的"失效重试一次"兜住，但多一次往返、
 * 日志里留一片假的 40001）。
 *
 * 现在三处（登录取手机号 / 订阅消息发送 / 模板校验）共用本服务的一份缓存。
 *
 * ## 三条实现约束（与原先 `RealWxNotifyProvider` 内联版本一致）
 *
 * 1. **缓存 + 提前刷新**：7200s 有效，提前 5 分钟换新，避开临界。
 * 2. **并发去重**：多个调用同时发现无 token 时，只发一次取 token 请求
 *    （否则一次批量发送会瞬间打出一串 `/cgi-bin/token`，还会互相顶掉）。
 * 3. **失效可清**：调用方遇到 40001/40014/42001 时调 `invalidate()`，
 *    下一次 `get()` 会重新取 —— 重试策略仍由调用方决定，本服务不替它重试。
 *
 * ⚠️ 不抛业务异常：未配置 appId/secret 时 `get()` 抛普通 Error，由调用方按各自
 *    语义收敛（发送侧收成 `{ ok:false }`，校验侧抛 `BizException`）。
 */
@Injectable()
export class WxAccessTokenService {
  private readonly logger = new Logger('WxAccessToken');
  private readonly appId: string;
  private readonly appSecret: string;

  private token: string | null = null;
  /** 毫秒时间戳；0 = 无有效缓存 */
  private tokenExpireAt = 0;
  /** 并发去重：多个调用同时发现无 token 时，只发一次取 token 请求 */
  private inflight: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>('wechat.mini.appId') ?? '';
    this.appSecret = this.config.get<string>('wechat.mini.appSecret') ?? '';
    if (!this.appId || !this.appSecret) {
      this.logger.warn(
        'WX_MINI_APPID / WX_MINI_SECRET 未配置，任何需要 access_token 的调用都会失败',
      );
    }
  }

  /** 是否具备调用条件（未配置时调用方可以给出更准确的提示，而不是笼统的"获取失败"） */
  get configured(): boolean {
    return Boolean(this.appId && this.appSecret);
  }

  async get(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpireAt) return this.token;
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** 主动作废（调用方撞到 40001/40014/42001 时使用） */
  invalidate(): void {
    this.token = null;
    this.tokenExpireAt = 0;
  }

  private async fetchToken(): Promise<string> {
    if (!this.appId || !this.appSecret) {
      throw new Error('WX_MINI_APPID / WX_MINI_SECRET 未配置');
    }

    const { data } = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: { grant_type: 'client_credential', appid: this.appId, secret: this.appSecret },
      timeout: 5000,
    });

    const token: string | undefined = data?.access_token;
    if (!token) {
      throw new Error(`获取 access_token 失败：errcode=${data?.errcode} errmsg=${data?.errmsg}`);
    }

    const ttl = Number(data?.expires_in ?? 7200);
    this.token = token;
    this.tokenExpireAt = Date.now() + Math.max(60, ttl - TOKEN_AHEAD_SECONDS) * 1000;
    this.logger.log(`access_token 已刷新（有效期 ${ttl}s）`);
    return token;
  }
}
