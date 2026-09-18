import { OrderStatus, ORDER_STATUS_VIEW, RefundStatus } from '@abox/shared-types';

/**
 * 订单状态机映射
 * 权威来源：《ABox一盒订单状态机与全链路流转v1.0.md》§二 状态迁移表
 * 主流程 T1–T11 单向不可逆；退款分支 T12–T16 见文档。
 *
 * ⚠️ **这张表是「声明」不是「守门人」** —— `canTransit()` 全仓只在单测里被引用，
 *    真正写 `ab_order.status` 的地方不会经过它。故「声明 ↔ 写入点」的一致性
 *    由 `order-state-audit.ts`（门禁 `state:audit`）**机械对账**，不靠人记得。
 *
 * ⚠️ M5-8 修正（本表第二处口径漂移 · 见《缺陷与陷阱》#79 / #84）：
 *    `refund_applying → refunding` 这条边**已删除**。M4-3 起「订单」不再进入 `refunding`
 *    —— 通道进度改由 `ab_refund.status` 表达，审批通过时订单**一步到 `refunded`**
 *    （`settleRefundDb` 的第一条语句即 `… SET status='refunded' WHERE status IN (:...ok)`）。
 *    这条边在此之前躺了三个批次：**声明表说订单会经过 `refunding`，而实现从没这么做过**，
 *    两边都不报错，e2e 与结构门禁全绿（同族：#15 / #67 / #76 —— 同一件事有多份表述，
 *    而不被自动化执行的那一份必然是错的）。
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING_PAY]: [OrderStatus.PAID, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [OrderStatus.CUT_OFF, OrderStatus.CANCELLED],
  [OrderStatus.CUT_OFF]: [OrderStatus.COOKED, OrderStatus.REFUND_APPLYING],
  [OrderStatus.COOKED]: [OrderStatus.DELIVERING, OrderStatus.REFUND_APPLYING],
  [OrderStatus.DELIVERING]: [OrderStatus.DELIVERED, OrderStatus.REFUND_APPLYING],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED, OrderStatus.REFUND_APPLYING],
  [OrderStatus.COMPLETED]: [OrderStatus.REFUND_APPLYING],
  [OrderStatus.CANCELLED]: [],
  // ⚠️ 没有 `→ refunding`（M5-8 删边 · 理由见上）
  [OrderStatus.REFUND_APPLYING]: [OrderStatus.REFUNDED],
  [OrderStatus.REFUNDING]: [OrderStatus.REFUNDED],
  [OrderStatus.REFUNDED]: [],
};

/**
 * 建单初始态（本表里**唯一**允许「无入边」的状态）
 *
 * 供 `state:audit` 区分「合法的起点」与「漂移残留的不可达态」——
 * 一个**没有任何入边**的状态意味着永远进不去，而它若同时不是初始态，
 * 就只能是「声明改了、实现没跟」或「实现改了、声明没跟」的残骸（#79 / #84）。
 */
export const ORDER_INITIAL_STATUS: OrderStatus = OrderStatus.PENDING_PAY;

/**
 * 保留态：仍留在 11 态契约里、但**订单永远不会进入**（无入边）的状态
 *
 * ⭐ 这不是「忘了实现」，而是**两条事实被合并表达**的结果：
 *    · 「订单」的退款进度：`refund_applying → refunded`（审批通过一步到底）
 *    · 「退款单」的通道进度：`applying → refunding → refunded`（`ab_refund.status`）
 *    `OrderStatus.REFUNDING` 保留在枚举里，是因为**三视角文案映射（`ORDER_STATUS_VIEW`）
 *    与 11 态契约、原型页面、后台筛选枚举都还在用它**；删掉枚举值才是真正的破坏性改动
 *    （属于产品契约裁决，不属本次实现批次）。故此处**如实登记**它的不可达性，
 *    由门禁 `state:audit` 保证「不可达态只有这一个，且必须是显式登记的」。
 */
export const ORDER_RESERVED_STATUSES: OrderStatus[] = [OrderStatus.REFUNDING];

/** 截单后（cut_off 及以后）用户不可自助取消（C6） */
export const USER_SELF_CANCEL_ALLOWED: OrderStatus[] = [OrderStatus.PENDING_PAY, OrderStatus.PAID];

/**
 * 用户自助取消**是否已错过窗口**（C6 硬闸）
 *
 * 两重条件：① 必须在截单时刻之前；② 订单状态必须是 `pending_pay` / `paid`。
 * 返回 `'cutoff'` 时调用方须抛 `40004`（已截单，无法自助退款）并附团长联系方式；
 * 返回 `'status'` 时抛 `30003`（当前订单状态不支持该操作）。
 */
export function explainSelfCancelBlock(
  status: OrderStatus,
  isAfterCutoff: boolean,
): 'ok' | 'cutoff' | 'status' {
  if (isAfterCutoff) return 'cutoff';
  return USER_SELF_CANCEL_ALLOWED.includes(status) ? 'ok' : 'status';
}

