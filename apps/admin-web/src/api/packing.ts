import { http } from './request';

/**
 * api/packing —— **运营后台**加工场所打包任务（原供应商端 S3 · M4-0 迁后台）
 *
 * ⚠️ 与 `api/supplier-portal.ts`（**供应商端** `/supplier/*`）**不是一回事**：
 *    本文件走 `/admin/packing-tasks`，主体是运营后台账号（`role ∈ {super_admin, admin, operator}`）。
 *
 * ⚠️ 为什么从供应商端迁走：打包闸门必须看到**所有**供应商的到位情况，
 *    一次查询天然包含他方的到货明细 —— 开给供应商就是泄露他方经营数据（I1）。
 *    供应商端原 `GET /supplier/packing-tasks` 已随自营口径**整条路由删除**（→ 10004）。
 *
 * ⚠️ 金额出参一律**整数分**（`Fen` 结尾）。
 */

export interface PackingDish {
  supplierId: number;
  supplierName: string;
  dishId: number;
  dishName: string;
  unitPriceFen: number;
  planQuantity: number;
  actualQuantity: number | null;
  status: string;
  confirmedAt: string | null;
}

export interface PackingCenter {
  centerId: number;
  centerName: string;
  centerAddress: string;
  contactName: string | null;
  contactPhone: string | null;
  /** 该场所当日所有菜品均已确认送达 —— 未到齐不要开包 */
  ready: boolean;
  blockers: Array<{ supplierName: string; dishName: string; planQuantity: number; status: string }>;
  dishes: PackingDish[];
  routes: Array<{
    routeNo: string | null;
    buildingGroupId: number;
    groupName: string;
    quantity: number;
    stops: Array<{ buildingId: number; buildingName: string; address: string }>;
  }>;
  summary: {
    batchQuantity: number;
    routeCount: number;
    stopCount: number;
    dishCount: number;
    confirmedDishCount: number;
  };
}

export interface PackingData {
  /** 没有任何启用中的加工场所时返回 false（「没有这项任务」是正常状态，不是错误） */
  visible: boolean;
  reason?: string;
  date: string | null;
  centers: PackingCenter[];
  notes?: Record<string, string>;
}

export const fetchPackingTasks = (date?: string) =>
  http.get<PackingData>('/admin/packing-tasks', date ? { date } : undefined);
