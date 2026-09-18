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