export function canTransit(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function canUserSelfCancel(status: OrderStatus): boolean {
  return USER_SELF_CANCEL_ALLOWED.includes(status);
}

/** 三视角状态文案（用户端） */
export const userStatusText = (status: string): string =>
  ORDER_STATUS_VIEW[status as OrderStatus]?.user ?? status;

/** 三视角状态文案（团长端） */
export const leaderStatusText = (status: string): string =>
  ORDER_STATUS_VIEW[status as OrderStatus]?.leader ?? status;

/** 三视角状态文案（后台） */
export const adminStatusText = (status: string): string =>
  ORDER_STATUS_VIEW[status as OrderStatus]?.admin ?? status;

/** 主流程进度序（用于时间线 `done` 判定） */
export const STATUS_PROGRESS: Record<string, number> = {
  [OrderStatus.PENDING_PAY]: 0,
  [OrderStatus.PAID]: 1,
  [OrderStatus.CUT_OFF]: 2,
  [OrderStatus.COOKED]: 3,
  [OrderStatus.DELIVERING]: 4,
  [OrderStatus.DELIVERED]: 5,
  [OrderStatus.COMPLETED]: 6,
};

export interface TimelineStep {
  node: string;
  /** 进度序，-1 表示异常区节点（取消 / 退款） */
  order: number;
  /** 未完成时的提示文案（如「预计 11:30 送达」） */
  pendingText: string;
}

/** U10 主流程 6 节点（与《状态机》§三 时间轴一致） */
export const TIMELINE_STEPS: TimelineStep[] = [
  { node: OrderStatus.PAID, order: 1, pendingText: '待支付' },
  { node: OrderStatus.CUT_OFF, order: 2, pendingText: '待截单' },
  { node: OrderStatus.COOKED, order: 3, pendingText: '待出餐' },
  { node: OrderStatus.DELIVERING, order: 4, pendingText: '待配送' },
  { node: OrderStatus.DELIVERED, order: 5, pendingText: '预计 11:30 送达' },
  { node: OrderStatus.COMPLETED, order: 6, pendingText: '待确认收货' },
];

/** 异常区节点（取消 / 退款三段） */
export const ABNORMAL_STEPS: Record<string, TimelineStep> = {
  [OrderStatus.CANCELLED]: { node: OrderStatus.CANCELLED, order: -1, pendingText: '已取消' },
  [OrderStatus.REFUND_APPLYING]: {
    node: OrderStatus.REFUND_APPLYING,
    order: -1,
    pendingText: '代退申请已提交，待平台审批',
  },
  [OrderStatus.REFUNDING]: { node: OrderStatus.REFUNDING, order: -1, pendingText: '退款处理中' },
  [OrderStatus.REFUNDED]: { node: OrderStatus.REFUNDED, order: -1, pendingText: '退款已到账' },
};

export interface TimelineSource {
  status: string;
  paidAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  /** 截单时刻（T-1 24:00，按 mealDate 推得） */
  cutoffAt: Date;
  createdAt: Date;
}

export interface RawTimelineNode {
  node: string;
  at: Date | null;
  done: boolean;
  text: string;
}

/**
 * 生成订单时间线（U10）
 *
 * `at` 取值原则：**只给有可靠来源的节点填时间**，其余留 null 由端上展示 pendingText。
 *   paid      → order.paid_at
 *   cut_off   → 按 mealDate 推得的截单时刻（系统锚点，非人工操作）
 *   completed → order.completed_at
 *   取消/退款 → order.cancelled_at（退款中/已退款以 cancelled_at 为申请时刻近似）
 */
export function buildTimeline(src: TimelineSource): RawTimelineNode[] {
  const progress = STATUS_PROGRESS[src.status] ?? 0;
  const isAbnormal = !(src.status in STATUS_PROGRESS);

  const nodes: RawTimelineNode[] = TIMELINE_STEPS.map((step) => {
    const done = !isAbnormal && progress >= step.order;
    let at: Date | null = null;
    if (done) {
      if (step.node === OrderStatus.PAID) at = src.paidAt ?? src.createdAt;
      else if (step.node === OrderStatus.CUT_OFF) at = src.cutoffAt;
      else if (step.node === OrderStatus.COMPLETED) at = src.completedAt ?? null;
      else at = null;
    }
    return { node: step.node, at, done, text: userStatusText(step.node) || step.pendingText };
  });

  if (isAbnormal) {
    const step = ABNORMAL_STEPS[src.status];
    if (step) {
      nodes.push({
        node: step.node,
        at: src.cancelledAt ?? null,
        done: true,
        text: userStatusText(step.node) || step.pendingText,
      });
    }
  }

  return nodes;
}

/** 判定 ab_refund 是否处于「终态已退款」（供财务侧使用） */
export const isRefundSettled = (status: string): boolean =>
  status === RefundStatus.REFUNDED || status === RefundStatus.REJECTED;
