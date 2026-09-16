/**
 * 团长在职状态（`ab_team_leader.status` · tinyint）
 *
 * ⚠️ **2026-09-15 裁定：以实体为准。**
 *    《接口规范》曾把该字段写作 `status='active'`（字符串），与实体不符 ——
 *    24 张表其余状态位统一为 tinyint（`1` 正常/在职），故此处统一为数值枚举，
 *    文档已同步回改为 `status = 1（在职）`（见《接口规范》§1.5 / §4.5 / §4.7）。
 *
 * 引用方：`auth.service`（签发 `isLeader`）· `order.service`（邀请码校验 30007）·
 *        `LeaderGuard`（`/leader/*` 二次校验）—— 三处必须同源，禁止再写字面量。
 */
export enum LeaderStatus {
  /** 在职：可接单、可访问 `/leader/*` */
  ACTIVE = 1,
  /** 停职：后台停用，或见习 30 天未促单自动取消资格（C2） */
  SUSPENDED = 2,
}

/**
 * 在职状态文案（M3-5 · D19 名录 / 筛选器 / 操作日志共用）
 *
 * ⚠️ 文案必须与 P32 原型一致：原型用「在职 / 停职」而非「启用 / 停用」——
 *    后者是**账号**口径（D53），团长是**任职关系**，混用会让运营以为
 *    「停用」等于注销账号，从而不敢操作。
 */
export const LEADER_STATUS_LABEL: Record<LeaderStatus, string> = {
  [LeaderStatus.ACTIVE]: '在职',
  [LeaderStatus.SUSPENDED]: '停职',
};
