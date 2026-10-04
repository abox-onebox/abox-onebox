/**
 * 客服接入模式（`ab_config.service.cs_mode` · U17）
 *
 * 三档之间是**降级关系**，不是并列功能：越靠后越依赖外部开通，
 * 因此端上必须能在高档位「唤不起会话」时**自动退回下一档**，
 * 永远不让用户点到一个没反应的按钮。
 *
 * | 模式 | 通道 | 同事在哪接 | 前置 |
 * |---|---|---|---|
 * | `none` | 复制微信号 → 用户加好友 | 客服个人微信 | 无（**缺省**） |
 * | `contact` | 小程序原生客服消息 | 「客服小助手」小程序 | 后台添加客服人员 |
 * | `wechat_kf` | **微信客服** | **企业微信 App** | 企微开通微信客服 + 企业验证 + 小程序后台绑**同主体**企业 ID |
 *
 * ⭐ **2026-10-04 定为终态 = `wechat_kf`**：`contact` 那档的提醒不可靠
 * （服务通知常收不到、必须点进客服小助手才看到、客服要手动点「在线」），
 * 真实成本是**人力盯梢成本**且盯了仍会漏，故只能当过渡。
 * 前端对三档是**同一个按钮**，只是唤起方式不同 —— 所以先上哪档都不返工。
 *
 * ⚠️ 取值一律**小写下划线**，与 `ab_config` 落库值一致（同 `PayoutChannel` 的教训：
 * 枚举与落库值不符时，比较会**恒为 false 且不报错**）。
 *
 * ⚠️ 两条与本项目相关的口径：
 *   · 本项目 **C3 不取手机号** ⇒ 身份透传只有 `userId`（+微信昵称），**没有手机号尾号**；
 *   · 客服通道统一受 **48 小时 / 5 条**限制（用户发 1 条，客服 48h 内最多连回 5 条），
 *     `none` 档不受此限（加好友后是普通微信会话）。
 */
export enum CustomerServiceMode {
  /** 复制微信号人工加好友（缺省 · 兜底档） */
  NONE = 'none',
  /** 小程序原生客服消息（`<button open-type="contact">`） */
  CONTACT = 'contact',
  /** 微信客服（`wx.openCustomerServiceChat`，企业微信承接） */
  WECHAT_KF = 'wechat_kf',
}

/** 合法取值表 —— 供读侧兜底校验（库里可能被手改成任意字符串） */
export const SUPPORT_CS_MODES: readonly CustomerServiceMode[] = [
  CustomerServiceMode.NONE,
  CustomerServiceMode.CONTACT,
  CustomerServiceMode.WECHAT_KF,
];

export const CS_MODE_LABEL: Record<CustomerServiceMode, string> = {
  [CustomerServiceMode.NONE]: '复制微信号（兜底）',
  [CustomerServiceMode.CONTACT]: '小程序原生客服消息',
  [CustomerServiceMode.WECHAT_KF]: '微信客服（企业微信）',
};
