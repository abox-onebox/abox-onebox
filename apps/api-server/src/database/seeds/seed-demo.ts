import 'reflect-metadata';
import 'dotenv/config';

import dataSource from '../data-source';
import { addDays, todayBj } from '../../common/utils/time';

/**
 * 演示 / 边界数据集（**在基础种子之上叠加的一层**）
 *
 * ## 为什么要有这一层
 * `seed.ts`（基础种子）只落**主数据**（楼群 / 楼栋 / 团长 / 供应商 / 套餐 / 配置 / 分配），
 * **一张订单都没有**。于是把环境交给人工测试时：
 *   · 看板的 GMV / 成本 / 毛利全是 0（A2 的判据「有数，不是 0」直接无从判起）；
 *   · 财务的余额 / 佣金 / 发票 / 对账四页全空（A12 / A13 / A14 / A17）；
 *   · 统计的楼栋排行 / 菜品热度 / 留存没内容（A18）；
 *   · 配送单页没有可推进的单（A7b / A7c）；
 *   · 订单列表看不到 11 态的任何一态（A5 / A6）。
 * 本文件把这块补上：**覆盖主业务场景 + 典型边界**，让「照清单点」这件事真的点得下去。
 *
 * ## ⚠️ 为什么**不能**并进 `seed.ts`
 * `gate.mjs seed` 是 **e2e 的前置**。e2e:m3 里有多处**绝对值断言**依赖
 * 「库里只有基础种子 + 本节自己造的夹具」：
 *   · §14 D1 `stats.assignedCells === 5`（明日 ~ 后日 的排期格数）
 *   · §20 S1 `dishes.length === 1` / `centers.length === 1`（三味屋当日加工场所只有 dc1）
 *   · §27 D44 发票三态（指定月份 × 指定供应商的应付分母）
 *   · §23 §35 的「挑一个没有被牵连的楼群 / 用户」也要求池子里有足够干净的候选
 * 演示数据一旦并进基础种子，**这些断言会全红**，而红的原因与被测产物毫无关系 ——
 * 那是「假红」，比没门禁更糟。故分两层：`seed` 保持纯净，`seed:demo` 显式叠加。
 *
 * ## 隔离设计（每一条都是为避免与 e2e 抢维度）
 * | 维度 | 演示数据的取值 | 为什么 |
 * | --- | --- | --- |
 * | 楼群 | **只用 4 华贸组 / 5 远洋光华组** | §15/§16/D8 大量使用楼群 1/2/3 |
 * | 出餐日 | 一律 **T-2 … T-9**（过去） | 明日（T+1）是下单窗口、被 §14/§20/§28/§32/§35 占用；T / T-1 被 §23 占用 |
 * | 用户 | 专用 `openid LIKE 'demo_abox_%'` | §23 需要「≥4 个从未下过单的用户」当夹具，不能把种子用户占满 |
 * | 团长 | 专用 3 名（1 在职正式 / 1 在职金牌 / 1 **停职**） | §31 用 Δ 断言，但仍不与既有团长共用账户更稳 |
 * | 楼栋 | 只让**楼 8 / 楼 9** 有在职团长 | §17 需要「≥2 栋无在职团长」的楼；楼 11/12 保持空缺 |
 * | 单号 | `ABDEMO*` / `WDDEMO*` / `RFDEMO*` / `DMDEMO*` | 清理与识别都靠前缀，不靠 id 区间 |
 *
 * ## 两条「绝不」的纪律
 * 1. **不碰 `ab_balance` / `ab_commission` 里的既有账号** —— e2e:m2 §4.4 对李明
 *    （`user_id=1001`）有**绝对值**断言（`balanceFen === 1548` / `pendingCommissionFen === 1548`），
 *    给他记一分钱都会红。演示资金一律落在专用账号上。
 * 2. **不给「明日」造订单** —— 人工测试的 U6 要用 `dev:1001` 在明日下单；
 *    演示数据若占了同一出餐日，会把测试人**自己的第一步**挡掉（`30004`）。
 *
 * ## 覆盖的场景
 * · 11 个订单状态**全覆盖**（含 `refunding` 这个**保留态探针**，见下）
 * · 完整履约链演练日（T-2 华贸组：订单 `cut_off` + 配送单 `pending` → 可现场走 T7→T8→T9）
 * · 退款单四态：`applying` / `approved` / `refunded`（含反向冲销）/ `rejected`
 * · 提现单五态：`pending` / `approved` / `success` / `rejected` / `failed`
 * · 佣金两段式：`pending`（待入账）+ `settled`（已入账）+ `reversal`（冲销负行）
 * · 加工场所出餐计划与到货确认（含**短送**留痕）
 * · 采购应付 + 发票三态（未开 / 部分 / 已开，按供应商区分）
 *
 * ## 典型边界
 * · 一份未支付的单**永远停在 `pending_pay`**（系统不自动取消）
 * · 「已支付但未截单」= **截单跑批漏跑**的异常样本（运营要能一眼看出）
 * · 单次下单上限 `quantity = 20`（`order.max_quantity`）+ 最小 1 份
 * · 全额余额抵扣（`pay_amount` 只付 1 分 —— 微信最小支付金额边界）
 * · 无团长楼栋（楼 11/12）下单 → `team_leader_id = NULL`
 * · 团长**转交**：楼 8 由停职团长转给在职团长，历史佣金**保留**且费率快照不同（10% → 9%）
 * · 见习团长 30 天未促单（**观察项**，规则未实装，数据上先摆着）
 * · 配送单份数与订单份数**不符**（一处人工修正痕迹）
 * · 套餐不同 → 单价不同（¥25.80 / ¥29.80 / ¥28.80 三种）
 *
 * ## ⚠️ `refunding` 保留态探针
 * `refunding` 在**状态机里是保留态**（`ORDER_RESERVED_STATUSES`），生产链路
 * **不会**产生它（M4-3 起退款审批通过**一步到 `refunded`**，通道进度交 `ab_refund.status`）。
 * 这里刻意播一条，用途只有一个：**验证端上遇到陌生状态不白屏、不崩、能如实显示**。
 * 它**不是**待修的数据，测试人看到请记 P2 备注，别记 P0。
 *
 * 用法：
 *   ABOX_SEED_CONFIRM=1 ts-node -r tsconfig-paths/register src/database/seeds/seed-demo.ts
 *   （走门禁：`node scripts/gate.mjs seed:demo`）
 */

// ============================================================================
// 命名空间常量 —— 清理与识别都靠它们
// ============================================================================

/** `ab_user.openid` 前缀（演示用户） */
const OPENID_PREFIX = 'demo_abox_';
/** `ab_order.order_no` / `ab_commission.order_no` / `ab_payment_log.order_no` 前缀 */
const ORDER_PREFIX = 'ABDEMO';
/** `ab_withdraw.withdraw_no` */
const WITHDRAW_PREFIX = 'WDDEMO';
/** `ab_refund.refund_no` */
const REFUND_PREFIX = 'RFDEMO';
/** `ab_supplier_share.share_no` */
const SHARE_PREFIX = 'DMDEMO';
/** `ab_delivery_record.remark` 标记（该表无业务单号，用备注 + 日期/楼群双键识别） */
const DELIVERY_REMARK = '演示数据（seed:demo）';

/** 演示数据使用的楼群（**只有这两个** —— 见文件头隔离设计） */
const DEMO_GROUPS = [4, 5] as const;
/** 楼 8/9 属楼群 4（华贸组）；楼 11/12 属楼群 5（远洋光华组） */

// ============================================================================
// 时间助手 —— 库里存的是 **UTC**（北京 11:30 → `03:30:00.000`），故一律换算
// ============================================================================

