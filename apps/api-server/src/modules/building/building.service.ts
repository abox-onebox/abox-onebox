import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { BuildingStatus, LeaderStatus } from '@abox/shared-types';

import { Building } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';

/** 用户端可选的一栋楼（`GET /building` 出参行） */
export interface BuildingOption {
  id: number;
  name: string;
  address: string;
  /** 行政区（可能为空 —— 运营未录） */
  district: string | null;
  /** 该楼在任团长姓名；`null` = 暂无在职团长 */
  leaderName: string | null;
}

/**
 * Building 服务 —— **用户端**只读（U 系列）
 *
 * ## 为什么本文件此前是空的，而它是个真缺陷
 *
 * `building.module.ts` 的头注自 M3-6 就写着「`BuildingController` —— 用户端只读，
 * 用户端『切换办公楼』等场景（U 系列）」，但 `BuildingController` / `BuildingService`
 * **一直是空壳**（`export class X {}`），于是：
 *
 * · 用户 `ab_user.building_id` 为空时，`MealService.resolveUserGroup` 抛 `10004`
 *   「你还未绑定办公楼」；而首页 `index.vue` 的 `emptyText` **对任何错误码都显示
 *   「本楼今日未开团」**，真实原因被吞掉；
 * · 「我的 → 切换团长（绑定办公楼）」只有一句 toast「请通过该楼团长邀请链接进入」
 *   —— 即**唯一的绑楼途径是别人发链接**。真实联调里（同事扫码进来）表现为
 *   「首页一片空白 + 重新加载」，而没有任何自助出口。
 *
 * 本批补两支：`GET /building`（可选楼列表）+ `PUT /me/building`（自助绑定，
 * 写在 `UserService.bindBuilding`）。
 *
 * ## ⚠️ 只做「读 + 绑」，**不做** C 端写楼栋
 *
 * 新建 / 编辑 / 停用楼栋只有后台一个入口（`BuildingAdminController` D13–D15）。
 * 此处若再开一个 C 端写口，就会出现「运营在后台停用、用户在端上自选」的双入口，
 * 而两边都不报错。
 *
 * ## ⚠️ 只返回 `status = 1`（营业中）
 *
 * 「待开通 / 已暂停」的楼没有开团资格（`meal.service` 只按营业中的楼群编排），
 * 让用户选它等于给他一个**必然下不了单**的选项，且失败时要到第 2 步才暴露。
 * 不发定位、不索取手机号（L9 口径）也是同一条：不给用户他不该有的选择。
 */
@Injectable()
export class BuildingService {
  constructor(
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
  ) {}

  /**
   * 用户端可选办公楼列表
   *
   * ⭐ **带上「该楼在任团长」**是有意的：用户选楼的真正目的是「跟着谁取餐」，
   *    只有楼名他判断不了。且 `leaderName = null` 时端上要如实写「暂无团长」——
   *    2026-11-11 补排期后这类楼变成「能看不能买」（首页 canOrder=true、下单抛 `30007`），
   *    故本方法已改为 **只返回有在职团长的楼**，从源头不给用户必然失败的选择（P0-5 收口）。
   *
   * ⚠️ 一栋楼可能有多个在职团长记录（历史数据），取 **id 最小**的那个 ——
   *    与 `MealService.resolveLeader` 的回落判据（`order: { id: 'ASC' }`）逐字一致。
   *    若此处换成「最新任命」，端上显示的团长与下单实际挂靠的团长就可能是两个人。
   */
  async listSelectable(): Promise<{ list: BuildingOption[]; note: string }> {
    const rows = await this.buildingRepo.find({
      where: { status: BuildingStatus.ACTIVE, deletedAt: IsNull() },
      order: { name: 'ASC' },
    });

    const ids = rows.map((b) => Number(b.id));
    const leaders = ids.length
      ? await this.leaderRepo.find({
          where: { buildingId: In(ids), status: LeaderStatus.ACTIVE },
          order: { id: 'ASC' },
        })
      : [];

    const leaderOf = new Map<number, string>();
    for (const l of leaders) {
      const key = Number(l.buildingId);
      if (!leaderOf.has(key)) leaderOf.set(key, l.realName);
    }

    return {
      // ⭐ 2026-11-11 提审前收口（P0-5）：只开放「有在职团长」的楼。
      //    `canOrder` 只判排期不判团长，而 `OrderService.resolveLeader` 无团长即抛 30007；
      //    两套判据不同源时，展示无团长楼等于把用户引到必失败的「立即预订」按钮上。
      //    修复方向由祝总拍板为「只开放有团长的 4 栋」，绑楼口 `bindBuilding` 同步校验。
      list: rows
        .filter((b) => leaderOf.has(Number(b.id)))
        .map((b) => ({
          id: Number(b.id),
          name: b.name,
          address: b.address,
          district: b.district ?? null,
          leaderName: leaderOf.get(Number(b.id)) ?? null,
        })),
      /**
       * 口径说明由**服务端下发**（端上不复制一份文案）
       *
       * 必须讲清两件事：① 换楼会换团长（佣金归属随楼变）；
       * ② 楼栋是「选」而不是「定位」（App 不读定位，L9 口径）。
       */
      note: '选择你上班的办公楼即可下单（系统按楼匹配团长与次日套餐）。App 不读取定位。',
    };
  }
}
