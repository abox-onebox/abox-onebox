/**
 * api/leader-order —— 团长端「订单域」（M2 · L4–L9）
 * 契约：《接口规范 v1.0》§4.3「团长订单」/ §4.2「代退申请」
 *
 * 与 `api/leader.ts`（身份 / 资料 / 工作台 / 分享）、`api/leader-finance.ts`
 * （佣金 / 余额 / 提现）按**后端模块边界**拆分，避免单文件膨胀。
 *
 * ⚠️ 全部端点都需**在职团长**身份：服务端 `LeaderGuard` 在 JWT 之后再查一次
 *    `ab_team_leader`，故端上不能用本地缓存的 `isLeader` 当授权凭据。
 * ⚠️ 手机号脱敏纪律（§1.6）：列表出参一律 `138****0007`；**仅 L5 导出**
 *    返回完整号，且服务端会写 `ab_operation_log` 留痕 —— 端上不得私自缓存明文。
 */
import { OrderStatus } from '@abox/shared-types';
import type { LeaderLevel, RefundReasonType } from '@abox/shared-types';

import { http, query } from './request';

// ---------------------------------------------------------------------------
// 公共：团长视角订单行（L4 / L6 / L8 共用同一视图）
// ---------------------------------------------------------------------------

/** 团长视角订单行（手机号已脱敏） */
export interface LeaderOrderItem {
  orderNo: string;
  /** 用户昵称 */
  userName: string | null;
  /** ⚠️ 已脱敏，如 `138****0007`；无手机号 → null */
  phoneMasked: string | null;
  quantity: number;
  /** 整数分 */
  unitPriceFen: number;
  /** 整数分 */
  totalAmountFen: number;
  /** 微信实付（整数分） */
  payAmountFen: number;
  status: OrderStatus;
  /** 团长视角状态文案（服务端三视角映射，端上不自行拼） */
  statusText: string;
  /** 出餐日 `YYYY-MM-DD` */
  mealDate: string;
  remark: string | null;
  /** UTC ISO（Date 序列化，`....Z`） */
  createdAt: string;
  /** UTC ISO；未完成 → null */
  completedAt: string | null;
}

