import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PageTrack } from '../../database/entities/system.entity';
import { TZ } from '../../common/utils/tz';

/**
 * 页面停留数据（`ab_page_track`）保留期清理（U15 埋点的合规闭环）
 *
 * ## 为什么必须有这个任务
 * 端上《隐私政策》第四节承诺「页面访问记录自收集之日起保留 180 天，到期后删除
 * 原始记录」。**只承诺不执行 = 「告知了却做不到」**，提审时是合规硬伤。
 * 本任务就是这句话的执行体：每天把早于 `now - 180 天` 的行删掉。
 *
 * ## 为什么它不在 `TASK_SCHEDULES` 里（与 8 个业务跑批刻意的不同）
 * `ScheduleRegistrar` 那 8 个任务的触发时刻**全部由业务时间轴驱动**（缺陷 #49 的
 * 修法：`@Cron()` 装饰器参数是编译期常量，后台改配置不可能生效）。
 * 而本任务是**保留策略杂务**，不对应任何业务时刻 —— 硬挂一个 `timelineKey`
 * 会让「运营改开团/截单时刻」连带改掉清理时刻（两个无关的关注点被耦在一起）。
 * 故用固定 cron + 文件内常量，改保留天数 = 改代码 + 同步隐私政策正文（合规文本变更）。
 *
 * ## 为什么不受 `TASKS_ENABLED` 影响
 * 那个开关管的是**业务跑批**（本地调试不想让后台改业务数据）。
 * 而 180 天清理是**对用户的承诺**：若运营在生产关掉跑批开关，隐私承诺也跟着
 * 静默失效，且没有任何报错 —— 这类「合规承诺被业务开关关掉」的耦合比多跑一次
 * 清理危险得多。清理本身只删超 180 天的数据，碰不到任何测试/新鲜数据。
 *
 * ## 失败语义
 * 删除失败只记 `error` 并返回 0，**绝不抛出** —— 一个清理任务不该有能力拖垮
 * API 服务；漏删一天的代价远小于服务宕机。是否真删掉了，看日志里的行数。
 */

/** 保留天数 —— 与端上《隐私政策》第四节逐字一致（`agreements.ts` 同一数字） */
export const PAGE_TRACK_RETENTION_DAYS = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 保留截止时刻：早于它的行已超期。
 *
 * 纯毫秒算术（`now - 180 * 86400000`），不碰时区/夏令时 —— 180 天是**时长**
 * 而不是「某一天的 00:00」，用日历日加减会在夏令时切换日算出 179/181 天。
 */
export function retentionCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - PAGE_TRACK_RETENTION_DAYS * MS_PER_DAY);
}

@Injectable()
export class PageTrackCleanupTask implements OnModuleInit {
  private readonly logger = new Logger(PageTrackCleanupTask.name);

  /** 重入闸：每日一次的任务若上次没跑完（不会，但删表慢过 cron 间隔是可能的），本次直接跳过 */
  private running = false;

  constructor(
    @InjectRepository(PageTrack)
    private readonly repo: Repository<PageTrack>,
  ) {}

  onModuleInit(): void {
    // 启动横幅：让「承诺正在被执行」在日志里可观测（否则只剩提审时对不上的风险）
    this.logger.log(
      `页面停留数据保留策略生效：超 ${PAGE_TRACK_RETENTION_DAYS} 天自动清理` +
        `（每日 03:30 ${TZ}；合规承诺，不受 TASKS_ENABLED 影响）`,
    );
  }

  /**
   * 每日 03:30（Asia/Shanghai，低峰）执行清理。
   *
   * ⚠️ 时刻选 03:30 的理由：业务跑批集中在 14:00/24:00/02:00，凌晨数据库最空；
   *    具体几分几秒无所谓（保留期按天计），固定下来只为可预期。
   */
  @Cron('0 30 3 * * *', { name: 'page-track-cleanup', timeZone: TZ })
  async handle(): Promise<void> {
    await this.cleanup();
  }

  /**
   * 执行一次清理（cron 与单测共用同一入口；单测直接调它，不驱动 cron）。
   *
   * @param now 当前时刻（可注入，供单测断言截止值；缺省取真实时钟）
   * @returns 删除行数；失败吞掉返回 0（见文件头「失败语义」）
   */
  async cleanup(now: Date = new Date()): Promise<number> {
    if (this.running) {
      this.logger.warn('上一次清理尚未结束，跳过本次触发（每日一次的任务，不存在积压风险）');
      return 0;
    }
    this.running = true;
    try {
      const cutoff = retentionCutoff(now);
      // ⚠️ 用列名 `created_at`（不用属性名）：delete QB 无别名，列名直通 SQL，
      //    不依赖 TypeORM 的属性名替换表；与 `leader-admin.service.ts` 的
      //    `c.created_at < :toExclusive`（Date 参数直传，跨 sqlite/MySQL 同构）同一形态。
      const result = await this.repo
        .createQueryBuilder()
        .delete()
        .from(PageTrack)
        .where('created_at < :cutoff', { cutoff })
        .execute();

      const removed = result.affected ?? 0;
      this.logger.log(
        `页面停留数据清理完成：删除 ${removed} 行` +
          `（早于 ${cutoff.toISOString()}，保留 ${PAGE_TRACK_RETENTION_DAYS} 天）`,
      );
      return removed;
    } catch (e) {
      this.logger.error(
        `页面停留数据清理失败（保留策略本次未执行，服务不受影响，次日 03:30 重试）：` +
          `${(e as Error).message}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
