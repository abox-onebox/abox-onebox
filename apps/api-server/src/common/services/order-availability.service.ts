import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { Building, BuildingGroup } from '../../database/entities/building.entity';
import { MealAssignment } from '../../database/entities/meal.entity';
import { SalesPause } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { Availability, evaluateAvailability, reasonText } from '../utils/orderability';
import { cutoffAtOf, now, publishAtOf } from '../utils/time';
import { BizConfigService } from './biz-config.service';

/** 判定结果 + 可直接下发的文案 */
export type OrderAvailability = Availability & { reasonText: string | null };

/**
 * 可订性编排（**唯一装载口** · P3-3）
 *
 * ⚠️ **只装载数据，不含任何判据** —— 判据全在 `utils/orderability.ts` 的纯函数里。
 *    编排层一旦夹带判据，就又变成第二份「能不能下单」，四个入口迟早分叉。
 *
 * ⚠️ 三条硬口径：
 *   1. **不抛业务码**。楼不存在 / 未归群 / 无分配一律交给纯函数判成 `canOrder = false`，
 *      抛码是**调用方**的契约责任（既有 20016 / `NOT_FOUND` / `BUILDING_NOT_FOUND` 不动）。
 *   2. **fail-closed**：读不到（楼 / 楼群 / 分配任一行缺失）⇒ 判为不可下单。
 *      ⚠️ 「读不到」≠「查失败」：前者是**行不存在**（含软删），判 false 是正确的；
 *        后者是 DB / 连接抛错，必须照常上抛（500）。两者都拦住了下单，但只有后者
 *        留得下故障信号 —— 把一次数据库抖动伪装成「该办公楼今日未开团」，运营会
 *        当成配置缺口去排查，故障就永久消失在日志之外。故本服务不加 try/catch。
 *   3. **零缓存**。加缓存会把「停售开关」与「实际判定」拉出时间差，W1 要求的
 *      「写入停售后立刻生效」会因此失效（不要在编排层把 60 秒 TTL 加回来）。
 */
