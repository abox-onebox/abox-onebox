/**
 * 配送单状态（`ab_delivery_record.status`）· M5-1 收敛
 *
 * ## 为什么单独建这个文件
 * 在此之前的实际情况是：`ab_delivery_record.status` 的中文文案在**两处逐字重复**
 * ——`modules/order/leader-order.service.ts`（L8 团长端取餐）与
 * `modules/team-leader/workbench.service.ts`（工作台）。两份 `DELIVERY_STATUS_TEXT`
 * 内容完全一致，但**没有任何校验保证它们继续一致**：谁新增一个状态（如 `cancelled`）
 * 只改一处，另一处会经 `?? status` 静默回落成**英文 key**——用户看到 `cancelled`，
 * 而**没有任何报错**（同族：#67 跨端字面量、#63 两个真相）。
 *
 * 故与 `REFUND_STATUS_LABEL` / `ORDER_STATUS_VIEW` 同族，收敛到本文件作为**唯一真相**；
 * 端上（后台 / 小程序）**不维护第二份映射**，需要时由服务端出参下发 `statusText`。
 *
 * ⚠️ 状态机口径见《订单状态机与全链路流转 v1.0》：本四态是**配送单**的履约流转，
 *    与**订单**的 11 态（`OrderStatus`）不是一回事 —— 订单的 `delivering` 是其中一态，
 *    而配送单自己还有 `pending → called → en_route → arrived` 的细粒度过程。
 */
export enum DeliveryStatus {
  /** 待叫车：配送单已生成，尚未安排运力 */
  PENDING = 'pending',
  /** 已叫车：已下单叫车 / 已指派司机 */
  CALLED = 'called',
  /** 配送中：在途 */
  EN_ROUTE = 'en_route',
  /** 已送达：到达楼群并完成交付 */
  ARRIVED = 'arrived',
}

/**
 * 配送状态中文文案（后台与小程序共用 · 端上不维护第二份映射）
 *
 * ⚠️ 查表 miss 时的行为由调用方决定：服务端出参一律用
 *    `DELIVERY_STATUS_LABEL[s] ?? s`（回落原始 key 而非抛错）——
 *    状态是**数据事实**，多一个未知态不该让整个列表接口 500。
 */
export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  [DeliveryStatus.PENDING]: '待叫车',
  [DeliveryStatus.CALLED]: '已叫车',
  [DeliveryStatus.EN_ROUTE]: '配送中',
  [DeliveryStatus.ARRIVED]: '已送达',
};

/**
 * 状态筛选下拉的**权威顺序**（端上不自己排）
 *
 * 顺序 = 履约推进顺序，不是字典序 —— `en_route` 排在 `called` 之后靠的是这里，
 * 让端上各自 `Object.keys()` 会得到 `arrived/called/en_route/pending` 这种
 * 与业务无关的顺序。
 */
export const DELIVERY_STATUS_ORDER: DeliveryStatus[] = [
  DeliveryStatus.PENDING,
  DeliveryStatus.CALLED,
  DeliveryStatus.EN_ROUTE,
  DeliveryStatus.ARRIVED,
];
