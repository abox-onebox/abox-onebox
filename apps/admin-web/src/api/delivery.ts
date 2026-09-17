import { http } from './request';

/**
 * api/delivery —— 运营后台配送单（M5-1 · D61 查看 / D62 人工修正）
 *
 * ⚠️ 本文件走 `/admin/deliveries`，主体是**运营后台账号**
 *    （`role ∈ {super_admin, admin, operator}`）—— 与团长端 L8 的
 *    `/leader/orders/*`（配送状态只读展示）不是一回事。
 *
 * ⚠️ 类型在此**只作端上约束**，权威契约见《接口规范 v1.0》D61/D62 与
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
  /** 乐观锁版本 —— D62 提交时**原样回传** */
  version: number;
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
