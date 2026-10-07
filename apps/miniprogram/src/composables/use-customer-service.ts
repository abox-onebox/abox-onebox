/**
 * use-customer-service —— U17 客服会话的**唤起层**
 *
 * ## 为什么单独抽一层
 * 客服通道有三个「平台才有的能力」，且它们的触发方式**互不相同**：
 *
 * | 模式 | 唤起方式 | 能不能用 JS 直接调 |
 * |---|---|---|
 * | `wechat_kf` | `wx.openCustomerServiceChat()` | ✅ 能（但必须在用户手势内） |
 * | `contact` | `<button open-type="contact">` | ❌ **不能** —— 只能由真实按钮点击触发 |
 * | `none` | 复制微信号 | ✅ |
 *
 * `contact` 这条限制决定了：**模式切换不是改一个函数，而是页面要渲染不同的节点**。
 * 本层把「能不能唤起、唤起了没有、失败原因」收敛成一个 Promise，页面只管按 `csMode` 渲染。
 *
 * ## 平台探测（沿用 `use-subscribe-message` 的写法）
 * 不在代码里直接写 `wx.xxx` —— 一是 TS 里没有它的类型，二是 H5 / 单元测试环境下它不存在。
 * 这里用**最小形状**描述需要的入参，运行时从全局探测，取不到就返回「不可用」，
 * **让调用方走降级**，而不是抛异常炸掉页面。
 *
 * ⚠️ 开发者工具里客服会话**不生效**，必须真机 + 体验版验证。
 */
// ⚠️ 2026-10-07 起**不是** `import type`：`csEntryLabel` 要用 `CustomerServiceMode.WECHAT_KF`
//    这类**枚举值**做比较（`import type` 只能当类型用，取不到值）。
//    ⛔ 别改回 `import type`，也别为了绕开它去写 `'wechat_kf'` 字面量 —— 那会让
//    `dup:const` 判成「真源字面量外溢」。
import { CustomerServiceMode } from '@abox/shared-types';

/** `wx.openCustomerServiceChat` 的入参最小形状（避免依赖 types 包的具体版本） */
export interface OpenCustomerServiceChatOptions {
  /** 企业 ID（企微「我的企业」页底部） */
  corpId: string;
  /**
   * ⭐⭐ 客服链接 **必须放在 `extInfo` 里**，不能放顶层。
   * 官方文档示例即 `wx.openCustomerServiceChat({ extInfo: {url: ''}, corpId: '', ... })`；
   * 服务市场排障贴把「`fail invalid param: url`」的头号原因直接归为「`extInfo` 拼错/缺失」。
   * （2026-10-04 彻底复查时发现本文件曾把 url 传在顶层 ⇒ 真机必 fail，已改。）
   */
  extInfo: { url: string };
  /** 是否自动发送小程序卡片（客服点卡片可直达订单页） */
  showMessageCard?: boolean;
  /** 卡片标题 */
  sendMessageTitle?: string;
  /** 卡片点开的小程序路径 · ⚠️ 见 `KF_PATH_SUFFIX` */
  sendMessagePath?: string;
  /** 卡片缩略图 */
  sendMessageImg?: string;
  success?: (res: { errMsg?: string }) => void;
  fail?: (err: { errMsg?: string; errCode?: number }) => void;
}

type OpenCustomerServiceChatFn = (options: OpenCustomerServiceChatOptions) => void;

/**
 * ⚠️ 已知坑：`sendMessagePath` 的路径**必须带 `.html` 后缀**
 * （如 `/pages/order-detail/order-detail.html`），不带会提示「页面不存在」。
 * 集中成一个常量，万一微信改口径只改这一处。
 */
const KF_PATH_SUFFIX = '.html';

/** 卡片标题里透传的身份前缀（客服看到的第一眼信息） */
function cardTitle(orderNo?: string, userId?: number): string {
  const who = userId ? `用户${userId}` : '用户';
  return orderNo ? `${who} · 订单 ${orderNo}` : `${who} 的咨询`;
}

/**
 * 卡片点开要跳的小程序路径
 *
 * ⚠️ `.html` 加在**路径末尾、query 之前**（`/pages/x/x.html?k=v`）。
 * @param orderNo 有值时直达该订单详情；无值则回首页
 */
export function buildCardPath(orderNo?: string): string {
  const base = `/pages/order-detail/order-detail${KF_PATH_SUFFIX}`;
  return orderNo ? `${base}?orderNo=${encodeURIComponent(orderNo)}` : base;
}

