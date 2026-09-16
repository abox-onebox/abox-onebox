/**
 * 办公楼 / 楼群管理域枚举（M3-7 · 《接口规范 v1.0》§6.3 D13–D18 · 原型 P37）
 *
 * ⚠️ 与 M3-4/M3-5/M3-6 同一纪律：**文案映射落 shared-types，端上不维护第二份**。
 *    后台表格 / Tag / 筛选器 / 套餐矩阵一律引用此处，避免「同一状态两个中文名」。
 *
 * ⚠️ 本文件的枚举值必须与 `ab_building.status` / `ab_building_group.status`
 *    的落库值逐字一致 —— 枚举是**契约**，不是展示层装饰。
 */

/**
 * 办公楼状态（`ab_building.status`）
 *
 * ⚠️ **三态，不是二态**。M3-7 之前的实体注释写的是「1 合作中 / 2 停用」，
 *    而种子数据把「国贸三期 C 座（待开通）」与「华贸 3 号楼（已暂停）」都塞进
 *    `status=2` —— 同一值两种语义，界面上只能都显示「停用」。
 *    原型 P37 的 KPI 卡明确区分「待开通 1 / 已暂停 1」，故本批次扩为三态：
 *
 *      1 营业中   —— 可分配套餐（进套餐矩阵的可选楼栋）
 *      2 待开通   —— 楼已建档、尚未开团（如新签楼栋，等团长到位）
 *      3 已暂停   —— 曾经开团、因故暂停（如华贸 3 号楼）
 *
 *    这是 **tinyint 值域扩展**（非结构变更，旧值 1 语义不变）；同时修复了
 *    「2 有两种含义」的数据缺陷。**只有 `1` 可开团**，2/3 在套餐编排里一律禁选。
 */
export enum BuildingStatus {
  /** 营业中：可分配套餐 */
  ACTIVE = 1,
  /** 待开通：已建档未开团 */
  PREPARING = 2,
  /** 已暂停：曾开团、现暂停 */
  SUSPENDED = 3,
}

export const BUILDING_STATUS_LABEL: Record<number, string> = {
  [BuildingStatus.ACTIVE]: '营业中',
  [BuildingStatus.PREPARING]: '待开通',
  [BuildingStatus.SUSPENDED]: '已暂停',
};

/** 状态下拉项（D13 筛选器 / D14 新增 / D15 编辑共用，避免多处写死顺序） */
export const BUILDING_STATUS_OPTIONS = (Object.values(BuildingStatus) as BuildingStatus[]).map(
  (value) => ({
    value,
    label: BUILDING_STATUS_LABEL[value],
  }),
);

/**
 * 楼群状态（`ab_building_group.status`）—— 保持二态
 *
 * ⚠️ **与办公楼状态刻意不同构**：楼群没有「待开通」这个中间态 ——
 *    楼群是**纯组织维度**（「多栋楼聚合成一个分发单位」），
 *    它要么在用于开团（1），要么停用（2）。「这栋楼还没开团」是楼栋的事实，
 *    不是楼群的事实；给楼群也加一个 PREPARING 只会让运营多一个要猜的选择。
 */
export enum BuildingGroupStatus {
  /** 启用：可参与套餐分配 */
  ACTIVE = 1,
  /** 停用：退出套餐分配（成员楼需先搬出，见 D18 闸门） */
  SUSPENDED = 2,
}

export const BUILDING_GROUP_STATUS_LABEL: Record<number, string> = {
  [BuildingGroupStatus.ACTIVE]: '启用',
  [BuildingGroupStatus.SUSPENDED]: '已停用',
};

/**
 * 楼群覆盖状态（**派生值，不落库** · D13/D16 出参）
 *
 * 回答的是「这栋楼（这个楼群）现在**能不能真的送得出去**」：
 * 楼群有成员楼、但没有启用中的集散中心覆盖 → 用户能下单、却没有主体接单配送。
 * 与 M3-6 的 `licenseState` / `canServe` 同一哲学：**现算不落库**（落库就要有刷表任务）。
 */
export enum GroupCoverageState {
  /** 已覆盖：至少 1 个启用中的集散中心服务该楼群 */
  COVERED = 'covered',
  /** 未覆盖：无任何启用中的集散中心服务该楼群（下单能成立、履约断链） */
  UNCOVERED = 'uncovered',
  /** 空楼群：尚无成员楼（新建楼群的初值，不算异常） */
  EMPTY = 'empty',
}

export const GROUP_COVERAGE_LABEL: Record<GroupCoverageState, string> = {
  [GroupCoverageState.COVERED]: '已覆盖',
  [GroupCoverageState.UNCOVERED]: '未覆盖',
  [GroupCoverageState.EMPTY]: '空楼群',
};

/**
 * 配送映射的覆盖缺口原因（**派生值** · D13 出参 `distributionGap`）
 *
 * ⚠️ 「送不出去」有三种完全不同的成因，端上要给出三种修法：
 *    · 楼未归群 → 去 P37 楼群划分把楼挂进楼群
 *    · 楼群无集散 → 去 P33 集散中心配置，把楼群加进某个集散中心的「服务楼群」
 *    · 楼群有集散但集散**已停用** → 去 P33 恢复该集散中心，或改挂另一个
 *  合成一个「未覆盖」文案会让运营只能猜。
 */
export enum DistributionGap {
  /** 无缺口（楼已归群 且 该群有启用中的集散中心） */
  NONE = 'none',
  /** 该楼未归属任何楼群 */
  NO_GROUP = 'no_group',
  /** 所属楼群无任何集散中心覆盖 */
  NO_CENTER = 'no_center',
  /** 楼群原有集散中心已全部停用 */
  ALL_CENTER_DISABLED = 'all_center_disabled',
}

export const DISTRIBUTION_GAP_LABEL: Record<DistributionGap, string> = {
  [DistributionGap.NONE]: '已覆盖',
  [DistributionGap.NO_GROUP]: '未归入楼群',
  [DistributionGap.NO_CENTER]: '楼群无集散中心',
  [DistributionGap.ALL_CENTER_DISABLED]: '集散中心已停用',
};
