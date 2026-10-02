/**
 * api/building —— 用户端「自助选楼」（`GET /building`）
 *
 * ⚠️ 与后台 `admin-web/src/api/building.ts` 是**两回事**：那边是运营的楼栋台账
 *    （D13–D18，含新建 / 编辑 / 停用），这边只有**一支只读列表**，且只回营业中的楼。
 *
 * ## 为什么必须有它
 *
 * `ab_user.building_id` 此前只有「团长邀请链接」一个写入口，没有链接的人
 * （同事扫码联调、老用户换楼）在首页只能看到一个被 `emptyText` 吞掉真实原因的空态。
 * 本文件 + `PUT /me/building`（见 `api/user.ts` 的 `bindBuilding`）把这条链路补成自助闭环。
 */
import { http } from './request';

/** 可选的一栋楼 */
export interface BuildingOptionItem {
  id: number;
  name: string;
  address: string;
  /** 行政区（可能为空 —— 运营未录） */
  district: string | null;
  /**
   * 该楼在任团长姓名；`null` = 暂无在职团长
   *
   * ⚠️ 端上必须如实展示「暂无团长」：此时即便完成绑定，`/home/daily` 仍会返回
   *    30005 未开团 —— 提前讲清楚，好过让用户以为是自己操作错了。
   */
  leaderName: string | null;
}

export interface BuildingOptionList {
  list: BuildingOptionItem[];
  /** 口径说明（服务端下发，端上不复制文案） */
  note: string;
}

/** U-B1 · 可选办公楼列表（仅营业中） */
export function fetchBuildings(): Promise<BuildingOptionList> {
  return http.get<BuildingOptionList>('/building');
}
