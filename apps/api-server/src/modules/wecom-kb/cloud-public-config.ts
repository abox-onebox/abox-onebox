/**
 * ABox 一盒 · 云服务 publicConfig（AI 编排节点 D · 智能客服 LLM 来源）
 * ------------------------------------------------------------------
 * 来源：workbuddy_cloud_service activate
 *   应用：ABox内部助手（applicationId: wbapp_dFBh87mqVSTg0akdyqVy4d，云服务 ACTIVE）
 *   endpoint 即该应用的发布域 data-plane base URL。
 *
 * 安全：publishableKey 是【公钥】，仅标识应用、不携带任何权限，官方允许随代码分发
 *       （"may be shipped inside the app's front-end code"）。切勿在此写入任何私钥 / 密码 / 令牌。
 * 维护：若重新激活或更换应用，请重新执行 activate 并覆盖本文件的 endpoint / publishableKey。
 */
export const cloudPublicConfig = {
  endpoint: 'https://abox-kb.app.workbuddy.host',
  publishableKey: 'wbpk_dFBh87mqVSTg0akdyqVy4d_VDzI7pTxkk40jl95zzDUclowbv16lVNs',
} as const;

export type CloudPublicConfig = typeof cloudPublicConfig;
