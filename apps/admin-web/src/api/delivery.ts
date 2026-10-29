import { http } from './request';

/**
 * api/delivery —— 运营后台配送单（M5-1 · D61 查看 / D62 人工修正 / M5-8 · D63 状态推进）
 *
 * ⚠️ 本文件走 `/admin/deliveries`，主体是**运营后台账号**
 *    （`role ∈ {super_admin, admin, operator}`）—— 与团长端 L8 的
 *    `/leader/orders/*`（配送状态只读展示）不是一回事。
 *
 * ⚠️ 类型在此**只作端上约束**，权威契约见《接口规范 v1.0》D61/D62/D63 与
 *    服务端 `modules/delivery/dto/delivery.dto.ts`。配送状态的中文文案
 *    **由服务端下发**（`statusText` / `statusOptions`），
 *    端上不维护第二份映射（与 `@abox/shared-types` 的 `DELIVERY_STATUS_LABEL` 同源）。
 */

/** 可人工修正的字段快照（D62 的 `before` / `after`） */
export interface DeliverySnapshot {
  totalQuantity: number;
  driverName: string | null;
  driverPhone: string | null;
  plateNo: string | null;
  remark: string | null;
}

export interface DeliveryRow extends DeliverySnapshot {
  id: number;
  mealDate: string;
  buildingGroupId: number;
  buildingGroupName: string | null;
  expectedAt: string | null;
  actualAt: string | null;
  /** 按订单算出的份数（口径同备料量） */
  orderQuantity: number;
  /** `totalQuantity - orderQuantity` */
  quantityDiff: number;
  /** 份数与订单不符 —— ⚠️ **不等于「被人改过」**，成因见 `note` */
  quantityMismatch: boolean;
  /** 有人工录入痕迹（可靠标记：跑批从不写这四列） */
  hasManualInput: boolean;
  status: string;
  statusText: string;
  /** 乐观锁版本 —— D62 提交 / D63 推进时**原样回传** */
  version: number;
  /**
   * ⭐ 该楼群当日订单的**状态分布**（M5-8 新增 · 履约链可见性）
   *
   * 配送单状态与订单状态是**两条链**（T8/T9 才把它们接上）。只看配送单的「在途」，
   * 运营无法知道这批货对应的订单有没有跟上 —— 而「没跟上」的表现是
   * **订单永远停在 `cut_off`、佣金永不产生、且不报任何错**（#79）。
   * 把它摆在每一行上，「有几单没跟上」就从「一个看不见的洞」变成「列表里的一行」。
   * 份数之和恒等于 `orderQuantity`（服务端同源聚合，端上不重算）。
   */
  orderStatusBreakdown: Array<{
    status: string;
    statusText: string;
    orderCount: number;
    quantity: number;
  }>;
}

export interface DeliveryListResult {
  date: string | null;
  list: DeliveryRow[];
  summary: {
    count: number;
    totalQuantity: number;
    totalOrderQuantity: number;
    mismatchCount: number;
    manualInputCount: number;
    byStatus: Array<{ status: string; statusText: string; count: number }>;
  };
  /** 还没有任何配送单时的说明（HTTP 200 · 正常状态，不是错误） */
  reason?: string;
  /** 口径说明（服务端下发 · 端上原样展示，不复制第二份文案） */
  note: string;
  /** 状态筛选下拉的权威顺序（端上不自己排） */
  statusOptions: Array<{ value: string; label: string }>;
}

export interface DeliveryPatchResult {
  id: number;
  before: DeliverySnapshot;
  after: DeliverySnapshot;
  changed: string[];
  unchanged: string[];
  version: number;
  quantityDiff: number;
  orderQuantity: number;
}

export interface DeliveryListQuery {
  date?: string;
  buildingGroupId?: number;
  status?: string;
}

/** D62 提交体（`version` 与 `reason` 必填） */
export interface DeliveryPatchBody {
  version: number;
  reason: string;
  totalQuantity?: number;
  driverName?: string;
  driverPhone?: string;
  plateNo?: string;
  remark?: string;
}

export const fetchDeliveries = (q: DeliveryListQuery = {}) =>
  http.get<DeliveryListResult>('/admin/deliveries', q);

export const patchDelivery = (id: number, body: DeliveryPatchBody) =>
  http.put<DeliveryPatchResult>(`/admin/deliveries/${id}`, body);

// ------------------------------------------------------------------ D63 推进

/**
 * D63 提交体
 *
 * ⚠️ **不传 `from`**：端上那份快照可能已经过期，服务端**本来就以库里的当前值为准**。
 *    真正要防的「快照过期」由 `version` 承担（与 D62 同一机制、同一错误码 `30016`）。
 * ⚠️ `to` **只能是紧邻的下一态**（跳级 → `30018`）：每一步各自联动订单
 *    （`en_route` → T8、`arrived` → T9），跳级会静默跳过 T8。
 */
