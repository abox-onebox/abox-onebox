/**
 * 首页 / 套餐契约（U1 / U2 / U3 · 《接口规范 v1.0》§3.1）
 */

/** 套餐内一道菜的展示视图（严禁包含供价 / 分账 / 供应商状态 —— C8） */
export interface MealDishView {
  name: string;
  /** 档位：1 主荤 / 2 半荤 / 3 素菜 / 4 汤 / 5 主食 */
  slot: number;
  category: string | null;
  imageUrl: string | null;
  supplierName: string | null;
  /**
   * 出品方 id（`ab_supplier.id`）
   *
   * ⭐ 存在的唯一理由：让端上「来自：X」这一行**可点**，跳溯源页并定位到这家。
   * 「定位」按 id 而不按 `supplierName` —— `ab_supplier.name` **没有唯一约束**
   * （同名两家是合法数据），按名字定位会跳错家。
   *
   * ⚠️ 与 C8 不冲突：id 是**内部主键**，既不是合作状态、也不是供价 / 分账。
   *    但它确实是「可枚举的供应商编号」—— 故本字段只在**已能看见该供应商展示名**
   *    的接口里出现（U1 菜品行 / U5 溯源卡），不下发到任何无名场景。
   */
  supplierId: number;
}

/**
 * 团长归属的**来源**（U1 出参 `leader.source`）
 *
 * 用户可能从未走过邀请链接 —— 此时系统按「本楼在任团长」自动挂靠，
 * 下单佣金也归那位团长。**这件事必须说出来**：佣金归属是钱的事，
 * 让用户以为「我没跟谁」而实际上有人在收他的佣金，是比不显示更糟的沉默。
 */
export type HomeLeaderSource =
  /** 经团长邀请链接绑定（`ab_user.team_leader_id` 指向的在任团长） */
  | 'bound'
  /** 未绑定 → 自动挂靠本楼在任团长（`ab_team_leader` 中该楼 id 最小且在职者） */
  | 'building_default';

/** 跟随团长信息（U1 出参 leader） */
export interface HomeLeaderInfo {
  id: number;
  name: string | null;
  building: string | null;
  /** 取餐点（楼名 + 楼层说明由后台配置） */
  floor: string | null;
  /** 归属来源：端上据此区分「你的邀请团长」与「本楼自动挂靠」 */
  source: HomeLeaderSource;
}

/** U1 明日套餐 */
export interface HomeDailyResult {
  mealDate: string;
  /** 开团时刻 T-1 14:00（ISO +08:00） */
  publishAt: string;
  /** 截单时刻 T-1 24:00（ISO +08:00） */
  cutoffAt: string;
  /**
   * 送达时刻 `HH:mm`（服务端按**生效时间轴**派生下发，端上只展示、不自造）
   *
   * ⚠️ PR-02 收口（2026-09-21）：下单确认页「由团长统一取餐并分发」曾写死 `11:30`；
   * 与 `cutoffAt` 同源（`currentTimeline().arrival`），后台可改，故必须下发。
   */
  deliverAt: string;
  /** 服务端权威可下单判定（截单前 10 分钟即 false） */
  canOrder: boolean;
  /** 距截单秒数，纯展示用 */
  countdownSec: number;
  /** 不可下单原因文案（canOrder=true 时为 null） */
  reason: string | null;
  /** 套餐名 */
  setName: string | null;
  dishes: MealDishView[];
  /** 主食说明（统一供米） */
  rice: string | null;
  /** 单价（分）· 锁定 2580 */
  priceFen: number;
  /** 剩余可订份数（null = 不限量） */
  stockLeft: number | null;
  /** 该用户在该出餐日已有订单时的订单号（端上做「已下单」提示 + 防重复） */
  existingOrderNo: string | null;
  leader: HomeLeaderInfo | null;
}

/** U2 历史套餐归档项 */
export interface HomeHistoryItem {
  mealDate: string;
  setName: string | null;
  dishNames: string[];
  priceFen: number;
  ordersCount: number;
}

/** U3 团长邀请落地（免登录） */
export interface LeaderInviteLanding {
  leaderCode: string;
  leaderName: string;
  building: string | null;
  floor: string | null;
  slogan: string;
  /** 邀请码是否有效（无效时端上降级为普通首页） */
  valid: boolean;
  /**
   * 送达时刻 `HH:mm`（服务端按**生效时间轴**派生下发）
   *
   * ⚠️ PR-02 收口（2026-09-21）：落地页「明天 11:30 由团长统一取餐分发」曾写死；
   * 落地页是**免登录**页，无法借其它接口取到该值，故随本响应一并下发。
   */
  deliverAt: string;
}