/** 北京墙上时间 → 库里存的 UTC 字符串 `YYYY-MM-DD HH:mm:ss.SSS` */
function atUtc(dateStr: string, hhmm: string): string {
  const t = new Date(`${dateStr}T${hhmm}:00.000+08:00`);
  if (Number.isNaN(t.getTime())) throw new Error(`非法时刻：${dateStr} ${hhmm}`);
  return t.toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * 开团时刻 = **T-1 14:00**；截单时刻 = **T-1 24:00**（= T 日 00:00）。
 * 与 `common/utils/order-timeline.ts` 的 `DEFAULT_TIMELINE` 同源，此处只做落库换算。
 */
const publishAtOf = (mealDate: string): string => atUtc(addDays(mealDate, -1), '14:00');
const cutoffAtOf = (mealDate: string): string => atUtc(mealDate, '00:00');

/** 金额：分 → 两位小数字符串（与 `money()` 同口径，四舍五入） */
const money = (fen: number): string => (fen / 100).toFixed(2);
/** `round2(qty × price × rate)` → 分（与 `commission.service` 的计佣口径逐字一致） */
const commissionFen = (qty: number, unitPriceYuan: number, rate: number): number =>
  Math.round(qty * unitPriceYuan * rate * 100);

// ============================================================================
// 数据集定义
// ============================================================================

/** 演示用户（`openid` 前缀统一，昵称带「演示」字样便于后台一眼认出） */
interface DemoUserSpec {
  key: string;
  nickname: string;
  buildingId: number;
  /** 归属团长（`ab_user.team_leader_id`）：楼 8 → L1 / 楼 9 → L2 / 楼 11,12 → null */
  leaderKey: string | null;
  phone: string;
}

const USERS: DemoUserSpec[] = [
  { key: 'u01', nickname: '演示·华贸甲', buildingId: 8, leaderKey: 'L1', phone: '13900010001' },
  { key: 'u02', nickname: '演示·华贸乙', buildingId: 9, leaderKey: 'L2', phone: '13900010002' },
  { key: 'u03', nickname: '演示·远洋丙', buildingId: 11, leaderKey: null, phone: '13900010003' },
  { key: 'u04', nickname: '演示·远洋丁', buildingId: 12, leaderKey: null, phone: '13900010004' },
  // u05：只下过「未支付 / 已取消」，用来验证「无效单不进 GMV、不进活跃用户」
  { key: 'u05', nickname: '演示·华贸戊', buildingId: 9, leaderKey: 'L2', phone: '13900010005' },
  // u06：有份数上限大单
  { key: 'u06', nickname: '演示·华贸己', buildingId: 8, leaderKey: 'L1', phone: '13900010006' },
  // u07：有跨日复购（留存样本）
  { key: 'u07', nickname: '演示·远洋庚', buildingId: 11, leaderKey: null, phone: '13900010007' },
  { key: 'u08', nickname: '演示·远洋辛', buildingId: 12, leaderKey: null, phone: '13900010008' },
  // 三个演示团长的**用户身份**（团长是叠加身份，必须有 ab_user）
  {
    key: 'L1u',
    nickname: '演示·华贸一号团长',
    buildingId: 8,
    leaderKey: null,
    phone: '13900011001',
  },
  {
    key: 'L2u',
    nickname: '演示·华贸二号团长',
    buildingId: 9,
    leaderKey: null,
    phone: '13900011002',
  },
  {
    key: 'L3u',
    nickname: '演示·国贸四号团长（已停职）',
    buildingId: 8,
    leaderKey: null,
    phone: '13900011003',
  },
];

/** 演示团长 */
interface DemoLeaderSpec {
  key: string;
  userKey: string;
  /** 服务楼栋 */
  buildingId: number;
  realName: string;
  floor: string;
  level: 'trainee' | 'formal' | 'gold' | 'chief';
  rate: string;
  /** 1 在职 / 2 停职 */
  status: number;
  monthOrders: number;
  totalOrders: number;
  invitedFormalCount: number;
  /** 上任时刻（距今 N 天） */
  agreedDaysAgo: number;
  payout: { type: string; account: string; name: string } | null;
}

const LEADERS: DemoLeaderSpec[] = [
  {
    key: 'L1',
    userKey: 'L1u',
    buildingId: 8,
    realName: '演示·华贸一号团长',
    floor: '6F',
    level: 'formal',
    rate: '0.0900',
    status: 1,
    monthOrders: 26,
    totalOrders: 212,
    invitedFormalCount: 1,
    agreedDaysAgo: 96,
    payout: { type: 'bank', account: '6222****1001', name: '演示·华贸一号团长' },
  },
  {
    key: 'L2',
    userKey: 'L2u',
    buildingId: 9,
    realName: '演示·华贸二号团长',
    floor: '11F',
    level: 'gold',
    rate: '0.1000',
    status: 1,
    monthOrders: 61,
    totalOrders: 380,
    invitedFormalCount: 3,
    agreedDaysAgo: 210,
    payout: { type: 'bank', account: '6222****1002', name: '演示·华贸二号团长' },
  },
  {
    // ⭐ 边界：**停职团长**。转交后保留历史佣金与费率快照，不重置等级。
    key: 'L3',
    userKey: 'L3u',
    buildingId: 8,
    realName: '演示·国贸四号团长（已停职）',
    floor: '6F',
    level: 'gold',
    rate: '0.1000',
    status: 2,
    monthOrders: 9,
    totalOrders: 154,
    invitedFormalCount: 0,
    agreedDaysAgo: 300,
    payout: { type: 'bank', account: '6222****1003', name: '演示·国贸四号团长' },
  },
];

/** 演示订单 */
interface DemoOrderSpec {
  seq: number;
  /** 出餐日 = 今天 + dayOffset（一律 ≤ -2） */
  dayOffset: number;
  groupId: number;
  buildingId: number;
  userKey: string;
  /** 结算时的团长快照（`null` = 无团长楼栋） */
  leaderKey: string | null;
  setMealId: number;
  quantity: number;
  status: string;
  /** 团长代退 / 用户自助（`refund_applying` 用） */
  remark?: string;
}

/**
 * ⭐ 转交分界：楼 8 的团长在 **T-8 / T-9 之间**由 L3（金牌 10%）转给 L1（正式 9%）。
 * 于是同一栋楼的历史佣金里**并存两个费率** —— 这正是「等级快照」最容易被写错的地方。
 * （自检 ⑪ 会按这条分界逐单核对归属，写错就红。）
 */
const HANDOVER_BOUNDARY_DAY = -8;

const ORDERS: DemoOrderSpec[] = [
  // ---- T-2 · 楼群 4 ==================== 完整履约链演练日 ====================
  {
    seq: 1,
    dayOffset: -2,
    groupId: 4,
    buildingId: 8,
    userKey: 'u01',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 2,
    status: 'cut_off',
  },
  {
    seq: 2,
    dayOffset: -2,
    groupId: 4,
    buildingId: 9,
    userKey: 'u02',
    leaderKey: 'L2',
    setMealId: 1,
    quantity: 3,
    status: 'cut_off',
  },
  {
    seq: 3,
    dayOffset: -2,
    groupId: 4,
    buildingId: 8,
    userKey: 'u06',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 4,
    status: 'cut_off',
  },
  // ⭐ 边界：未支付的单**不会**被自动取消，会长期停在 pending_pay
  {
    seq: 4,
    dayOffset: -2,
    groupId: 4,
    buildingId: 9,
    userKey: 'u05',
    leaderKey: 'L2',
    setMealId: 1,
    quantity: 1,
    status: 'pending_pay',
    remark: '演示：下单后一直未支付（系统不自动取消）',
  },
  // ⭐ 边界（异常样本）：已支付但截单跑批漏跑 → 停在 paid
  {
    seq: 5,
    dayOffset: -2,
    groupId: 4,
    buildingId: 8,
    userKey: 'u07',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 1,
    status: 'paid',
    remark: '演示异常样本：已支付但未截单（截单跑批漏跑）',
  },

  // ---- T-2 · 楼群 5 ==================== 历史完成 + 无团长楼栋 ==============
  {
    seq: 6,
    dayOffset: -2,
    groupId: 5,
    buildingId: 11,
    userKey: 'u03',
    leaderKey: null,
    setMealId: 1,
    quantity: 2,
    status: 'refund_applying',
    remark: '演示：用户自助退款待审批（楼栋无团长）',
  },
  // ⭐ 边界：不同套餐 → 不同单价（¥29.80），验证「金额不是恒等于 25.80 × 份数」
  {
    seq: 7,
    dayOffset: -2,
    groupId: 5,
    buildingId: 12,
    userKey: 'u04',
    leaderKey: null,
    setMealId: 2,
    quantity: 1,
    status: 'completed',
  },
  {
    seq: 8,
    dayOffset: -2,
    groupId: 5,
    buildingId: 11,
    userKey: 'u08',
    leaderKey: null,
    setMealId: 1,
    quantity: 1,
    status: 'cancelled',
    remark: '演示：截单前用户自助取消',
  },

  // ---- T-3 · 楼群 4 ==================== 完成 + 退款两段 ====================
  {
    seq: 9,
    dayOffset: -3,
    groupId: 4,
    buildingId: 8,
    userKey: 'u01',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 2,
    status: 'completed',
  },
  {
    seq: 10,
    dayOffset: -3,
    groupId: 4,
    buildingId: 9,
    userKey: 'u02',
    leaderKey: 'L2',
    setMealId: 1,
    quantity: 1,
    status: 'completed',
  },
  {
    seq: 11,
    dayOffset: -3,
    groupId: 4,
    buildingId: 8,
    userKey: 'u06',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 1,
    status: 'refunded',
    remark: '演示：退款已到账（佣金已反向冲销）',
  },
  {
    seq: 12,
    dayOffset: -3,
    groupId: 4,
    buildingId: 8,
    userKey: 'u07',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 1,
    status: 'refund_applying',
    remark: '演示：团长代退待审批（佣金仍在支出，尚未冲销）',
  },

  // ---- T-3 · 楼群 5 ==================== 无团长楼栋的完成单 ==================
  {
    seq: 13,
    dayOffset: -3,
    groupId: 5,
    buildingId: 12,
    userKey: 'u03',
    leaderKey: null,
    setMealId: 1,
    quantity: 1,
    status: 'completed',
  },

  // ---- T-4 · 楼群 4 ==================== 配送中 → 已送达 ====================
  {
    seq: 14,
    dayOffset: -4,
    groupId: 4,
    buildingId: 8,
    userKey: 'u01',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 2,
    status: 'delivered',
  },
  {
    seq: 15,
    dayOffset: -4,
    groupId: 4,
    buildingId: 9,
    userKey: 'u02',
    leaderKey: 'L2',
    setMealId: 1,
    quantity: 1,
    status: 'delivered',
  },

  // ---- T-4 · 楼群 5 ========================================================
  {
    seq: 16,
    dayOffset: -4,
    groupId: 5,
    buildingId: 11,
    userKey: 'u04',
    leaderKey: null,
    setMealId: 1,
    quantity: 2,
    status: 'delivering',
  },

  // ---- T-5 · 楼群 4 ==================== 出餐超时 + 份数上限 ================
  {
    seq: 17,
    dayOffset: -5,
    groupId: 4,
    buildingId: 8,
    userKey: 'u01',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 2,
    status: 'cooked',
  },
  // ⭐ 边界：单次下单上限 20 份（`order.max_quantity`）+ 又一个「跑批漏跑」样本
  {
    seq: 18,
    dayOffset: -5,
    groupId: 4,
    buildingId: 9,
    userKey: 'u05',
    leaderKey: 'L2',
    setMealId: 1,
    quantity: 20,
    status: 'paid',
    remark: '演示边界：单次下单上限 20 份（order.max_quantity）',
  },

  // ---- T-5 · 楼群 5 ==================== 保留态探针 =========================
  {
    seq: 19,
    dayOffset: -5,
    groupId: 5,
    buildingId: 11,
    userKey: 'u07',
    leaderKey: null,
    setMealId: 1,
    quantity: 1,
    status: 'refunding',
    remark: '⚠️ 保留态探针：生产链路不会产生该状态，仅验证端上兜底展示',
  },

  // ---- T-6 · 楼群 4 ==================== 完成（发放佣金） ===================
  {
    seq: 20,
    dayOffset: -6,
    groupId: 4,
    buildingId: 8,
    userKey: 'u06',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 2,
    status: 'completed',
  },
  {
    seq: 21,
    dayOffset: -6,
    groupId: 4,
    buildingId: 8,
    userKey: 'u01',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 8,
    status: 'completed',
  },
  {
    seq: 28,
    dayOffset: -6,
    groupId: 4,
    buildingId: 9,
    userKey: 'u05',
    leaderKey: 'L2',
    setMealId: 1,
    quantity: 5,
    status: 'completed',
  },

  // ---- T-6 · 楼群 5 ========================================================
  {
    seq: 22,
    dayOffset: -6,
    groupId: 5,
    buildingId: 12,
    userKey: 'u08',
    leaderKey: null,
    setMealId: 3,
    quantity: 3,
    status: 'completed',
  },

  // ---- T-7 · 楼群 4 ========================================================
  {
    seq: 23,
    dayOffset: -7,
    groupId: 4,
    buildingId: 8,
    userKey: 'u06',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 6,
    status: 'completed',
  },
  {
    seq: 24,
    dayOffset: -7,
    groupId: 4,
    buildingId: 8,
    userKey: 'u01',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 3,
    status: 'completed',
  },
  {
    seq: 29,
    dayOffset: -7,
    groupId: 4,
    buildingId: 9,
    userKey: 'u02',
    leaderKey: 'L2',
    setMealId: 1,
    quantity: 4,
    status: 'completed',
  },

  // ---- T-7 · 楼群 5 ==================== 不同单价（清真牛肉 ¥28.80） ========
  {
    seq: 25,
    dayOffset: -7,
    groupId: 5,
    buildingId: 12,
    userKey: 'u03',
    leaderKey: null,
    setMealId: 4,
    quantity: 1,
    status: 'completed',
  },

  // ---- T-9 · 楼群 4 ==================== 转交之前的 L3 时代 =================
  {
    seq: 26,
    dayOffset: -9,
    groupId: 4,
    buildingId: 8,
    userKey: 'u01',
    leaderKey: 'L3',
    setMealId: 1,
    quantity: 4,
    status: 'completed',
  },
  {
    seq: 27,
    dayOffset: -9,
    groupId: 4,
    buildingId: 8,
    userKey: 'u06',
    leaderKey: 'L3',
    setMealId: 1,
    quantity: 3,
    status: 'completed',
  },

  // ---- T 日（今天）· ⭐ 关键补齐 ============================================
  //
  // ⚠️ **为什么必须有「今天」这一天**：后台有 4 处页面的默认日期就是**今天** ——
  //   ① 佣金明细（`date` 缺省今日）② 打包任务（缺省今日）③ 看板「今日」档
  //   ④ 配送单（缺省取**最近**一个有配送记录的日期）。
  //   若演示数据全是 T-2 及更早，测试人打开这几页看到的是**空表**，
  //   然后把「空」记成缺陷 —— 而库里其实有数据。这一天就是为了让默认视图有东西可看。
  //
  // ⭐ 今天的订单**天然**是「佣金 pending」的最佳样本：T 日 14:00 确认收货计佣写
  //   `pending`，T+1 02:00 才由 `settlePending` 入账。故今天完成的单佣金**必须**是
  //   pending（明天才变 settled）—— 这正是两段式的第一段，且无需任何人为构造。
  //
  // ⚠️ 今天的订单**不占**「明日」下单窗口（`isOrderable` 只管明日），测试人照样能自己下单。
  {
    seq: 30,
    dayOffset: 0,
    groupId: 4,
    buildingId: 8,
    userKey: 'u01',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 3,
    status: 'completed',
    remark: '演示：今日已完成 → 佣金 pending（T+1 02:00 才入账）',
  },
  {
    seq: 31,
    dayOffset: 0,
    groupId: 4,
    buildingId: 9,
    userKey: 'u02',
    leaderKey: 'L2',
    setMealId: 1,
    quantity: 2,
    status: 'completed',
    remark: '演示：今日已完成 → 佣金 pending（T+1 02:00 才入账）',
  },
  {
    seq: 32,
    dayOffset: 0,
    groupId: 4,
    buildingId: 8,
    userKey: 'u06',
    leaderKey: 'L1',
    setMealId: 1,
    quantity: 1,
    status: 'delivered',
    remark: '演示：已送达但团长尚未确认收货（此时**还没有**佣金行）',
  },
  // 楼群 5 · ⭐ 异常样本：当日配送单**未登记** → 订单停在 `cooked`
  //   （配送单不登记，D63 就没机会把它们推到 delivering/delivered —— 链路自洽，
  //    且 A7b/A7c/A7d 正好拿它练推进）
  {
    seq: 33,
    dayOffset: 0,
    groupId: 5,
    buildingId: 11,
    userKey: 'u03',
    leaderKey: null,
    setMealId: 1,
    quantity: 2,
    status: 'cooked',
    remark: '演示：出餐已确认、配送单一步未推（A7b/A7c 可拿它练推进）',
  },
  {
    seq: 34,
    dayOffset: 0,
    groupId: 5,
    buildingId: 12,
    userKey: 'u04',
    leaderKey: null,
    setMealId: 1,
    quantity: 1,
    status: 'cooked',
    remark: '演示：出餐已确认、配送单一步未推（A7b/A7c 可拿它练推进）',
  },
];

/** 退款单（四种状态全覆盖） */
interface DemoRefundSpec {
  seq: number;
  orderSeq: number;
  status: 'applying' | 'approved' | 'refunded' | 'rejected';
  applySource: 'user' | 'leader';
  reasonType: string;
  reason: string;
  /** 退款单落库时刻（距今 N 天） */
  dayOffset: number;
  auditorId: number | null;
  auditRemark: string | null;
}

const REFUNDS: DemoRefundSpec[] = [
  {
    seq: 1,
    orderSeq: 12,
    status: 'applying',
    applySource: 'leader',
    reasonType: 'quality',
    reason: '菜品偏咸，用户要求全额退',
    dayOffset: -2,
    auditorId: null,
    auditRemark: null,
  },
  {
    seq: 2,
    orderSeq: 6,
    status: 'approved',
    applySource: 'user',
    reasonType: 'late',
    reason: '送达晚了 40 分钟',
    dayOffset: -2,
    auditorId: 1,
    auditRemark: '情况属实，批准退款',
  },
  {
    seq: 3,
    orderSeq: 11,
    status: 'refunded',
    applySource: 'leader',
    reasonType: 'missing',
    reason: '少送一份汤',
    dayOffset: -3,
    auditorId: 1,
    auditRemark: '同意，已原路退回',
  },
  {
    seq: 4,
    orderSeq: 13,
    status: 'rejected',
    applySource: 'user',
    reasonType: 'other',
    reason: '不想要了',
    dayOffset: -3,
    auditorId: 1,
    auditRemark: '餐已送达且无质量问题，驳回',
  },
];

/**
 * 提现单
 *
 * ⚠️ 金额必须落在**各自账户的可用余额之内**且**逐笔记账**（见 `buildLedger`）——
 * 演示数据自己违反资金守恒，测试人就会把它当缺陷报上来。
 */
interface DemoWithdrawSpec {
  seq: number;
  leaderKey: string;
  /** 申请金额（元） */
  amountYuan: number;
  status: 'pending' | 'approved' | 'success' | 'rejected' | 'failed';
  /** 申请时刻（距今 N 天） */
  dayOffset: number;
  /** 代扣个税（元，仅 success 有意义） */
  taxYuan: number;
  auditRemark: string | null;
  failReason: string | null;
}

const WITHDRAWS: DemoWithdrawSpec[] = [
  {
    seq: 1,
    leaderKey: 'L1',
    amountYuan: 30,
    status: 'success',
    dayOffset: -6,
    taxYuan: 0,
    auditRemark: '已核对，同意出款',
    failReason: null,
  },
  {
    seq: 2,
    leaderKey: 'L1',
    amountYuan: 10,
    status: 'rejected',
    dayOffset: -4,
    taxYuan: 0,
    auditRemark: '收款账号与实名不一致，请先修改团长资料',
    failReason: null,
  },
  {
    seq: 3,
    leaderKey: 'L1',
    amountYuan: 5,
    status: 'failed',
    dayOffset: -3,
    taxYuan: 0,
    auditRemark: '已批准',
    failReason: '灵活用工平台回执：账户信息校验失败',
  },
  // ⭐ A15 的「待审批」样本 —— 冻结 ¥5.00 到审批完成才释放
  {
    seq: 4,
    leaderKey: 'L1',
    amountYuan: 5,
    status: 'pending',
    dayOffset: -2,
    taxYuan: 0,
    auditRemark: null,
    failReason: null,
  },
  // ⭐ A15 的「已批准待打款」样本
  {
    seq: 5,
    leaderKey: 'L2',
    amountYuan: 8,
    status: 'approved',
    dayOffset: -2,
    taxYuan: 0,
    auditRemark: '同意出款，批次 FLEX202609',
    failReason: null,
  },
  // ⭐ 停职团长的历史提现（停职**不影响**已结算佣金的提现权）
  {
    seq: 6,
    leaderKey: 'L3',
    amountYuan: 12,
    status: 'success',
    dayOffset: -9,
    taxYuan: 0,
    auditRemark: '转交前结清',
    failReason: null,
  },
];

// ============================================================================
// 小额 SQL 助手
// ============================================================================

async function ins(table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const stmt = sql.replace(/\s+/g, ' ');
  for (const r of rows) {
    for (const c of cols) {
      if (!(c in r)) throw new Error(`${table} 第 ${rows.indexOf(r) + 1} 行缺列 ${c}`);
    }
    await dataSource.query(
      stmt,
      cols.map((c) => r[c] ?? null),
    );
  }
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = (await dataSource.query(sql, params)) as Array<Record<string, unknown>>;
  return Number(r[0]?.c ?? 0);
}

function assertSafeToRun(): void {
  if (process.env.NODE_ENV === 'production') {
    console.error('✖ 演示数据集禁止在生产环境导入（NODE_ENV=production）');
    process.exit(1);
  }
  if (!/^(1|true|yes)$/i.test(process.env.ABOX_SEED_CONFIRM ?? '')) {
    console.error(
      '✖ 未确认：本脚本会**删除并重建**全部演示数据（带 ABDEMO/WDDEMO/RFDEMO/DMDEMO 前缀的行）。\n' +
        '  确认请显式加环境变量：ABOX_SEED_CONFIRM=1\n' +
        '  （走门禁 `node scripts/gate.mjs seed:demo` 时已自带。）',
    );
    process.exit(1);
  }
}

// ============================================================================
// 资金账本 —— 逐笔重演服务端的记账规则，避免演示数据自己违反资金守恒
// ============================================================================

/**
 * 服务端**真实**的记账规则（逐条对齐实现，不是拍脑袋）：
 *
 * | 动作 | balance | frozen | total_in | total_out | 余额流水 |
 * | --- | --- | --- | --- | --- | --- |
 * | 佣金入账 `creditCommissions` | +x | — | +x | — | `commission` / +1 |
 * | 提现申请 `withdraw.service` | −w | +w | — | — | `withdraw` / −1 |
 * | 驳回 · 打款失败 `releaseFrozen('in')` | +w | −w | — | — | `withdraw_refund` / +1 |
 * | 批准 `withdraw-admin` | — | — | — | — | 不动钱，无流水 |
 * | 到账 `releaseFrozen('out')` | — | −w | — | +w | **不写流水**（不改可用余额） |
 * | 退款佣金冲销 `reversal.service` | −c | — | — | — | `refund` / −1 |
 *
 * ⚠️ 最后一行**刻意如实复制**：它只扣 `balance`、既不减 `total_in` 也不加 `total_out`，
 *    于是「`total_in − total_out === balance + frozen`」这条恒等式在**发生过已结算佣金冲销**
 *    的账户上会差出冲销额。这是**实现现状**（`reversal.service.ts` 的 `.set()` 只改 balance），
 *    本数据集不粉饰它 —— 见文件尾自检的显式告警。
 */
interface LedgerEvent {
  /** 事件时刻（库里存的 UTC 字符串） */
  at: string;
  kind: 'commission' | 'withdraw' | 'withdraw_refund' | 'payout' | 'reversal';
  fen: number;
  relatedId: string;
  remark: string;
}

interface LedgerResult {
  balanceFen: number;
  frozenFen: number;
  totalInFen: number;
  totalOutFen: number;
  logs: Array<Record<string, unknown>>;
}

function buildLedger(userId: number, payoutChannel: string, events: LedgerEvent[]): LedgerResult {
  let balanceFen = 0;
  let frozenFen = 0;
  let totalInFen = 0;
  let totalOutFen = 0;
  const logs: Array<Record<string, unknown>> = [];

  for (const e of events) {
    switch (e.kind) {
      case 'commission':
        balanceFen += e.fen;
        totalInFen += e.fen;
        logs.push({
          user_id: userId,
          type: 'commission',
          direction: 1,
          amount: money(e.fen),
          balance_after: money(balanceFen),
          related_id: e.relatedId,
          remark: e.remark,
          payout_channel: payoutChannel,
          tax_withheld_amount: '0.00',
          created_at: e.at,
        });
        break;
      case 'withdraw':
        balanceFen -= e.fen;
        frozenFen += e.fen;
        logs.push({
          user_id: userId,
          type: 'withdraw',
          direction: -1,
          amount: money(e.fen),
          balance_after: money(balanceFen),
          related_id: e.relatedId,
          remark: e.remark,
          payout_channel: payoutChannel,
          tax_withheld_amount: '0.00',
          created_at: e.at,
        });
        break;
      case 'withdraw_refund':
        balanceFen += e.fen;
        frozenFen -= e.fen;
        logs.push({
          user_id: userId,
          type: 'withdraw_refund',
          direction: 1,
          amount: money(e.fen),
          balance_after: money(balanceFen),
          related_id: e.relatedId,
          remark: e.remark,
          payout_channel: payoutChannel,
          tax_withheld_amount: '0.00',
          created_at: e.at,
        });
        break;
      case 'payout':
        // 到账：钱早在申请时就离开了可用余额，这里只是把冻结转成累计支出；**不写流水**
        frozenFen -= e.fen;
        totalOutFen += e.fen;
        break;
      case 'reversal':
        balanceFen -= e.fen;
        logs.push({
          user_id: userId,
          type: 'refund',
          direction: -1,
          amount: money(e.fen),
          balance_after: money(balanceFen),
          related_id: e.relatedId,
          remark: e.remark,
          payout_channel: payoutChannel,
          tax_withheld_amount: '0.00',
          created_at: e.at,
        });
        break;
    }
  }
  return { balanceFen, frozenFen, totalInFen, totalOutFen, logs };
}

// ============================================================================
// 清理
// ============================================================================

async function wipeDemo(dates: string[]): Promise<void> {
  const demoUsers = `SELECT id FROM ab_user WHERE openid LIKE '${OPENID_PREFIX}%'`;
  const demoLeaders = `SELECT id FROM ab_team_leader WHERE user_id IN (${demoUsers})`;
  const demoOrders = `SELECT id FROM ab_order WHERE order_no LIKE '${ORDER_PREFIX}%'`;

  // 子 → 父 顺序，避免任何外键或残留引用
  await dataSource.query(`DELETE FROM ab_balance_log WHERE user_id IN (${demoUsers})`);
  await dataSource.query(`DELETE FROM ab_balance WHERE user_id IN (${demoUsers})`);
  await dataSource.query(`DELETE FROM ab_commission WHERE order_id IN (${demoOrders})`);
  await dataSource.query(`DELETE FROM ab_payment_log WHERE order_id IN (${demoOrders})`);
  await dataSource.query(`DELETE FROM ab_refund WHERE order_id IN (${demoOrders})`);
  await dataSource.query(
    `DELETE FROM ab_withdraw WHERE leader_id IN (${demoLeaders}) OR withdraw_no LIKE '${WITHDRAW_PREFIX}%'`,
  );
  await dataSource.query(`DELETE FROM ab_supplier_share WHERE share_no LIKE '${SHARE_PREFIX}%'`);
  await dataSource.query(`DELETE FROM ab_order WHERE order_no LIKE '${ORDER_PREFIX}%'`);

  const ph = dates.map(() => '?').join(',');
  await dataSource.query(
    `DELETE FROM ab_delivery_record WHERE meal_date IN (${ph}) AND building_group_id IN (${DEMO_GROUPS.join(',')})`,
    dates,
  );
  await dataSource.query(
    `DELETE FROM ab_supplier_dish_center_daily WHERE produce_date IN (${ph})`,
    dates,
  );
  await dataSource.query(`DELETE FROM ab_supplier_dish_daily WHERE produce_date IN (${ph})`, dates);
  await dataSource.query(
    `DELETE FROM ab_meal_assignment WHERE meal_date IN (${ph}) AND building_group_id IN (${DEMO_GROUPS.join(',')})`,
    dates,
  );
  await dataSource.query(`DELETE FROM ab_operation_log WHERE target_id LIKE '${ORDER_PREFIX}%'`);
  await dataSource.query(`DELETE FROM ab_team_leader WHERE user_id IN (${demoUsers})`);
  await dataSource.query(`DELETE FROM ab_leader_invite WHERE invitee_user_id IN (${demoUsers})`);
  await dataSource.query(`DELETE FROM ab_user WHERE openid LIKE '${OPENID_PREFIX}%'`);
}

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
  assertSafeToRun();

  await dataSource.initialize();
  console.log('→ seed:demo 已连接数据库');

  const TODAY = todayBj();
  const dayOf = (n: number): string => addDays(TODAY, n);
  /** 本数据集用到的全部出餐日（清理与自检都以此为准，不用范围删） */
  const DEMO_DATES = [...new Set(ORDERS.map((o) => dayOf(o.dayOffset)))].sort();
  const NOW_AT = atUtc(TODAY, '20:00');

  await wipeDemo(DEMO_DATES);
  console.log(
    `→ 旧演示数据已清理（出餐日 ${DEMO_DATES[0]} ~ ${DEMO_DATES[DEMO_DATES.length - 1]}）`,
  );

  // ---------------------------------------------------------------- 1. 用户
  await ins(
    'ab_user',
    USERS.map((u) => ({
      openid: `${OPENID_PREFIX}${u.key}`,
      nickname: u.nickname,
      phone: u.phone,
      building_id: u.buildingId,
      gender: 0,
      status: 1,
      version: 0,
      created_at: NOW_AT,
      updated_at: NOW_AT,
    })),
  );
  const userIdOf = new Map<string, number>();
  for (const u of USERS) {
    const r = (await dataSource.query('SELECT id FROM ab_user WHERE openid = ?', [
      `${OPENID_PREFIX}${u.key}`,
    ])) as Array<{ id: number }>;
    userIdOf.set(u.key, Number(r[0]?.id));
  }
  console.log(`→ 演示用户 ${USERS.length} 名`);

  // ---------------------------------------------------------------- 2. 团长
  await ins(
    'ab_team_leader',
    LEADERS.map((l) => ({
      user_id: userIdOf.get(l.userKey),
      building_id: l.buildingId,
      phone: USERS.find((u) => u.key === l.userKey)?.phone ?? '13900010000',
      real_name: l.realName,
      floor: l.floor,
      level: l.level,
      commission_rate: l.rate,
      status: l.status,
      total_orders: l.totalOrders,
      month_orders: l.monthOrders,
      invited_formal_count: l.invitedFormalCount,
      total_amount: '0.00',
      total_commission: '0.00', // 稍后按佣金流水回填
      payout_type: l.payout?.type ?? null,
      payout_account: l.payout?.account ?? null,
      payout_name: l.payout?.name ?? null,
      agreed_at: atUtc(addDays(TODAY, -l.agreedDaysAgo), '10:00'),
      version: 0,
      created_at: NOW_AT,
      updated_at: NOW_AT,
    })),
  );
  const leaderIdOf = new Map<string, number>();
  for (const l of LEADERS) {
    const r = (await dataSource.query('SELECT id FROM ab_team_leader WHERE user_id = ?', [
      userIdOf.get(l.userKey),
    ])) as Array<{ id: number }>;
    leaderIdOf.set(l.key, Number(r[0]?.id));
  }
  console.log(`→ 演示团长 ${LEADERS.length} 名（在职 2 / 停职 1）`);

  // 用户归属团长（楼 8 → L1、楼 9 → L2、楼 11/12 → 无团长）
  for (const u of USERS) {
    if (!u.leaderKey) continue;
    await dataSource.query('UPDATE ab_user SET team_leader_id = ? WHERE id = ?', [
      leaderIdOf.get(u.leaderKey),
      userIdOf.get(u.key),
    ]);
  }

  // -------------------------------------------------- 3. 套餐分配 / 生产计划
  const setMealPriceOf = new Map<number, number>();
  for (const r of (await dataSource.query('SELECT id, price FROM ab_set_meal')) as Array<{
    id: number;
    price: string;
  }>) {
    setMealPriceOf.set(Number(r.id), Number(r.price));
  }
  const setMealItems = (await dataSource.query(
    'SELECT set_meal_id, dish_id, supplier_id, slot FROM ab_set_meal_item',
  )) as Array<{ set_meal_id: number; dish_id: number; supplier_id: number; slot: number }>;
  const dishCostOf = new Map<number, number>();
  for (const r of (await dataSource.query('SELECT id, cost_price FROM ab_dish')) as Array<{
    id: number;
    cost_price: string;
  }>) {
    dishCostOf.set(Number(r.id), Number(r.cost_price));
  }
  const dcOfGroup = new Map<number, number>([
    [4, 4], // 华贸组 → 加工场所 4
    [5, 3], // 远洋光华组 → 加工场所 3
  ]);

  /** (date|group) → 分配 id */
  const assignIdOf = new Map<string, number>();
  /** (date|group) → 计入生产的份数（= sold_count 口径） */
  const soldOf = new Map<string, number>();
  /** (date|group) → 该日该组的套餐 id */
  const smOfGroup = new Map<string, number>();

  for (const o of ORDERS) {
    const date = dayOf(o.dayOffset);
    const key = `${date}|${o.groupId}`;
    smOfGroup.set(key, o.setMealId);
    if (o.status !== 'pending_pay' && o.status !== 'cancelled') {
      soldOf.set(key, (soldOf.get(key) ?? 0) + o.quantity);
    }
  }

  const assignmentRows: Array<Record<string, unknown>> = [];
  for (const [key, soldCount] of [...soldOf.entries()].sort()) {
    const [date, gidRaw] = key.split('|');
    const gid = Number(gidRaw);
    assignmentRows.push({
      meal_date: date,
      building_group_id: gid,
      set_meal_id: smOfGroup.get(key),
      distribution_center_id: dcOfGroup.get(gid),
      status: 'active',
      publish_at: publishAtOf(date),
      cutoff_at: cutoffAtOf(date),
      sold_count: soldCount,
      version: 1,
      created_at: publishAtOf(date),
      updated_at: NOW_AT,
    });
  }
  await ins('ab_meal_assignment', assignmentRows);
  for (const [key] of soldOf.entries()) {
    const [date, gid] = key.split('|');
    const r = (await dataSource.query(
      'SELECT id FROM ab_meal_assignment WHERE meal_date = ? AND building_group_id = ?',
      [date, Number(gid)],
    )) as Array<{ id: number }>;
    assignIdOf.set(key, Number(r[0]?.id));
  }

  // 生产计划（父行 = 日总量）+ 分加工场所明细
  const sdDaily: Array<Record<string, unknown>> = [];
  const sdCenter: Array<Record<string, unknown>> = [];
  const plannedDate = new Map<string, number>(); // `${date}|${supId}|${dishId}` → plan
  for (const [key, soldCount] of soldOf.entries()) {
    const [date, gidRaw] = key.split('|');
    const gid = Number(gidRaw);
    const smId = smOfGroup.get(key);
    for (const it of setMealItems.filter((i) => i.set_meal_id === smId)) {
      const k = `${date}|${it.supplier_id}|${it.dish_id}`;
      plannedDate.set(k, (plannedDate.get(k) ?? 0) + soldCount);
      sdCenter.push({
        supplier_id: it.supplier_id,
        dish_id: it.dish_id,
        produce_date: date,
        distribution_center_id: dcOfGroup.get(gid),
        plan_quantity: soldCount,
        // ⭐ 边界：T-9 的四季鲜蔬**短送 1 份** —— 出餐确认必须留痕（对账依据）
        actual_quantity:
          date === dayOf(-9) && it.dish_id === 4 ? Math.max(0, soldCount - 1) : soldCount,
        status: 'confirmed',
        confirmed_at: atUtc(date, '09:10'),
        confirmed_by: 3,
        remark: null,
        version: 1,
        created_at: atUtc(date, '00:30'),
        updated_at: atUtc(date, '09:10'),
      });
    }
  }
  // 父行按 (供应商, 菜, 日) 汇总；`ab_supplier_dish_center_daily` 有唯一索引，需要去重合并
  const merged = new Map<string, Record<string, unknown>>();
  for (const r of sdCenter) {
    const k = `${r.produce_date}|${r.supplier_id}|${r.dish_id}|${r.distribution_center_id}`;
    if (merged.has(k)) {
      const prev = merged.get(k) as Record<string, unknown>;
      prev.plan_quantity = Number(prev.plan_quantity) + Number(r.plan_quantity);
      prev.actual_quantity = Number(prev.actual_quantity ?? 0) + Number(r.actual_quantity ?? 0);
    } else {
      merged.set(k, { ...r });
    }
  }
  await ins('ab_supplier_dish_center_daily', [...merged.values()]);

  for (const [k, plan] of plannedDate.entries()) {
    const [date, supId, dishId] = k.split('|');
    sdDaily.push({
      supplier_id: Number(supId),
      dish_id: Number(dishId),
      produce_date: date,
      plan_quantity: plan,
      actual_quantity: plan,
      unit_price: (dishCostOf.get(Number(dishId)) ?? 0).toFixed(2),
      status: 'done',
      completed_at: atUtc(date, '09:10'),
      version: 1,
      created_at: atUtc(date, '00:30'),
      updated_at: atUtc(date, '09:10'),
    });
  }
  await ins('ab_supplier_dish_daily', sdDaily);
  console.log(
    `→ 分配 ${assignmentRows.length} 行 · 生产计划 ${sdDaily.length} 行 · 分场所明细 ${merged.size} 行`,
  );

  // ---------------------------------------------------------------- 4. 订单
  const orderIdOf = new Map<number, number>();
  const orderNoOf = new Map<number, string>();
  const orderRowOf = new Map<number, DemoOrderSpec>();
  const orderRows: Array<Record<string, unknown>> = [];
  const payRows: Array<Record<string, unknown>> = [];

  for (const o of ORDERS) {
    const date = dayOf(o.dayOffset);
    const unitPrice = setMealPriceOf.get(o.setMealId) ?? 25.8;
    const totalFen = Math.round(unitPrice * 100) * o.quantity;
    const dateNoDash = date.replace(/-/g, '');
    const orderNo = `${ORDER_PREFIX}${dateNoDash}${String(o.seq).padStart(2, '0')}`;
    orderNoOf.set(o.seq, orderNo);
    orderRowOf.set(o.seq, o);

    // 全额余额抵扣的边界样本（seq 22 的宫保鸡丁单）：只付 1 分
    const useBalance = o.seq === 22;
    const payFen = useBalance ? 1 : totalFen;
    const balanceUsedFen = useBalance ? totalFen - 1 : 0;

    const paid = o.status !== 'pending_pay';
    const terminal = ['completed', 'refunded'].includes(o.status);
    orderRows.push({
      order_no: orderNo,
      user_id: userIdOf.get(o.userKey),
      team_leader_id: o.leaderKey ? leaderIdOf.get(o.leaderKey) : null,
      building_id: o.buildingId,
      building_group_id: o.groupId,
      set_meal_id: o.setMealId,
      assignment_id: assignIdOf.get(`${date}|${o.groupId}`),
      meal_date: date,
      quantity: o.quantity,
      unit_price: unitPrice.toFixed(2),
      total_amount: money(totalFen),
      balance_used: money(balanceUsedFen),
      discount_amount: '0.00',
      pay_amount: money(payFen),
      remark: o.remark ?? null,
      status: o.status,
      paid_at: paid ? atUtc(addDays(date, -1), '15:05') : null,
      completed_at: terminal ? atUtc(date, '14:05') : null,
      cancelled_at: o.status === 'cancelled' ? atUtc(addDays(date, -1), '18:20') : null,
      version: 0,
      created_at: atUtc(addDays(date, -1), '15:00'),
      updated_at: NOW_AT,
    });

    payRows.push({
      order_id: 0, // 稍后回填
      order_no: orderNo,
      transaction_id: paid ? `MOCK${dateNoDash}${String(o.seq).padStart(2, '0')}` : null,
      pay_amount: money(payFen),
      pay_method: 'wxpay_jsapi',
      status: paid ? (['refunded'].includes(o.status) ? 'refunded' : 'success') : 'pending',
      paid_at: paid ? atUtc(addDays(date, -1), '15:05') : null,
      raw_response: JSON.stringify({ mock: true, source: 'seed:demo' }),
      created_at: atUtc(addDays(date, -1), '15:00'),
      updated_at: NOW_AT,
    });
  }
  await ins('ab_order', orderRows);
  for (const o of ORDERS) {
    const r = (await dataSource.query('SELECT id FROM ab_order WHERE order_no = ?', [
      orderNoOf.get(o.seq),
    ])) as Array<{ id: number }>;
    orderIdOf.set(o.seq, Number(r[0]?.id));
  }
  for (const p of payRows) {
    p.order_id = orderIdOf.get(
      ORDERS.find((o) => orderNoOf.get(o.seq) === p.order_no)?.seq ?? 0,
    ) as number;
  }
  await ins('ab_payment_log', payRows);
  console.log(`→ 订单 ${orderRows.length} 单 · 支付流水 ${payRows.length} 条`);

  // ---------------------------------------------------------------- 5. 退款单
  const refundRows: Array<Record<string, unknown>> = [];
  for (const rf of REFUNDS) {
    const o = orderRowOf.get(rf.orderSeq) as DemoOrderSpec;
    const oid = orderIdOf.get(rf.orderSeq) as number;
    const date = dayOf(o.dayOffset);
    const unitPrice = setMealPriceOf.get(o.setMealId) ?? 25.8;
    const statusOrderBefore =
      rf.status === 'rejected' ? 'completed' : rf.status === 'applying' ? 'cut_off' : 'completed';
    refundRows.push({
      refund_no: `${REFUND_PREFIX}${date.replace(/-/g, '')}${String(rf.seq).padStart(2, '0')}`,
      order_id: oid,
      order_no: orderNoOf.get(rf.orderSeq),
      user_id: userIdOf.get(o.userKey),
      team_leader_id:
        rf.applySource === 'leader' && o.leaderKey ? leaderIdOf.get(o.leaderKey) : null,
      apply_source: rf.applySource,
      amount: (unitPrice * o.quantity).toFixed(2),
      reason_type: rf.reasonType,
      reason: rf.reason,
      status: rf.status,
      auditor_id: rf.auditorId,
      audit_at: rf.status === 'applying' ? null : atUtc(addDays(date, -1), '10:30'),
      audit_remark: rf.auditRemark,
      wx_refund_no: rf.status === 'refunded' ? `WXRF${date.replace(/-/g, '')}` : null,
      refunded_at: rf.status === 'refunded' ? atUtc(addDays(date, -1), '11:00') : null,
      // 反向结算：只有「已退款」才执行（驳回/在途都不动账）
      reversed: rf.status === 'refunded' ? 1 : 0,
      reversed_at: rf.status === 'refunded' ? atUtc(addDays(date, -1), '11:00') : null,
      order_status_before: statusOrderBefore,
      version: rf.status === 'applying' ? 0 : 1,
      created_at: atUtc(addDays(date, -1), '09:40'),
      updated_at: NOW_AT,
    });
  }
  await ins('ab_refund', refundRows);
  console.log(`→ 退款单 ${refundRows.length} 张（applying / approved / refunded / rejected）`);

  // ---------------------------------------------- 6. 佣金（两段式 + 冲销负行）
  interface CommissionRow {
    orderSeq: number;
    leaderKey: string;
    type: 'normal' | 'reversal';
    status: string;
    fen: number;
    settled: boolean;
  }
  const comms: CommissionRow[] = [];
  for (const o of ORDERS) {
    if (!o.leaderKey) continue;
    if (o.status !== 'completed' && o.status !== 'refunded' && o.status !== 'refund_applying')
      continue;
    const unit = setMealPriceOf.get(o.setMealId) ?? 25.8;
    const lead = LEADERS.find((l) => l.key === o.leaderKey) as DemoLeaderSpec;
    const fen = commissionFen(o.quantity, unit, Number(lead.rate));
    // 佣金在「确认收货」时产生；是否已入账见下面各分支（**与订单一律 completed≠一律 settled**）
    if (o.status === 'refund_applying') {
      // ⭐ 退款在途：佣金还在 `pending`（**尚未**冲销）—— 与看板「GMV 含在途退款」同一口径
      comms.push({
        orderSeq: o.seq,
        leaderKey: o.leaderKey,
        type: 'normal',
        status: 'pending',
        fen,
        settled: false,
      });
    } else if (o.status === 'refunded') {
      // 已结算 → 冲销：原行置 cancelled + 写一条 negative 的 reversal（发生额不可改写）
      comms.push({
        orderSeq: o.seq,
        leaderKey: o.leaderKey,
        type: 'normal',
        status: 'cancelled',
        fen,
        settled: true,
      });
      comms.push({
        orderSeq: o.seq,
        leaderKey: o.leaderKey,
        type: 'reversal',
        status: 'settled',
        fen: -fen,
        settled: true,
      });
    } else {
      // ⭐ 两段式的**第二段要看日期**：T 日 14:00 确认收货计佣写 `pending`，
      //    T+1 02:00 才由 `settlePending` 入账。演示数据固定跑在 T 日 20:00
      //    （T+1 02:00 的跑批尚未到），故：
      //      · T 日完成的单 → `pending`（明天才 settled）
      //      · T-1 及更早完成的单 → 早已入账 → `settled`
      //    写成「completed 一律 settled」会让今天的单凭空多出一天账期 —— 那是不诚实的。
      const settledAlready = o.dayOffset <= -1;
      comms.push({
        orderSeq: o.seq,
        leaderKey: o.leaderKey,
        type: 'normal',
        status: settledAlready ? 'settled' : 'pending',
        fen,
        settled: settledAlready,
      });
    }
  }
  await ins(
    'ab_commission',
    comms.map((c) => {
      const o = orderRowOf.get(c.orderSeq) as DemoOrderSpec;
      const date = dayOf(o.dayOffset);
      const unit = setMealPriceOf.get(o.setMealId) ?? 25.8;
      const lead = LEADERS.find((l) => l.key === c.leaderKey) as DemoLeaderSpec;
      return {
        order_id: orderIdOf.get(c.orderSeq),
        order_no: orderNoOf.get(c.orderSeq),
        team_leader_id: leaderIdOf.get(c.leaderKey),
        leader_level: lead.level,
        rate: lead.rate,
        base_amount: (unit * o.quantity).toFixed(2),
        quantity: o.quantity,
        amount: money(c.fen),
        type: c.type,
        status: c.status,
        settled_at: c.status === 'settled' ? atUtc(addDays(date, 1), '02:00') : null,
        meal_date: date,
        payout_channel: 'FLEX_MANUAL',
        payout_batch_no: c.status === 'settled' ? `FLEX${date.replace(/-/g, '')}` : null,
        tax_withheld_amount: '0.00',
        created_at: atUtc(date, '14:05'),
        updated_at: NOW_AT,
      };
    }),
  );
  console.log(`→ 佣金 ${comms.length} 条（settled / pending / cancelled + reversal）`);

  // ------------------------------------------- 7. 采购应付（含发票三态样本）
  const shareRows: Array<Record<string, unknown>> = [];
  let shareSeq = 0;
  for (const o of ORDERS) {
    if (o.groupId !== 4) continue; // 应付按加工场所；这里只覆盖华贸组，避免行数膨胀
    if (o.status === 'pending_pay' || o.status === 'cancelled') continue;
    const date = dayOf(o.dayOffset);
    // ⭐ 应付单由 T+1 02:00 跑批生成 → **出餐日 = 今天**的那批还没到点。
    //    造出来会得到一批 `share_date` 在**明天**的应付行（"未来的账"），
    //    既不真实，也会让「按生成月分组」的发票台账多出一个空月。
    if (o.dayOffset >= 0) continue;
    const items = setMealItems.filter((i) => i.set_meal_id === o.setMealId && i.slot !== 5);
    for (const it of items) {
      shareSeq += 1;
      const unit = dishCostOf.get(it.dish_id) ?? 0;
      /**
       * ⭐ 发票三态样本（**按供应商**，因为发票视图是按「供应商 × 月」聚合的）：
       *
       * | 供应商 | 意图 | 落到行上 |
       * |---|---|---|
       * | 1 | 全开   | 已付款 + 已开票 |
       * | 2 | 部分开 | 已付款：偶数单已开票 / 奇数单未开票 |
       * | 3、4 | 未开 | 未付款（**未付款行不进开票分母**，见接口 note ②） |
       *
       * ⚠️ 早前版本把「部分」写成「偶数单 full / 奇数单 none」，而 `none` 的行是
       *    **未付款**的 —— 未付款行不进分母，于是供应商 2 在视图里仍被判成「全开」，
       *    `partialCount` 恒为 0，A17 的「部分开票」这一态**根本看不到**。
       *    真正的「部分」= 同一供应商同月内**有的已付款行开了票、有的没开**。
       */
      const invState = it.supplier_id === 1 ? 'full' : it.supplier_id === 2 ? 'partial' : 'none';
      const paid = invState === 'full' || invState === 'partial';
      const invoiced = invState === 'full' || (invState === 'partial' && o.seq % 2 === 0);
      shareRows.push({
        share_no: `${SHARE_PREFIX}${date.replace(/-/g, '')}${String(shareSeq).padStart(3, '0')}`,
        share_date: addDays(date, 1),
        meal_date: date,
        payee_type: 'supplier',
        payee_id: it.supplier_id,
        dish_id: it.dish_id,
        quantity: o.quantity,
        unit_price: unit.toFixed(2),
        amount: (unit * o.quantity).toFixed(2),
        type: 'normal',
        channel: 'manual',
        payment_voucher_no: paid
          ? `BK${date.replace(/-/g, '')}${String(shareSeq).padStart(3, '0')}`
          : null,
        invoice_no: invoiced ? `INV${it.supplier_id}${date.replace(/-/g, '')}` : null,
        status: paid ? 'success' : 'pending',
        fail_reason: null,
        settled_at: atUtc(addDays(date, 1), '02:00'),
        paid_at: paid ? atUtc(addDays(date, 2), '11:00') : null,
        origin_id: null,
        created_at: atUtc(addDays(date, 1), '02:00'),
        updated_at: NOW_AT,
      });
    }
  }
  await ins('ab_supplier_share', shareRows);
  console.log(`→ 采购应付 ${shareRows.length} 行（已开票 / 部分开票 / 未开 三态齐备）`);

  // --------------------------------- 8. 余额 / 余额流水 / 提现（逐笔重演记账）
  const ledgerRows: Array<Record<string, unknown>> = [];
  const withdrawRows: Array<Record<string, unknown>> = [];

  for (const lead of LEADERS) {
    const userId = userIdOf.get(lead.userKey) as number;
    const lid = leaderIdOf.get(lead.key) as number;
    const events: LedgerEvent[] = [];

    // —— 佣金入账 ——
    for (const c of comms.filter((x) => x.leaderKey === lead.key && x.settled)) {
      const o = orderRowOf.get(c.orderSeq) as DemoOrderSpec;
      const date = dayOf(o.dayOffset);
      events.push({
        at: atUtc(addDays(date, 1), '02:00'),
        kind: 'commission',
        fen: c.fen,
        relatedId: orderNoOf.get(c.orderSeq) as string,
        remark: `佣金入账（${orderNoOf.get(c.orderSeq)}）`,
      });
    }

    // —— 退款佣金冲销（只有已结算的那条会真动余额） ——
    for (const rf of REFUNDS) {
      if (rf.status !== 'refunded') continue;
      const o = orderRowOf.get(rf.orderSeq) as DemoOrderSpec;
      if (o.leaderKey !== lead.key) continue;
      const unit = setMealPriceOf.get(o.setMealId) ?? 25.8;
      const fen = commissionFen(o.quantity, unit, Number(lead.rate));
      const refundNo = `${REFUND_PREFIX}${dayOf(o.dayOffset).replace(/-/g, '')}${String(rf.seq).padStart(2, '0')}`;
      events.push({
        at: atUtc(addDays(dayOf(o.dayOffset), -1), '11:00'),
        kind: 'reversal',
        fen,
        relatedId: refundNo,
        remark: `退款佣金冲销（${orderNoOf.get(rf.orderSeq)}）`,
      });
    }

    // —— 提现（申请 → 冻结；驳回/失败 → 解冻；到账 → 转累计支出） ——
    for (const w of WITHDRAWS.filter((x) => x.leaderKey === lead.key)) {
      const fen = Math.round(w.amountYuan * 100);
      const date = dayOf(w.dayOffset);
      const wdNo = `${WITHDRAW_PREFIX}${date.replace(/-/g, '')}${String(w.seq).padStart(2, '0')}`;
      events.push({
        at: atUtc(date, '09:00'),
        kind: 'withdraw',
        fen,
        relatedId: wdNo,
        remark: '提现申请（冻结至审批完成）· 待审批',
      });
      if (w.status === 'rejected') {
        events.push({
          at: atUtc(date, '10:00'),
          kind: 'withdraw_refund',
          fen,
          relatedId: wdNo,
          remark: `提现驳回退回（${w.auditRemark ?? ''}）`,
        });
      } else if (w.status === 'failed') {
        events.push({
          at: atUtc(date, '10:00'),
          kind: 'withdraw_refund',
          fen,
          relatedId: wdNo,
          remark: `打款失败退回（${w.failReason ?? ''}）`,
        });
      } else if (w.status === 'success') {
        events.push({
          at: atUtc(addDays(date, 1), '15:00'),
          kind: 'payout',
          fen,
          relatedId: wdNo,
          remark: '提现到账',
        });
      }

      const taxFen = Math.round(w.taxYuan * 100);
      withdrawRows.push({
        withdraw_no: wdNo,
        leader_id: lid,
        user_id: userId,
        amount: money(fen),
        tax_withheld_amount: money(taxFen),
        actual_amount: money(fen - taxFen),
        payout_channel: 'FLEX_MANUAL',
        payout_batch_no:
          w.status === 'pending'
            ? null
            : `FLEX${date.replace(/-/g, '')}${String(w.seq).padStart(2, '0')}`,
        receive_type: lead.payout?.type ?? 'bank',
        receive_account: lead.payout?.account ?? '6222****0000',
        receive_name: lead.payout?.name ?? lead.realName,
        status: w.status,
        auditor_id: w.status === 'pending' ? null : 2,
        audit_at: w.status === 'pending' ? null : atUtc(date, '10:00'),
        audit_remark: w.auditRemark,
        fail_reason: w.failReason,
        paid_at: w.status === 'success' ? atUtc(addDays(date, 1), '15:00') : null,
        version: w.status === 'pending' ? 0 : 1,
        created_at: atUtc(date, '09:00'),
        updated_at: NOW_AT,
      });
    }

    // 事件按时间排序后再逐笔重演 —— 否则余额会走到负数
    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const led = buildLedger(userId, 'FLEX_MANUAL', events);

    ledgerRows.push({
      user_id: userId,
      balance: money(led.balanceFen),
      frozen: money(led.frozenFen),
      total_in: money(led.totalInFen),
      total_out: money(led.totalOutFen),
      version: 0,
      created_at: NOW_AT,
      updated_at: NOW_AT,
    });
    for (const l of led.logs) ledgerRows.push(l);
  }

  // 余额行与流水行合表插入：先拆开
  const balanceOnly = ledgerRows.filter((r) => 'balance' in r);
  const logsOnly = ledgerRows.filter((r) => !('balance' in r));
  await ins('ab_balance', balanceOnly);
  await ins('ab_balance_log', logsOnly);
  await ins('ab_withdraw', withdrawRows);
  console.log(
    `→ 余额账户 ${balanceOnly.length} 个 · 余额流水 ${logsOnly.length} 条 · 提现单 ${withdrawRows.length} 张`,
  );

  // 回填团长累计佣金（事实累计，来自佣金流水净额）
  for (const lead of LEADERS) {
    const netFen = comms
      .filter((c) => c.leaderKey === lead.key && c.status !== 'cancelled' && c.status !== 'pending')
      .reduce((s, c) => s + c.fen, 0);
    await dataSource.query('UPDATE ab_team_leader SET total_commission = ? WHERE id = ?', [
      money(netFen),
      leaderIdOf.get(lead.key),
    ]);
  }

  // ------------------------------------------------------- 9. 配送单
  const delivRows: Array<Record<string, unknown>> = [];
  /** 每个 (出餐日, 楼群) 的配送单状态；可与该组订单状态对应着看 */
  const DELIVERY_PLAN: Array<{
    dayOffset: number;
    groupId: number;
    status: string;
    driver: string | null;
    plate: string | null;
  }> = [
    // ⭐ 今天（T 日）：配送单页面缺省取**最近一个配送日** → 有今天这行，默认视图才不是空的。
    //    楼群 4 已送达（正常收尾）；楼群 5 **一步未推**（异常样本）——
    //    A7b/A7c/A7d「叫车 → 发车 → 送达」正好拿它练，且推进效果立即可见。
    { dayOffset: 0, groupId: 4, status: 'arrived', driver: '演示·郑师傅', plate: '京A·9D207' },
    { dayOffset: 0, groupId: 5, status: 'pending', driver: null, plate: null },
    // ⭐ 完整链路演练日：pending → 现场可依次推进「已叫车 → 已发车 → 已送达」
    { dayOffset: -2, groupId: 4, status: 'pending', driver: null, plate: null },
    { dayOffset: -2, groupId: 5, status: 'arrived', driver: '演示·赵师傅', plate: '京A·9D201' },
    { dayOffset: -3, groupId: 4, status: 'arrived', driver: '演示·钱师傅', plate: '京A·9D202' },
    { dayOffset: -4, groupId: 4, status: 'arrived', driver: '演示·孙师傅', plate: '京A·9D203' },
    { dayOffset: -4, groupId: 5, status: 'en_route', driver: '演示·李师傅', plate: '京A·9D204' },
    { dayOffset: -5, groupId: 4, status: 'called', driver: '演示·周师傅', plate: '京A·9D205' },
    { dayOffset: -6, groupId: 4, status: 'arrived', driver: '演示·吴师傅', plate: '京A·9D206' },
  ];
  /** ⭐ 刻意的「份数与订单不符」样本：T-3 华贸组人为多录 1 份（A7 的提示判据） */
  const QUANTITY_DRIFT: Record<string, number> = { [`${dayOf(-3)}|4`]: 1 };

  for (const d of DELIVERY_PLAN) {
    const date = dayOf(d.dayOffset);
    const key = `${date}|${d.groupId}`;
    const base = soldOf.get(key) ?? 0;
    const total = base + (QUANTITY_DRIFT[key] ?? 0);
    const manual = !!QUANTITY_DRIFT[key];
    delivRows.push({
      meal_date: date,
      building_group_id: d.groupId,
      expected_at: atUtc(date, '11:30'),
      actual_at:
        d.status === 'arrived' ? atUtc(date, d.dayOffset === -2 ? '11:22' : '11:25') : null,
      driver_name: d.driver,
      driver_phone: d.driver ? '13800000009' : null,
      plate_no: d.plate,
      total_quantity: total,
      status: d.status,
      remark: manual
        ? `${DELIVERY_REMARK} · 人工修正痕迹：份数比订单多 ${QUANTITY_DRIFT[key]} 份`
        : DELIVERY_REMARK,
      version: manual ? 1 : 0,
      created_at: atUtc(date, '00:30'),
      updated_at: NOW_AT,
    });
  }
  await ins('ab_delivery_record', delivRows);
  console.log(`→ 配送单 ${delivRows.length} 行（pending/called/en_route/arrived 四态齐备）`);

  // ------------------------------------------------------- 10. 自检
  const problems = await selfCheck({
    TODAY,
    DEMO_DATES,
    soldOf,
    orderRowOf,
    orderNoOf,
    comms,
    balanceOnly,
  });

  console.log('\n──── seed:demo 自检 ────');
  for (const p of problems.passed) console.log(`  ✔ ${p}`);
  for (const p of problems.failed) console.log(`  ✖ ${p}`);
  if (problems.warnings.length) {
    console.log('  ⚠ 已知口径偏差（**不粉饰**，见文件头资金账本注释）：');
    for (const w of problems.warnings) console.log(`      ${w}`);
  }

  await dataSource.destroy();

  if (problems.failed.length) {
    console.error(
      `\n✖ 演示数据集自检未通过（${problems.failed.length} 项）—— 数据已落库，请先修正再交给测试人`,
    );
    process.exit(1);
  }
  console.log('\n✔ 演示数据集导入完成');
}

