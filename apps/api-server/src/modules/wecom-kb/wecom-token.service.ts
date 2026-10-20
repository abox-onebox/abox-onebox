import { Injectable, Logger } from '@nestjs/common';

/**
 * 企业微信 access_token 获取 + 文本消息下发
 *
 * 走官方 HTTP API（qyapi.weixin.qq.com），不依赖 WorkBuddy 企业微信连接器——
 * 连接器是便利性封装，bot 核心逻辑用官方 API 即可独立运行。
 * 凭据：WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET。
 *
 * access_token 按 expires_in 缓存，提前 5 分钟刷新，避免临界失效。
 */
@Injectable()
export class WecomTokenService {
  private readonly logger = new Logger(WecomTokenService.name);
  private cache: { token: string; expireAt: number } | null = null;

  private need(name: string): string {
    const v = process.env[name];
    if (!v?.trim()) throw new Error(`企业微信凭据缺失：${name}（建应用后在企业微信后台获取，写入 .env）`);
    return v;
  }

  async getAccessToken(): Promise<string> {
    if (this.cache && this.cache.expireAt > Date.now()) return this.cache.token;
    const corpid = this.need('WECOM_CORP_ID');
    const corpsecret = this.need('WECOM_SECRET');
    const url =
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}` +
      `&corpsecret=${encodeURIComponent(corpsecret)}`;
    const resp = await fetch(url);
    const json = (await resp.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
    if (json.errcode) {
      throw new Error(`企业微信获取 access_token 失败 errcode=${json.errcode} errmsg=${json.errmsg}`);
    }
    const token = json.access_token as string;
    const expire = (json.expires_in as number) || 7200;
    this.cache = { token, expireAt: Date.now() + (expire - 300) * 1000 };
    this.logger.log('企业微信 access_token 已刷新');
    return token;
  }

  /** 主动下发文本消息给指定 userid（回调处理完异步发送，避免 5s 超时重试） */
  async sendText(userId: string, content: string): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const agentid = Number(this.need('WECOM_AGENT_ID'));
      const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`;
      const body = { touser: userId, msgtype: 'text', agentid, text: { content } };
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await resp.json()) as { errcode?: number; errmsg?: string };
      if (json.errcode) {
        this.logger.error(`企业微信发消息失败 touser=${userId} errcode=${json.errcode} errmsg=${json.errmsg}`);
      } else {
        this.logger.log(`企业微信消息已下发 touser=${userId}`);
      }
    } catch (e) {
      this.logger.error(`企业微信发消息异常 touser=${userId}：${(e as Error).message}`);
    }
  }
}
