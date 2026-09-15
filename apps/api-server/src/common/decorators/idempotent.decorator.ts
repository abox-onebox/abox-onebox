/** 幂等键装饰器（下单 / 支付创建 · 《接口规范》§1.4） */
import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'abox:idempotent';

export interface IdempotentOptions {
  /** 业务域（用于拼 KV 键，如 `order` / `pay`），最终键形如 `idem:order:<key>` */
  scope: string;
  /** 结果缓存时长（秒），默认 600（§1.4：保留 10 分钟） */
  ttlSec?: number;
  /**
   * 是否强制要求请求头 `Idempotency-Key`（§1.7：下单/支付为「必填」）
   * 缺省 true —— 缺失即报 10001，避免端上漏传导致重复下单。
   */
  required?: boolean;
}

/**
 * 标记接口需幂等保护。
 *   · 首次请求：占用键 → 业务执行 → 结果写入缓存
 *   · 重复请求：返回 `code:10006`，`data` 携带**首次结果**（HTTP 200）
 *   · 处理中重复：返回 `code:10006`，提示「请勿重复提交」
 */
export const Idempotent = (options: IdempotentOptions) => SetMetadata(IDEMPOTENT_KEY, options);
