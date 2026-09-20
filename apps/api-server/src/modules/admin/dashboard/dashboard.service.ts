import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { arrivalAtOf, now, todayBj, tomorrowBj } from '../../../common/utils/time';
import { BuildingGroup } from '../../../database/entities/building.entity';
import { MealAssignment } from '../../../database/entities/meal.entity';
import { DeliveryRecord, Refund } from '../../../database/entities/order.entity';
import { Withdraw } from '../../../database/entities/withdraw.entity';

/** 单条待办。`count = 0` 也返回 —— 前端据此渲染「已清空」，不靠猜。 */
export interface WorkbenchTodo {
  key: 'refundApplying' | 'withdrawPending' | 'tomorrowGroupsUnassigned' | 'deliveriesLate';
  label: string;
  count: number;
  /** 去哪处理。前端再按 `account.menus` 过滤：角色看不到的入口不渲染（授权了才渲染）。 */
  path: string;
  hint: string;
}

/** 今日作业数字 —— 与 `items` **同一批查询的副产物**，不额外查库（见 `todos()` 注释） */
export interface WorkbenchBrief {
  deliveryTotal: number;
  deliveryArrived: number;
  tomorrowGroupsTotal: number;
  tomorrowGroupsAssigned: number;
}

export interface WorkbenchTodosResult {
  /** 业务日（北京时间，= 今天的出餐日口径） */
  businessDate: string;
  /** 明天的出餐日（= 第 3 条待办与 `brief` 的基准） */
  tomorrowDate: string;
  items: WorkbenchTodo[];
  brief: WorkbenchBrief;
}

/**
 * 后台工作台 · 待办聚合（D66 · M5-16）
 *
 * ## 为什么是聚合端点，而不是前端各查一个列表接口数条数
 *
 * 登录落点页要回答的只有一个问题：**「今天有什么必须我来处理的」**。
 * 答案散在退款 / 提现 / 套餐分配 / 配送四个域。让前端各打一次列表接口再数条数，有三个坑：
 *   ① 列表接口**分页**，拿不到「待办总数」（或得再打一次 count）；
 *   ② 四次请求时序不同，卡片上的数字可能互相对不上（看到 3 条退款、点进去只有 2 条）；
 *   ③ 前端得**复刻四份「什么算待办」的状态口径** —— 状态机在服务端，
 *      复刻必漂移（同族判据：「同一件事有两份表述，不被执行的那份必然会错」，
 *      `e2e §36` 的反证就是冲着它去的）。
 *
 * ## 「什么算待办」的口径（全部对齐既有状态机 · 零新状态 · 零新表）
 *
 * | key | 口径 | 处理页 |
 * | --- | --- | --- |
 * | `refundApplying` | `ab_refund.status='applying'`（C6 第二段的审批队列） | `/finance/refund` |
 * | `withdrawPending` | `ab_withdraw.status='pending'`（D45 的审批队列） | `/finance/withdrawal` |
 * | `tomorrowGroupsUnassigned` | 启用楼群 − 明日有「未取消分配」的楼群（缺口 ⇒ 明日开不了团） | `/meal/matrix` |
 * | `deliveriesLate` | 今日配送单 `status != 'arrived'`，且**仅在过了送达时刻后**才计入 | `/order/delivery` |
 *
 * ### 三条刻意划下的边界（每一条都对应一类「看起来更全，实际更有害」的设计）
 *
 * ① **`deliveriesLate` 在 `arrivalAtOf(今日)` 之前恒为 0。**
 *    11:30 之前没送到不是异常（那正是送达时刻本身）。若全天候报数，
 *    这张卡每天上午都是红的 —— 人一周内就会学会无视它，
 *    于是真正逾期的那天也没人看。同 `ops-daily.sh` 的「恒红的检查等于没有检查」。
 *
 * ② **第 3 条只数「漏排」（完全没有分配），不数「排了没上架」（`pending`）。**
 *    口径依据《接口规范》§6.1：`pending` 是**正常中间态**（编排可提前几天做，
 *    上架才是临近时的动作）。把它算成待办 ⇒ 今天 14:00 开团前这张卡**永远非零**，
 *    又是一张「恒红的检查」。而「漏排」是硬缺口：不补，明日该楼群一定开不了团。
 *
 * ③ **本端点只数数、不列明细。** 明细在各域自己的列表页。
 *    若这里开始返回列表，它就会长成第二个订单中心（两份列表必然漂移）。
 *
 * ⚠️ **刻意不含「供应商出餐进度」**：那是 `ab_supplier_dish_daily` 的 `pending/cooking/done`，
 *    属于供应商端 / 后台「加工场所打包」页的**实时进度盘**，不是「必须由某个后台角色去批」
 *    的待办。放进工作台只会造出第二份进度口径，并在它滞后时制造假告警。
 *
 * ⚠️ 全部只读 ⇒ **不加 `@OperationLog()`**（GET 打了日志会把操作日志刷成垃圾）。
 */
