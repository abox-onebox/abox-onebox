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
  /**
   * 场景键（**仅用于日志**，不参与发送）
   *
   * 6 个场景共用一条发送通道，排障时「哪条通知失败了」只能靠 scene 认 ——
   * 没有它，日志里就只剩一串互相看不出区别的 templateId。
   */
  scene?: string;
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
      `[mock] 订阅消息 scene=${input.scene ?? '-'} openid=${input.openid} template=${input.templateId || '(未配置)'} page=${input.page ?? '-'} data=${JSON.stringify(input.data)}`,
    );
    // ⚠️ mock 恒返回成功（不返回 errMsg —— `ok:true` 配一条错误说明会自相矛盾，
    //    也会被上层当成"发送成功但有问题"）。生产环境**绝不能**落到这里：
    //    否则 `ab_message` 会写满 status=success 而微信一条都没收到
    //    （2026-11-18 之前的线上正是这个状态，见 `RealWxNotifyProvider` 头注）。
    return { ok: true };
  }
}
