/**
 * ABox 一盒 · 运行时色值（JS 侧）
 *
 * ⚠️ 本文件由 `_tmp/icons/gen-tokens.py` 从 `design-tokens.json` 派生，**不要手改**。
 *    开放给 JS 的只有「平台 API 参数必须吃字面量」的那几个键
 *    （如 `uni.showModal({ confirmColor })`）——
 *    凡 CSS 能表达的一律走 `tokens.scss`，不要从这里取色。
 */

export const ABOX_RUNTIME_COLORS = {
  warning: '#c44536',
  success: '#5b7c3a',
  info: '#4a6fa5',
  text: '#6e5435',
  bg: '#f6f0e5',
  surface: '#fffdf8',
  gold: '#c9a876',
} as const;

export type AboxRuntimeColor = keyof typeof ABOX_RUNTIME_COLORS;