@Injectable()
export class OrderAvailabilityService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(MealAssignment) private readonly assignRepo: Repository<MealAssignment>,
    @InjectRepository(SalesPause) private readonly pauseRepo: Repository<SalesPause>,
    private readonly bizConfig: BizConfigService,
  ) {}

  /** 用户端（U1 / U6）：按 userId 解析楼 → 楼群 → 分配 → 停售 → 调纯函数 */
  async forUser(mealDate: string, userId: number): Promise<OrderAvailability> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    return this.resolve(mealDate, user?.buildingId ?? null);
  }

  /** 非用户端（团长工作台 / 管家端）：按 buildingId 解析 */
  async forBuilding(mealDate: string, buildingId: number): Promise<OrderAvailability> {
    return this.resolve(mealDate, buildingId);
  }

  /**
   * 全局停售判定（W1 · P3-6 接线）
   *
   * 判据 = 「存在一条 `ab_sales_pause` 行，其区间**覆盖**该出餐日（两端含首尾），
   *         且 `resumed_at IS NULL`」。
   *
   * ## ⭐⚠️ 直查 DB，**不得**在此套任何缓存层
   *
   * 「一键停售立刻生效」这条性质**不是**出自某个机制，而是出自一个**缺省**：
   * 本方法每次下单判定都真打一次库。
   *
   * 将来任何人为了「优化下单接口 RT」在这里加一层缓存（哪怕 TTL 只有 10 秒），
   * W1 就会退化成「最长延迟 TTL 秒的停售」，而**所有现有验收句式仍会通过** ——
   * 缓存命中的旧值在 TTL 内与真值一样。⇒ **这类改动必须在写路径
   * （`POST /admin/sales-pause` 与 `resume`）上显式失效，并改验收句式。**
   * 判据 `S-W1-5` / `S-W1-7` 盯这件事；详见 spec §7.5。
   *
   * ## 为什么允许重叠、为什么按行恢复
   * 「停售明天」+「停售下周一」是两条独立记录，运营想只解其中一条时，
   * 按日期恢复会一起解掉。故这里只做**存在性**判定，命中任意一条即停售。
   */
  private async salesPaused(mealDate: string): Promise<{ paused: boolean; reason: string | null }> {
    // ⚠️ 用 `findOne` 而不是 `count`：`reason` 要随文案下发到用户端（spec §7.6 第 1 条），
    //    光数出「有 0 条还是 1 条」拿不到运营填的原因。
    const row = await this.pauseRepo.findOne({
      where: {
        mealDateFrom: LessThanOrEqual(mealDate),
        mealDateTo: MoreThanOrEqual(mealDate),
        resumedAt: IsNull(),
      },
      // ⭐ 多条生效中记录取**最新创建的那条**（`id` 最大）。
      //    ⚠️ 不能用 `meal_date_from` 排序 —— 晚写的区间完全可能更早开始
      //       （先「停售下周一」、后「停售明天」，后写的才是运营的最新意图）。
      //    ⚠️ 也不能省掉 `order` 依赖插入顺序 —— MySQL 无 ORDER BY 时**不保证**返回顺序，
      //       今天碰巧对、明天加个索引就翻。
      order: { id: 'DESC' },
    });
    return { paused: row !== null, reason: row?.reason ?? null };
  }

  /** 装载 → 交纯函数 → 拼文案（两条路径共用，避免两处各装一遍数据） */
  private async resolve(mealDate: string, buildingId: number | null): Promise<OrderAvailability> {
    // ⚠️ `deletedAt: IsNull()` 不能省：`ab_building.deleted_at` / `ab_building_group.deleted_at`
    //    都是**普通 `@Column`** 而非 `@DeleteDateColumn`，TypeORM 不会自动过滤软删行。
    //    软删时若没同步改 `status`，一栋已删的楼会被查到并判为**可下单** = fail-open。
    //    （既有 `meal.service` / `order.service` 不带此条件，本批**不追溯改**它们 ——
    //     P3-4 把它们接到本服务后，全链路自然一致。）
    const building = buildingId
      ? await this.buildingRepo.findOne({ where: { id: buildingId, deletedAt: IsNull() } })
      : null;
    const groupId = building?.buildingGroupId ?? null;

    const [group, assignment, pause, cutoffWindowMinutes] = await Promise.all([
      groupId
        ? this.groupRepo.findOne({ where: { id: groupId, deletedAt: IsNull() } })
        : Promise.resolve<BuildingGroup | null>(null),
      groupId
        ? // `uk_meal_assignment_date_group(meal_date, building_group_id)` 是唯一索引，
          // 故一个楼群一个出餐日**至多一行** —— 无需再加 status 过滤来消歧。
          this.assignRepo.findOne({ where: { mealDate, buildingGroupId: groupId } })
        : Promise.resolve<MealAssignment | null>(null),
      this.salesPaused(mealDate),
      this.bizConfig.cutoffWindowMinutes(),
    ]);

    const publishAtMs = publishAtOf(mealDate).getTime();
    const cutoffAtMs = cutoffAtOf(mealDate).getTime();

    const result = evaluateAvailability({
      buildingStatus: building?.status ?? null,
      buildingGroupId: groupId,
      buildingGroupStatus: group?.status ?? null,
      assignmentStatus: assignment?.status ?? null,
      salesPaused: pause.paused,
      cutoffWindowMinutes,
      publishAtMs,
      cutoffAtMs,
      nowMs: now().getTime(),
    });

    // ⚠️ 文案一律走纯函数的唯一出口 `reasonText()`，本服务不自己拼 ——
    //    否则「漏插值 = 空文案」这条静默失败面又会在编排层长出来一份。
    return {
      ...result,
      reasonText: result.reason
        ? reasonText(result.reason, {
            publishAtMs,
            cutoffAtMs,
            cutoffWindowMinutes,
            // ⭐ 运营填的停售原因随文案下发（仅 `sales_paused` 用得到）
            salesPauseReason: pause.reason,
          })
        : null,
    };
  }
}
