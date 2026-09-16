/**
 * 后台 · 团长管理的枚举与文案映射（M3-5 · 《接口规范》§6.3 D19–D22）
 *
 * ⚠️ **文案单一事实来源**：与 M3-4 的 `REFUND_STATUS_LABEL` 同一纪律 ——
 *    label 放共享包，后台列表/筛选器/操作日志共用一份，
 *    **端上不维护第二份映射**（否则改一处忘一处，筛选器与列表就不同名）。
 */

/**
 * D22 团长资质补录 / 例外处理动作
 *
 * 【为什么与 D21 分开】
 *   D21（`PUT /admin/leaders/:id`）是**常规变更**（等级 / 所属办公楼 / 楼层）——
 *   对象是「团长档案的属性」。
 *   D22 是**例外处理的留痕动作** —— 对象是「发生了一件需要留档的事」：
 *   违规停用、恢复在职、协议补签、资质备注。
 *   两者共用 status 字段但不共用入口：停用**只走 D22**（单一入口），
 *   D21 刻意不接受 `status`，避免运营在两个入口之间猜「哪个才是真入口」。
 */
export enum LeaderAuditAction {
  /** 例外停用（违规 / 恶意申请）—— `status` 置 2 */
  SUSPEND = 'suspend',
  /** 恢复在职 —— `status` 置 1 */
  RESTORE = 'restore',
  /** 协议补签（历史团长未留痕 / 协议升级重签） */
  SIGN_AGREEMENT = 'sign_agreement',
  /** 资质备注（只留痕，不改任何状态） */
  NOTE = 'note',
}

export const LEADER_AUDIT_ACTION_LABEL: Record<LeaderAuditAction, string> = {
  [LeaderAuditAction.SUSPEND]: '例外停用',
  [LeaderAuditAction.RESTORE]: '恢复在职',
  [LeaderAuditAction.SIGN_AGREEMENT]: '协议补签',
  [LeaderAuditAction.NOTE]: '资质备注',
};

/** 会改变在职状态的动作（服务层据此决定是否写 status / 清 user.team_leader_id） */
export const LEADER_AUDIT_STATUS_ACTIONS: readonly LeaderAuditAction[] = [
  LeaderAuditAction.SUSPEND,
  LeaderAuditAction.RESTORE,
];
