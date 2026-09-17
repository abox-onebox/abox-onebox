import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OperationLog } from '../database/entities/system.entity';
import { ReconciliationService } from '../modules/finance/reconciliation.service';
import { ScheduleService } from './schedule.service';

const NAME = 'reconciliation' as const;

/** 本任务写入告警时的固定动作名（也是「是否已告警过」的判据，勿随手改） */
const ALERT_ACTION = '对账不平';
const ALERT_MODULE = 'finance';

/** 跑批出参（让端上/日志能一眼看出「平不平、有没有告警」） */
export interface ReconciliationRunResult {
  date: string;
  balanced: boolean;
  orderFen: number;
  logFen: number;
  diffFen: number;
  refundFen: number;
  netFen: number;
  diffCount: number;
  /** 恒 `'local_only'`：一期拿不到微信账单，**不许假装已与微信对平**（#55） */
  channelSource: string;
  billAvailable: boolean;
  /** 本次是否**新写**了一条不平告警 */
  alerted: boolean;
  /** 未写告警时的原因（已平 / 该日期已有告警未重复写） */
  alertSkippedReason: string | null;
}

/**
 * 每日 04:00 · 对账（4.7）
 *
 * 口径：《订单状态机与全链路流转 v1.0》§3「T+1 04:00 reconciliation.task 与微信支付
 *      每日对账」。执行口是 `ReconciliationService.reconcile()`（与 D43 对账页**同一个函数**，
 *      故跑批看到的数与运营点开的页面永远一致）。
 *
 * ## ⭐ 目标日期是「**昨日**」（2026-09-17 · M4-2 改正）
 * 文档原写 `today`。但 04:00 对「今日」只能核对 `00:00–04:00` 这 4 小时切片，昨日
 * 23:00 之后的流水要等**次日**才被覆盖 —— 等于每天都漏核一段。改对「昨日」后核的是
 * **完整自然日**，且 T 日的下单窗口（T-1 14:00–23:00）此时已闭合、流水齐全。
 *
 * ## ⚠️ 一期「对平」的含义比名字小（#55）
 * 本任务**物理上拿不到微信账单**（无商户号 + 无 API 证书），`reconcile()` 只核对
 * **本地三头**（订单 ↔ 支付流水 ↔ 退款），出参强制带 `channel.source='local_only'`
 * 与 `billAvailable=false`。**「平」不等于「微信侧也平了」** —— 本任务把这句话
 * 原样写进日志与告警，绝不省略。
 *
 * ## 发现不平怎么让人知道：**落操作日志**（用户 2026-09-17 裁定）
 * 平了**不写**（否则一年 365 条噪音会把这页淹掉）；不平才写一条
 * `ab_operation_log`（`module='finance'` / `action='对账不平'` / `target_id=日期`），
 * 后台「操作日志」页直接可见、可人工跟进与标记。**零 DDL**（不建对账异常表）。
 * 这也是「不能把告警藏在服务器日志里」的落实 —— 没人会主动翻服务器日志。
 *
 * ## 幂等（4.11 · 验收标准 3「重复触发不产生重复数据」）
 * 同一天已有告警行时**不重复写**（补跑只回报 `alerted=false` + `alertSkippedReason`）。
 * 因此本任务重跑 / 手动补跑不会在操作日志里堆出一串重复告警。
 *
 * 手动补跑（e2e / 运维）：`POST /admin/schedule/reconciliation/run`（`date` 可选）。
 */
@Injectable()
export class ReconciliationTask {
  private readonly logger = new Logger(ReconciliationTask.name);

  constructor(
    private readonly sched: ScheduleService,
    private readonly recon: ReconciliationService,
    @InjectRepository(OperationLog) private readonly opLogRepo: Repository<OperationLog>,
  ) {}