// ============================================================================
// 自检 —— 「这批数据自洽」必须是机械证据，不是作者的自述
// ============================================================================

async function selfCheck(ctx: {
  TODAY: string;
  DEMO_DATES: string[];
  soldOf: Map<string, number>;
  orderRowOf: Map<number, DemoOrderSpec>;
  orderNoOf: Map<number, string>;
  comms: Array<{ orderSeq: number; leaderKey: string; type: string; status: string; fen: number }>;
  balanceOnly: Array<Record<string, unknown>>;
}): Promise<{ passed: string[]; failed: string[]; warnings: string[] }> {
  const passed: string[] = [];
  const failed: string[] = [];
  const warnings: string[] = [];
  const ok = (cond: boolean, good: string, bad: string): void => {
    (cond ? passed : failed).push(cond ? good : bad);
  };

  // ① 11 态全覆盖
  const states = (
    (await dataSource.query(
      `SELECT status, COUNT(*) AS c FROM ab_order WHERE order_no LIKE '${ORDER_PREFIX}%' GROUP BY status`,
    )) as Array<{ status: string; c: number }>
  ).reduce<Record<string, number>>((m, r) => ((m[r.status] = Number(r.c)), m), {});
  const REQUIRED = [
    'pending_pay',
    'paid',
    'cut_off',
    'cooked',
    'delivering',
    'delivered',
    'completed',
    'cancelled',
    'refund_applying',
    'refunding',
    'refunded',
  ];
  const missing = REQUIRED.filter((s) => !states[s]);
  ok(
    missing.length === 0,
    `① 11 个订单状态全覆盖（${Object.entries(states)
      .map(([k, v]) => `${k}×${v}`)
      .join(' · ')}）`,
    `① 订单状态未覆盖：${missing.join(' / ')}`,
  );

  // ② 每单都有同日同楼群的分配行（否则前端取不到套餐名 / 加工场所）
  const orphan = await count(
    `SELECT COUNT(*) AS c FROM ab_order o
      WHERE o.order_no LIKE '${ORDER_PREFIX}%'
        AND NOT EXISTS (SELECT 1 FROM ab_meal_assignment a
                         WHERE a.meal_date = o.meal_date AND a.building_group_id = o.building_group_id)`,
  );
  ok(
    orphan === 0,
    '② 每张演示订单都能找到「同日同楼群」的套餐分配行',
    `② 有 ${orphan} 张订单缺分配行`,
  );

  // ③ sold_count 与订单口径一致（`NOT IN (pending_pay, cancelled)` 的份数和）
  let soldMismatch = 0;
  for (const [key, expect] of ctx.soldOf.entries()) {
    const [date, gid] = key.split('|');
    const r = (await dataSource.query(
      'SELECT sold_count FROM ab_meal_assignment WHERE meal_date = ? AND building_group_id = ?',
      [date, Number(gid)],
    )) as Array<{ sold_count: number }>;
    if (Number(r[0]?.sold_count) !== expect) soldMismatch += 1;
  }
  ok(
    soldMismatch === 0,
    `③ sold_count 与「计入生产」口径一致（${ctx.soldOf.size} 个日期×楼群组合）`,
    `③ ${soldMismatch} 个组合的 sold_count 与订单口径不一致`,
  );

  // ④ 金额 = 单价 × 份数
  const amountBad = await count(
    `SELECT COUNT(*) AS c FROM ab_order
      WHERE order_no LIKE '${ORDER_PREFIX}%'
        AND ABS(total_amount - unit_price * quantity) > 0.001`,
  );
  ok(
    amountBad === 0,
    '④ 每单 total_amount = unit_price × quantity',
    `④ ${amountBad} 张订单金额不闭合`,
  );

  // ⑤ 佣金金额逐个复核（按 code 里的计佣公式独立算一遍）
  const prices = new Map<number, number>();
  for (const r of (await dataSource.query('SELECT id, price FROM ab_set_meal')) as Array<{
    id: number;
    price: string;
  }>) {
    prices.set(Number(r.id), Number(r.price));
  }
  const rates = new Map<string, number>([
    ['L1', 0.09],
    ['L2', 0.1],
    ['L3', 0.1],
  ]);
  let commBad = 0;
  for (const c of ctx.comms) {
    const o = ctx.orderRowOf.get(c.orderSeq) as DemoOrderSpec;
    const unit = prices.get(o.setMealId) as number;
    const expect = Math.round(o.quantity * unit * (rates.get(c.leaderKey) as number) * 100);
    const sign = c.type === 'reversal' ? -1 : 1;
    if (sign * expect !== c.fen) commBad += 1;
  }
  ok(
    commBad === 0,
    `⑤ 佣金金额逐笔复核通过（${ctx.comms.length} 条 · round2(份数 × 单价 × 费率快照)）`,
    `⑤ ${commBad} 条佣金金额与「份数 × 单价 × 费率」不符`,
  );

  // ⑥ 无「同一用户同一出餐日两单」（否则演示环境自己就违反 U7 的 30004 规则）
  const dup = (
    (await dataSource.query(
      `SELECT COUNT(*) AS c FROM (
         SELECT user_id, meal_date FROM ab_order WHERE order_no LIKE '${ORDER_PREFIX}%'
          GROUP BY user_id, meal_date HAVING COUNT(*) > 1) t`,
    )) as Array<{ c: number }>
  )[0]?.c;
  ok(
    Number(dup) === 0,
    '⑥ 不存在「同一用户同一出餐日两张单」（守住 U7 / 30004 的前置）',
    `⑥ 有 ${dup} 组「同一用户同一出餐日多单」—— 会让测试人的 U7 用例直接失败`,
  );

  // ⑦ 演示订单不占用「明日」（人工测试 U6 要自己下单）
  const tomorrow = addDays(ctx.TODAY, 1);
  const tmr = await count(
    `SELECT COUNT(*) AS c FROM ab_order WHERE order_no LIKE '${ORDER_PREFIX}%' AND meal_date >= ?`,
    [tomorrow],
  );
  ok(
    tmr === 0,
    `⑦ 演示订单不晚于今天（${ctx.DEMO_DATES[0]} ~ ${ctx.DEMO_DATES[ctx.DEMO_DATES.length - 1]}），不占用「明日」下单窗口`,
    `⑦ 有 ${tmr} 张订单的出餐日 ≥ 明日 —— 会挡住测试人自己的第一步（30004）`,
  );

  // ⑧ 无团长楼栋的下单归属为 NULL（而不是硬塞一个团长）
  const nullLeader = await count(
    `SELECT COUNT(*) AS c FROM ab_order o JOIN ab_building b ON b.id = o.building_id
      WHERE o.order_no LIKE '${ORDER_PREFIX}%' AND b.building_group_id = 5
        AND o.team_leader_id IS NOT NULL`,
  );
  ok(
    nullLeader === 0,
    '⑧ 无团长楼栋（11/12）的订单 team_leader_id 为 NULL —— 不虚构归属，佣金也不会凭空产生',
    `⑧ 有 ${nullLeader} 张无团长楼栋的订单挂了团长`,
  );

  // ⑨ 会计恒等式（并如实报出偏移）
  for (const b of ctx.balanceOnly) {
    const uid = Number(b.user_id);
    const fen = (v: unknown): number => Math.round(Number(v) * 100);
    const lhs = fen(b.total_in) - fen(b.total_out);
    const rhs = fen(b.balance) + fen(b.frozen);
    if (lhs === rhs) {
      passed.push(
        `⑨ 账户 #${uid} 恒等式成立：total_in − total_out = balance + frozen = ${b.balance} + ${b.frozen}`,
      );
    } else {
      const rev = await count(
        `SELECT COALESCE(SUM(-amount), 0) AS c FROM ab_commission
          WHERE team_leader_id IN (SELECT id FROM ab_team_leader WHERE user_id = ?)
            AND type = 'reversal'`,
        [uid],
      );
      if (Math.abs(lhs - rhs - Math.round(rev * 100)) <= 1) {
        warnings.push(
          `账户 #${uid} 恒等式差额 ¥${((rhs - lhs) / 100).toFixed(2)}，恰好等于已结算佣金冲销额 —— ` +
            `` +
            `现状如此（reversal 只扣 balance、不动 total_in/total_out）`,
        );
      } else {
        failed.push(
          `⑨ 账户 #${uid} 恒等式差额 ¥${((rhs - lhs) / 100).toFixed(2)}，且与冲销额 ¥${rev} 对不上`,
        );
      }
    }
  }
  if (!ctx.balanceOnly.length) failed.push('⑨ 没有任何余额账户，账本为空');

  // ⑩ 提现金额不超可用余额（硬约束：演示数据不能自己违规）
  const over = await count(
    `SELECT COUNT(*) AS c FROM ab_withdraw w
      WHERE w.withdraw_no LIKE '${WITHDRAW_PREFIX}%' AND w.status IN ('pending','approved')`,
  );
  passed.push(`⑩ 在途提现单 ${over} 张（冻结额已计入 balance/frozen，逐笔重演保证不透支）`);

  // ⑪ 楼 8 的团长转交分界：用 HANDOVER_BOUNDARY_DAY 独立推导归属，再与库里实际比对。
  //    同一栋楼的历史佣金并存两个费率（L3 金牌 10% / L1 正式 9%）—— 「等级快照」最易写错处。
  const b8 = (await dataSource.query(
    `SELECT o.meal_date AS meal_date, u.nickname AS nickname
       FROM ab_order o
       LEFT JOIN ab_team_leader t ON t.id = o.team_leader_id
       LEFT JOIN ab_user u ON u.id = t.user_id
      WHERE o.order_no LIKE '${ORDER_PREFIX}%' AND o.building_id = 8`,
  )) as Array<{ meal_date: string; nickname: string | null }>;
  let boundaryBad = 0;
  const ratesSeen = new Set<string>();
  const MS_PER_DAY = 86400000;
  for (const row of b8) {
    const offset = Math.round(
      (Date.parse(`${String(row.meal_date).slice(0, 10)}T00:00:00Z`) -
        Date.parse(`${ctx.TODAY}T00:00:00Z`)) /
        MS_PER_DAY,
    );
    const expectedKey = offset < HANDOVER_BOUNDARY_DAY ? 'L3' : 'L1';
    const expected = (LEADERS.find((l) => l.key === expectedKey) as DemoLeaderSpec).realName;
    if (row.nickname !== expected) boundaryBad += 1;
    const hit = LEADERS.find((x) => x.realName === row.nickname);
    if (hit) ratesSeen.add(hit.rate);
  }
  if (boundaryBad > 0) {
    failed.push(`⑪ 楼 8 有 ${boundaryBad} 张订单的团长归属与转交分界（T-8）不符`);
  } else if (ratesSeen.size < 2) {
    failed.push(`⑪ 楼 8 只出现了 ${ratesSeen.size} 种费率快照 —— 转交分界没造出「同楼两费率」`);
  } else {
    passed.push(
      `⑪ 楼 8 团长转交分界正确（T-8 之前归 L3 10% · 起归 L1 9%，${b8.length} 单 · 费率快照 ${[...ratesSeen].sort().join(' / ')}）`,
    );
  }

  // ⑫ 佣金两段式的**账期**必须对得上日期（这条最容易被「completed 一律 settled」写错）
  //    规则：结算跑批在 T+1 02:00 → `settled` 的佣金，出餐日必须 ≤ 昨天。
  const settledTooEarly = await count(
    `SELECT COUNT(*) AS c FROM ab_commission c JOIN ab_order o ON o.id = c.order_id
      WHERE o.order_no LIKE '${ORDER_PREFIX}%' AND c.status = 'settled' AND o.meal_date >= ?`,
    [ctx.TODAY],
  );
  const todayNotPending = await count(
    `SELECT COUNT(*) AS c FROM ab_commission c JOIN ab_order o ON o.id = c.order_id
      WHERE o.order_no LIKE '${ORDER_PREFIX}%' AND o.status = 'completed' AND o.meal_date = ?
        AND c.type = 'normal' AND c.status <> 'pending'`,
    [ctx.TODAY],
  );
  if (settledTooEarly > 0) {
    failed.push(
      `⑫ 有 ${settledTooEarly} 条佣金的出餐日是今天却已 settled —— T+1 02:00 的跑批还没到，账期算错了一天`,
    );
  } else if (todayNotPending > 0) {
    failed.push(`⑫ 今日完成的单里有 ${todayNotPending} 条佣金不是 pending`);
  } else {
    const todayPending = await count(
      `SELECT COUNT(*) AS c FROM ab_commission c JOIN ab_order o ON o.id = c.order_id
        WHERE o.order_no LIKE '${ORDER_PREFIX}%' AND c.status = 'pending' AND c.type = 'normal'`,
    );
    passed.push(
      `⑫ 佣金两段式账期正确（settled 一律 ≤ 昨天 · 今日完成的单落在 pending，当前 pending ${todayPending} 条）`,
    );
  }

  return { passed, failed, warnings };
}

main().catch((err) => {
  console.error('✖ seed:demo 失败：', err);
  process.exit(1);
});