export interface DeliveryAdvanceBody {
  to: string;
  version: number;
  /** 可选补充（如「堵车晚点 20 分钟」），写入操作日志 */
  note?: string;
}

/**
 * D63 出参
 *
 * ⭐ `orderTransition` 把「配送单推进了」与「订单跟着动了没」放在**同一个响应**里 ——
 *    否则会出现「车开走了、系统里的订单原地不动，两边都不报错」。
 * ⚠️ `called`（已叫车）时它是 `null`：货还在加工场所，订单**本就不该动**，
 *    不是「联动失败」—— 端上必须把这个区别表达出来。
 */
export interface DeliveryAdvanceResult {
  id: number;
  mealDate: string;
  buildingGroupId: number;
  buildingGroupName: string | null;
  from: string;
  fromText: string;
  to: string;
  toText: string;
  /** 推进后的新版本号（端上用它刷新本地快照） */
  version: number;
  actualAt: string | null;
  orderTransition: {
    from: string;
    fromText: string;
    to: string;
    toText: string;
    /** 本次真的被推进的订单数 */
    advanced: number;
    /** 推进后该楼群当日订单的状态分布 */
    remaining: Array<{ status: string; statusText: string; orderCount: number; quantity: number }>;
    /** `advanced = 0` 而订单还在原地时，给人看的原因（不静默） */
    note?: string;
  } | null;
  note: string;
}

export const advanceDeliveryStatus = (id: number, body: DeliveryAdvanceBody) =>
  http.patch<DeliveryAdvanceResult>(`/admin/deliveries/${id}/status`, body);

// ============================================================
// Q3 送达凭证（2026-10-29 补 —— 此前表与接口已上线、两端零引用）
// ============================================================
//
// ⚠️ 为什么这时才补：此前 `ab_delivery_proof` 有表有接口有单测，但没有一处 UI 调用它
//    ⇒ 凭证永远不会产生，举证目的落空（《提审前最后一公里复核》把它钉了出来）。
//
// ⛔ 端上**不维护** `kind` 的中文映射 —— 服务端下发 `kindText`
//    （与 `statusText` 同纪律：两套映射迟早会说不一样的话）。
//
// ⛔ scope 是三态**字符串**（`alive`/`deleted`/`all`），不是布尔 ——
//    query 里的布尔串经转型会把 `false` 变成 `true`，是「传了 false 却筛出全部」的经典陷阱。

/** 一张凭证（字段与服务端 `toProofItem()` 逐项对齐） */
export interface DeliveryProofItem {
  id: number;
  deliveryRecordId: number;
  url: string;
  kind: string;
  /** 类型中文（服务端下发） */
  kindText: string;
  remark: string | null;
  uploadedBy: number | null;
  createdAt: string | null;
  /** 已撤销时刻（`null` = 有效） */
  revokedAt: string | null;
}

export interface DeliveryProofListResult {
  deliveryRecordId: number;
  scope: string;
  list: DeliveryProofItem[];
  count: number;
  /** 该单名下**有效**凭证张数（即使 `scope` 不是 alive 也真实回查） */
  aliveCount: number;
  note: string;
}

/** `kind` 三选一；非法值服务端静默取缺省 `photo`（不嘲讽拼错的枚举值） */
export interface DeliveryProofCreateBody {
  url: string;
  kind?: 'photo' | 'sign' | 'other';
  remark?: string;
}

export const fetchDeliveryProofs = (
  deliveryId: number,
  scope: 'alive' | 'deleted' | 'all' = 'alive',
) => http.get<DeliveryProofListResult>(`/admin/deliveries/${deliveryId}/proofs`, { scope });

/**
 * 先走通用上传拿到 url —— 上传是**通用能力**（商品图 / 证照都走它），
 * 「这张图属于哪张配送单」才是配送域的事（详见 media.controller.ts 的设计说明）。
 *
 * 注意：**不需要**手动设 Content-Type —— axios 遇到 FormData 会自动走 multipart，
 * 且 `request.ts` 的幂等键生成器对 FormData 返回 null（天然可重放）。
 */
export const uploadDeliveryMedia = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return http.post<{ url: string }>('/admin/uploads', form);
};

export const addDeliveryProof = (deliveryId: number, body: DeliveryProofCreateBody) =>
  http.post<DeliveryProofItem>(`/admin/deliveries/${deliveryId}/proofs`, body);

/** 软删 —— 行仍保留（「曾经存在、被谁撤了」本身是审计事实） */
export const revokeDeliveryProof = (deliveryId: number, proofId: number) =>
  http.delete<{ id: number; deliveryRecordId: number }>(
    `/admin/deliveries/${deliveryId}/proofs/${proofId}`,
  );