  /**
   * 跑批入口 —— **由 `ScheduleRegistrar` 在运行时按生效配置动态注册**，本类不含 `@Cron`。
   *
   * ⚠️ 不用装饰器的原因（缺陷 #49）：`@Cron()` 是**修饰器参数**，在模块加载时求值一次
   *    后即为静态元数据，后台改「开团/截单时刻」**不可能**影响它 —— 表现为「配了不生效」。
   *    改为动态注册后，配置变更可热替换（无需重启）。
   *    ⚠️ 这也意味着**删掉注册逻辑不会有任何报错，只会让任务永远不跑** ——
   *    故注册器内有逐名核对与启动横幅（见 schedule.registrar.ts）。
   */
  async handle(): Promise<void> {
    const outcome = await this.sched.run(NAME, (date) => this.runOnce(date));

    if (outcome.error || !outcome.result) return; // `run()` 已记录失败原因
    const r = outcome.result;
    const { date } = outcome;

    if (r.balanced) {
      this.logger.log(
        `对账 date=${date} 本地三头已平（订单 ¥${(r.orderFen / 100).toFixed(2)} / ` +
          `流水 ¥${(r.logFen / 100).toFixed(2)} / 退款 ¥${(r.refundFen / 100).toFixed(2)}）` +
          '⚠️ 仅本地三头，**不等于已与微信侧对平**（一期无商户号/账单）',
      );
      return;
    }

    this.logger.error(
      `对账 date=${date} **不平**：差异 ${r.diffCount} 笔 / ¥${(r.diffFen / 100).toFixed(2)}` +
        `（订单 ¥${(r.orderFen / 100).toFixed(2)} − 流水 ¥${(r.logFen / 100).toFixed(2)}）` +
        (r.alerted ? ' → 已写操作日志告警' : ` → 告警未重复写（${r.alertSkippedReason}）`),
    );
  }

  /**
   * 业务执行口（**不含锁**）—— 跑批与手动补跑共用
   *
   * · 跑批：`handle()` 经 `sched.run()` 调用（带锁，同一目标日期只跑一次）
   * · 手动补跑：`POST /admin/schedule/reconciliation/run`（**不带锁**）
   */
  async runOnce(date: string): Promise<ReconciliationRunResult> {
    const view = await this.recon.reconcile({ date });
    const s = view.summary;

    let alerted = false;
    let alertSkippedReason: string | null = null;

    if (s.balanced) {
      alertSkippedReason = '本地三头已平，无需告警（平的日期不写日志，避免一年 365 条噪音）';
    } else {
      // 幂等：同一天已有告警则不重复写（补跑不应在操作日志里堆重复行）
      const existed = await this.opLogRepo
        .createQueryBuilder('l')
        .where('l.module = :m', { m: ALERT_MODULE })
        .andWhere('l.action = :a', { a: ALERT_ACTION })
        .andWhere('l.targetId = :t', { t: date })
        .getOne();

      if (existed) {
        alertSkippedReason = `该日期已有告警（操作日志 #${existed.id}），未重复写`;
      } else {
        await this.opLogRepo.insert({
          adminUserId: null,
          module: ALERT_MODULE,
          action: ALERT_ACTION,
          targetId: date,
          requestData: {
            task: NAME,
            anchor: view.anchor,
            anchorLabel: view.anchorLabel,
            summary: s,
          },
          snapshot: {
            source: 'system',
            balanced: false,
            diffFen: s.diffFen,
            diffCount: s.diffCount,
            diffTypeStats: view.diffTypeStats,
            channelSource: view.channel.source,
            billAvailable: view.channel.billAvailable,
            reason: `每日 04:00 对账跑批发现 ${s.diffCount} 笔差异`,
            // ⚠️ 这句必须在告警里，不能只写在文档里：
            //    「平不平」只针对**本地三头**，微信侧一期根本没核过（#55）。
            caveat: '仅本地三头核对，**不等于已与微信侧对平**（一期无商户号与账单文件）',
          },
        });
        alerted = true;
      }
    }

    return {
      date,
      balanced: s.balanced,
      orderFen: s.orderFen,
      logFen: s.logFen,
      diffFen: s.diffFen,
      refundFen: s.refundFen,
      netFen: s.netFen,
      diffCount: s.diffCount,
      channelSource: view.channel.source,
      billAvailable: view.channel.billAvailable,
      alerted,
      alertSkippedReason,
    };
  }
}
