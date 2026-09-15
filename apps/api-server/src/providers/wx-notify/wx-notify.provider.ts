import { Injectable, Logger } from '@nestjs/common';

/**
 * 微信订阅消息能力抽象
 *   mock —— 只打日志 + 返回成功（业务侧仍会写 ab_message 落库，便于查记录）
 *   real —— 调 subscribeMessage.send（需 access_token 与模板 ID，二期补全）
 */
export const WX_NOTIFY_PROVIDER = Symbol('WX_NOTIFY_PROVIDER');

export interface SubscribeMessageInput {
  openid: string;
  templateId: string;
  page?: string;
  /** data 形如 { thing1: { value: '红烧肉' }, time2: { value: '11:30' } } */
  data: Record<string, { value: string }>;
}

export abstract class WxNotifyProvider {
  abstract get isMock(): boolean;
  abstract send(input: SubscribeMessageInput): Promise<{ ok: boolean; errMsg?: string }>;
}

@Injectable()
export class MockWxNotifyProvider extends WxNotifyProvider {
  private readonly logger = new Logger('WxNotify:mock');

  get isMock(): boolean {
    return true;
  }

  async send(input: SubscribeMessageInput): Promise<{ ok: boolean; errMsg?: string }> {
    this.logger.log(
      `[mock] 订阅消息 openid=${input.openid} template=${input.templateId || '(未配置)'} page=${input.page ?? '-'} data=${JSON.stringify(input.data)}`,
    );
    return { ok: true };
  }
}