/**
 * `contact` 模式的 `session-from`
 *
 * 用户在客服小助手里会看到这段来源信息 —— 否则客服第一句必然是「请问你是哪位」。
 * ⚠️ 本项目 **C3 不取手机号**，所以这里只能带 userId（+订单号），**没有手机号尾号**。
 */
export function buildSessionFrom(orderNo?: string, userId?: number): string {
  const parts = ['ABox'];
  if (userId) parts.push(`用户${userId}`);
  if (orderNo) parts.push(`订单${orderNo}`);
  return parts.join(' · ');
}

/** 取平台实现（H5 / 非微信小程序环境下为 `undefined`） */
function kfApi(): OpenCustomerServiceChatFn | undefined {
  const scope = globalThis as unknown as {
    wx?: { openCustomerServiceChat?: OpenCustomerServiceChatFn };
  };
  const fn = scope.wx?.openCustomerServiceChat;
  return typeof fn === 'function' ? fn.bind(scope.wx) : undefined;
}

/** 当前环境是否具备微信客服唤起能力 */
export function canOpenCustomerServiceChat(): boolean {
  return kfApi() !== undefined;
}

export interface OpenKfParams {
  corpId: string;
  url: string;
  /** 当前订单号（有值时客服收到带订单的卡片） */
  orderNo?: string;
  userId?: number;
}

export interface OpenKfResult {
  /** 是否成功唤起客服会话 */
  ok: boolean;
  /** 失败原因（给用户看的简短原因，同时也是降级依据） */
  reason: 'unsupported' | 'fail' | null;
  /** 原始 errMsg（仅排查用，不展示给用户） */
  errMsg?: string;
}

/**
 * 唤起微信客服会话
 *
 * ⭐ **永不抛异常** —— 拿不到能力就回 `{ ok: false, reason: 'unsupported' }`，
 * 由页面退回「复制微信号」。这条是 U17 的底线：**不能出现点了没反应的按钮**。
 *
 * @param params.corpId / params.url 由服务端下发（`ab_config`），端上不得硬编码
 */
export function openCustomerServiceChat(params: OpenKfParams): Promise<OpenKfResult> {
  const api = kfApi();
  if (!api) return Promise.resolve({ ok: false, reason: 'unsupported' });

  return new Promise<OpenKfResult>((resolve) => {
    api({
      corpId: params.corpId,
      // ⭐ 见 `OpenCustomerServiceChatOptions.extInfo`：url 只能走 extInfo，顶层传会被判 invalid param
      extInfo: { url: params.url },
      // 自动发一张卡片给客服：点开直达订单页，省掉「你是哪位、订单号多少」两轮往返
      showMessageCard: true,
      sendMessageTitle: cardTitle(params.orderNo, params.userId),
      sendMessagePath: buildCardPath(params.orderNo),
      success: () => resolve({ ok: true, reason: null }),
      fail: (err) =>
        resolve({
          ok: false,
          reason: 'fail',
          errMsg: err?.errMsg ?? 'openCustomerServiceChat fail',
        }),
    });
  });
}

/**
 * 主按钮文案（服务端只下发模式，文案端上给 —— 但**不硬编码任何联系方式**）
 */
export function csActionLabel(mode: CustomerServiceMode): string {
  if (mode === 'wechat_kf') return '发起在线咨询';
  if (mode === 'contact') return '联系在线客服';
  return '复制微信号';
}

/**
 * ⭐ **入口标题**（与 `csActionLabel` 分开：动作 vs 名词，别混用）
 *
 * 用在「我的」页菜单项与设置面板这类**入口**上 —— 那里要的是「这个入口叫什么」，
 * 不是「点了会发生什么」（后者才是 `csActionLabel`，它的 `none` 档是「复制微信号」，
 * 当菜单标题读起来很怪）。
 *
 * ⭐⭐ 为什么必须随 `csMode` 变（2026-10-07 裁定）：
 *   入口写死「客服微信号」时，一旦切到 `wechat_kf` / `contact` 档，
 *   用户点进去看到的是**在线客服**，入口与落地页对不上；更糟的是协议里已改为中性的
 *   「我的 → 联系客服」，入口却仍写「客服微信号」⇒ 同一条路两种叫法。
 *
 * ⭐ 取不到（`null` / 未加载 / 请求失败）时返回**中性**的「联系客服」——
 *   与协议正文措辞一致，任何档位下都成立（不回落成写死的某一档形态）。
 */
export function csEntryLabel(mode: CustomerServiceMode | null | undefined): string {
  if (mode === CustomerServiceMode.WECHAT_KF) return '在线客服';
  if (mode === CustomerServiceMode.CONTACT) return '在线客服';
  if (mode === CustomerServiceMode.NONE) return '客服微信号';
  return '联系客服';
}