/** 分页返回（§1.3 统一结构：`hasMore` 由服务端给，端上不自行推算） */
export interface LeaderOrdersData {
  /** 实际生效的出餐日（回显，便于端上校验） */
  mealDate: string;
  list: LeaderOrderItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface LeaderOrdersQuery {
  /** 缺省 = 北京时间今日 */
  mealDate?: string;
  /** 缺省 = 全部 */
  status?: string;
  /** 订单号模糊匹配，≤32 */
  keyword?: string;
  page?: number;
  pageSize?: number;
}

/** L4 · 所辖订单列表（本团 + 本楼未归属订单；手机号脱敏） */
export function fetchLeaderOrders(params: LeaderOrdersQuery = {}): Promise<LeaderOrdersData> {
  return http.get<LeaderOrdersData>(
    `/leader/orders${query({
      mealDate: params.mealDate,
      status: params.status,
      keyword: params.keyword,
      page: params.page,
      pageSize: params.pageSize,
    })}`,
  );
}

/** L5 · 导出订单明细（**含完整手机号** + 服务端写操作日志） */
export interface LeaderExportData {
  fileName: string;
  mealDate: string;
  count: number;
  /** 固定 8 列：订单号 / 用户昵称 / 手机号 / 份数 / 金额(元) / 状态 / 备注 / 下单时间 */
  headers: string[];
  /** 每行 8 个**字符串**（含份数与金额；金额是「元」字符串，不是分） */
  list: string[][];
}

export function exportLeaderOrders(params: { mealDate?: string } = {}): Promise<LeaderExportData> {
  return http.get<LeaderExportData>(`/leader/orders/export${query({ mealDate: params.mealDate })}`);
}

/** L6 · 异常订单（待支付催促）—— 全量返回，**无分页字段** */
export interface LeaderAbnormalItem extends LeaderOrderItem {
  /** 已未支付分钟数（下限 0） */
  unpaidMinutes: number;
  /** <10 low / ≥10 mid / ≥20 high */
  urgeLevel: 'low' | 'mid' | 'high';
}

export interface LeaderAbnormalData {
  mealDate: string;
  count: number;
  totalQuantity: number;
  list: LeaderAbnormalItem[];
}

export function fetchLeaderAbnormal(
  params: { mealDate?: string } = {},
): Promise<LeaderAbnormalData> {
  return http.get<LeaderAbnormalData>(
    `/leader/orders/abnormal${query({ mealDate: params.mealDate })}`,
  );
}

// ---------------------------------------------------------------------------
// L7 · 团长代退申请（C6 第一段：**只登记，不退款**）
// ---------------------------------------------------------------------------

export interface RefundApplyPayload {
  reasonType: RefundReasonType;
  /** 主因描述，≤200（与 remark 合并写入 `ab_refund.reason`，该列限 256） */
  reason?: string;
  /** 补充备注，≤200 */
  remark?: string;
}

export interface LeaderRefundApplyData {
  refundNo: string;
  orderNo: string;
  /** 恒为 `applying` */
  status: string;
  /** 恒为「退款申请中」 */
  statusText: string;
  /** 申请退款额（整数分，= 用户实付） */
  amountFen: number;
  reasonType: string;
  /** 恒 false —— 本步**资金零变动**，实退由后台审批后执行 */
  fundsMoved: false;
  tips: string;
}

/**
 * L7 · 提交代退申请（**资金不动**）
 *
 * ⚠️ 路由在 `/orders` 域（不在 `/leader` 前缀下），但鉴权仍走 `LeaderGuard`。
 * ⚠️ 本接口**不退款、不回退分账**；仅把订单置 `refund_applying` 并建 `applying` 退款单，
 *    实际退款由运营在后台审批（§6.5 D46）后执行。
 *
 * 关键错误码：`30010` 订单不存在 / `10003` 跨楼越权 / `40008` 重复申请 / `30003` 状态不允许。
 */
export function applyRefundByLeader(
  orderNo: string,
  payload: RefundApplyPayload,
): Promise<LeaderRefundApplyData> {
  return http.post<LeaderRefundApplyData>(`/orders/${encodeURIComponent(orderNo)}/refund-apply`, {
    ...payload,
  } as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// L8 · 本楼今日取餐 / L9 · 一键分发
// ---------------------------------------------------------------------------

export interface PickupDeliveryInfo {
  status: 'pending' | 'called' | 'en_route' | 'arrived';
  /** 待叫车 / 已叫车 / 配送中 / 已送达 */
  statusText: string;
  /** ⚠️ UTC ISO（`....Z`） */
  expectedAt: string;
  /** ⚠️ UTC ISO；未送达 → null */
  actualAt: string | null;
  driverName: string | null;
  driverPhone: string | null;
  plateNo: string | null;
}

export interface PickupTodayData {
  mealDate: string;
  /** 份数合计（排除 cancelled / refunded） */
  totalQuantity: number;
  /** 已确认分发份数 */
  confirmedQuantity: number;
  /** 待分发份数 */
  pendingQuantity: number;
  /** 存在 delivering / delivered 单时为 true */
  canConfirm: boolean;
  /** 本楼群无配送记录 → null */
  delivery: PickupDeliveryInfo | null;
  /** 与本楼相关的订单行（手机号已脱敏） */
  members: LeaderOrderItem[];
}

/** L8 · 本楼今日取餐概况 */
export function fetchPickupToday(params: { mealDate?: string } = {}): Promise<PickupTodayData> {
  return http.get<PickupTodayData>(`/leader/pickup/today${query({ mealDate: params.mealDate })}`);
}

/** L9 分支 A：确有序订单被推进 */
export interface PickupConfirmDone {
  mealDate: string;
  /** 真正 affected 的订单数（乐观锁结果，可能 < 传入数） */
  confirmedCount: number;
  /** 本次计入佣金的份数（**计佣基数 = 实发份数**） */
  confirmedQuantity: number;
  /** 本次入账佣金（整数分） */
  commissionFen: number;
  /** 同金额的元字符串，如 `'15.48'` */
  commissionYuan: string;
  /** 小数，如 0.12 */
  rate: number;
  level: LeaderLevel;
  orderNos: string[];
  repeated: false;
  /** ⚠️ UTC ISO */
  confirmedAt: string;
}

/** L9 分支 B：无待确认订单（幂等友好，不报错） */
export interface PickupConfirmRepeated {
  mealDate: string;
  confirmedCount: 0;
  confirmedQuantity: 0;
  commissionFen: 0;
  repeated: true;
  tips: string;
}

export type PickupConfirmData = PickupConfirmDone | PickupConfirmRepeated;

/**
 * L9 · 确认收货并一键分发（计佣入账）
 *
 * ⚠️ **计佣基数 = 实发份数**（completed 的份数），不是下单份数 —— 这是 M2 最高风险口径。
 * ⚠️ 必须传 `Idempotency-Key`（服务端建议必传）：重复提交 → `10006` + 首次结果，
 *    端上按成功处理且**不会重复计佣**。同一「提交意图」内复用同一个 key。
 */
export function confirmPickup(
  orderNos: string[] | undefined,
  idempotentKey: string,
): Promise<PickupConfirmData> {
  return http.post<PickupConfirmData>(
    '/leader/pickup/confirm',
    orderNos?.length ? { orderNos } : {},
    { idempotentKey },
  );
}
