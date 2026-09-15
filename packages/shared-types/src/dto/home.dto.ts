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
}

/** 跟随团长信息（U1 出参 leader） */
export interface HomeLeaderInfo {
  id: number;
  name: string | null;
  building: string | null;
  /** 取餐点（楼名 + 楼层说明由后台配置） */
  floor: string | null;
}

/** U1 明日套餐 */
export interface HomeDailyResult {
  mealDate: string;
  /** 开团时刻 T-1 14:00（ISO +08:00） */
  publishAt: string;
  /** 截单时刻 T-1 24:00（ISO +08:00） */
  cutoffAt: string;
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
}