@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Refund)
    private readonly refundRepo: Repository<Refund>,
    @InjectRepository(Withdraw)
    private readonly withdrawRepo: Repository<Withdraw>,
    @InjectRepository(MealAssignment)
    private readonly assignmentRepo: Repository<MealAssignment>,
    @InjectRepository(BuildingGroup)
    private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(DeliveryRecord)
    private readonly deliveryRepo: Repository<DeliveryRecord>,
  ) {}

  async todos(): Promise<WorkbenchTodosResult> {
    const today = todayBj();
    const tomorrow = tomorrowBj();

    // ---- ① 退款待审（C6 第二段 · D40 的审批队列） ----
    const refundApplying = await this.refundRepo.count({ where: { status: 'applying' } });

    // ---- ② 提现待审（D45 的审批队列 —— 团长侧 L12 提交后的唯一推进点） ----
    const withdrawPending = await this.withdrawRepo.count({ where: { status: 'pending' } });

    // ---- ③ 明日漏排的启用楼群 ----
    // 「启用」= status=1 且未软删。软删谓词与 `building-admin.service.ts` 的台账口径同源
    // （楼群软删当前**没有**写入路径，此过滤是防御性的，代价为零）。
    const tomorrowGroupsTotal = await this.groupRepo.count({
      where: { status: 1, deletedAt: IsNull() },
    });
    // ⚠️ `status != 'cancelled'` 不是可选项 —— 它是本工程判「该楼群该日到底有没有套餐」的
    //    既有唯一判据（`meal.service.ts:72` · `meal-admin.service.ts:812` 模板 `usedCount`）。
    //    漏掉它，停团（cancelled）的楼群会被算成「已排」⇒ 工作台显示已清空、
    //    而套餐矩阵里那格是空的（两份口径打架，正是本端点要消灭的东西）。
    const assignedRow = await this.assignmentRepo
      .createQueryBuilder('a')
      .select('COUNT(DISTINCT a.building_group_id)', 'n')
      .where('a.meal_date = :d', { d: tomorrow })
      .andWhere('a.status != :c', { c: 'cancelled' })
      .getRawOne<{ n: string | number }>();
    const tomorrowGroupsAssigned = Number(assignedRow?.n ?? 0);
    const tomorrowGroupsUnassigned = Math.max(0, tomorrowGroupsTotal - tomorrowGroupsAssigned);

    // ---- ④ 今日逾期未送达 ----
    // 送达时刻前**不查库**（不只是不报数）：既省一次全表 count，
    // 也让「上午这张卡恒为 0」这件事在代码里一眼可见。
    const deliveryTotal = await this.deliveryRepo.count({ where: { mealDate: today } });
    const deliveryArrived = await this.deliveryRepo.count({
      where: { mealDate: today, status: 'arrived' },
    });
    const isPastArrival = now().getTime() > arrivalAtOf(today).getTime();
    const deliveriesLate = isPastArrival ? deliveryTotal - deliveryArrived : 0;

    return {
      businessDate: today,
      tomorrowDate: tomorrow,
      items: [
        {
          key: 'refundApplying',
          label: '退款待审',
          count: refundApplying,
          path: '/finance/refund',
          hint: '用户自助 / 团长代退的申请，批了才退款',
        },
        {
          key: 'withdrawPending',
          label: '提现待审',
          count: withdrawPending,
          path: '/finance/withdrawal',
          hint: '团长提现申请，批完才出款（个税已代扣）',
        },
        {
          key: 'tomorrowGroupsUnassigned',
          label: '明日未排套餐的楼群',
          count: tomorrowGroupsUnassigned,
          path: '/meal/matrix',
          hint: `${tomorrow} 这些楼群在套餐矩阵里还是空的 —— 不排就开不了团`,
        },
        {
          key: 'deliveriesLate',
          label: '今日逾期未送达',
          count: deliveriesLate,
          path: '/order/delivery',
          hint: isPastArrival
            ? '已过送达时刻（11:30）仍非「已送达」的配送单'
            : '未到送达时刻（11:30）—— 届时才判定，现在恒为 0',
        },
      ],
      // 与上面同一批查询的副产物，不额外查库（见类注释 ②）
      brief: {
        deliveryTotal,
        deliveryArrived,
        tomorrowGroupsTotal,
        tomorrowGroupsAssigned,
      },
    };
  }
}
