import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import { addDays, isDateStr, now, toBjIso } from '../../common/utils/time';
import { Message as MessageLog, MessageTemplate } from '../../database/entities/system.entity';
import { MESSAGE_TEMPLATE_SPECS, specState } from '../admin/template/message-template.specs';

/**
 * 通知到达率统计（F5 · 真源《系统地图》F5「缺的是'按人按场景编排 + 到达率回看'」）
 *
 * 「谁每天用：系统自动 · **你看到达率**」—— 本服务就是那句「看到达率」。
 *
 * ## ⚠️ 四条必须说清的口径（每条都会影响数字怎么读）
 *
 * ### 1. 分母是「**已尝试投递**」，不是「应发」
 *
 * `ab_message` 的语义是「**发过什么**」，而按 M3-12 定下的纪律，
 * **未启用 = 不投递且不留日志**（把「因为没启用所以没发」也写进去，这张表就失去查询价值）。
 * 于是本页算不出「应发未发」—— 那是另一件事，靠 `MessageTemplateService` 的
 * `enabled` / `blockers` 展示（哪些场景没开、缺什么）。
 * **两件事不可混算**：把「应发未发」塞进分母，会让「平台崩了」与「运营没开开关」
 * 变成同一个数字。
 *
 * ### 2. 场景维度取自 `payload.scene`（**不是列**）—— 且 JSON 列在驱动间形态不同
 *
 * `ab_message` 没有 `scene` 列，场景记在 `payload` JSON 里。TypeORM 的 `json` 列
 * 在 mysql 驱动下取出来是**对象**，而在部分驱动/旧数据里可能是**文本** ——
 * 本服务两种都兼容（见 `sceneOf`），否则换驱动后统计会**全部落进「未标注场景」**
 * 且不报错（本项目反复栽的「本地全绿、换驱动才炸」形态）。
 *
 * ### 3. 按**北京日**聚合，而库里时间列存 **UTC**
 *
 * `ab_message.sent_at` / `created_at` 存 UTC。直接按 UTC 切日会让「23:30 之后」
 * 的通知被算到**前一天**（差 8 小时 = 一个工作日的边界）。故一律经 `toBjIso` 转北京时区再取日期。
 *
 * ### 4. ⚠️ **一期本页必然全 0** —— 这不是故障，也不是「接口坏了」
 *
 * 一期没有微信账号 ⇒ `ab_message_template.wechat_template_id` 全空 ⇒ 启用闸门
 * 拦住所有订阅消息场景 ⇒ **没有一次投递** ⇒ 表里 0 行。页面必须如实显示
 * 「暂无投递记录 + 为什么」，而不是显示一个看起来正常的 0（0 与「没有数据」不同）。
 */
@Injectable()
export class MessageReachService {
  private readonly logger = new Logger('MessageReach');

  constructor(
    @InjectRepository(MessageLog)
    private readonly logRepo: Repository<MessageLog>,
    @InjectRepository(MessageTemplate)
    private readonly tplRepo: Repository<MessageTemplate>,
  ) {}

  /** 到达率视图（一句话：每个场景发了多少、到了多少） */
  async reach(q: ReachQuery): Promise<ReachView> {
    const { from, to } = this.resolveRange(q);

    // ⚠️ **范围过滤走 `created_at`，日归属优先 `sent_at`** —— 两者在正常路径下相同
    //    （`MessageService.writeLog()` 在同一次 save 里写入 `sentAt` 与 `createdAt`），
    //    差别只在 `sent_at` 为空的历史行（如 `status='pending'`）。
    //    过滤选 `created_at` 是因为它是**非空列**：拿可空列做范围条件会把空值行整体漏掉，
    //    而「漏掉的行让合计对不上」正是本页唯一的正确性锚点被破坏的方式。
    const rows = await this.logRepo.find({
      where: { createdAt: Between(bjStartOf(from), bjEndOf(to)) },
      order: { createdAt: 'ASC' },
    });

    const tplRows = await this.tplRepo.find();
    const byScene = new Map(tplRows.map((r) => [r.scene, r]));

    // ---- 逐行归类（场景 + 北京日）----
    const perScene = new Map<string, { attempted: number; success: number; failed: number }>();
    const perDay = new Map<string, { attempted: number; success: number; failed: number }>();

    for (const r of rows) {
      const scene = sceneOf(r.payload);
      const date = bjDateOf(r.sentAt ?? r.createdAt);
      const ok = r.status === 'success';

      const s = perScene.get(scene) ?? { attempted: 0, success: 0, failed: 0 };
      s.attempted += 1;
      if (ok) s.success += 1;
      else s.failed += 1;
      perScene.set(scene, s);

      const d = perDay.get(date) ?? { attempted: 0, success: 0, failed: 0 };
      d.attempted += 1;
      if (ok) d.success += 1;
      else d.failed += 1;
      perDay.set(date, d);
    }

    // ---- 场景清单（**含 0 投递的场景** —— 本期最有用的就是这一列）----
    const scenes: ReachSceneRow[] = MESSAGE_TEMPLATE_SPECS.map((spec) => {
      const row = byScene.get(spec.scene);
      const state = specState(spec, row);
      const stat = perScene.get(spec.scene) ?? { attempted: 0, success: 0, failed: 0 };
      return {
        scene: spec.scene,
        label: spec.label,
        wiring: spec.wiring,
        enabled: state.enabled === 1,
        attempted: stat.attempted,
        success: stat.success,
        failed: stat.failed,
        reachRate: rateOf(stat),
      };
    });

    // ---- 库里存在、声明里没有的场景（已下线的脏数据）→ 单独列出，不静默丢 ----
    const orphanScenes: ReachSceneRow[] = [...perScene]
      .filter(([scene]) => !MESSAGE_TEMPLATE_SPECS.some((s) => s.scene === scene))
      .map(([scene, stat]) => ({
        scene,
        label: `（已下线场景「${scene}」）`,
        wiring: 'unknown',
        enabled: false,
        attempted: stat.attempted,
        success: stat.success,
        failed: stat.failed,
        reachRate: rateOf(stat),
      }));
    if (orphanScenes.length) {
      this.logger.warn(
        `ab_message 出现已下线场景的投递记录：${orphanScenes.map((s) => s.scene).join('、')}` +
          '—— 场景已从代码声明中移除，但历史日志仍在保留期内（90 天）',
      );
    }

    const summary = {
      attempted: rows.length,
      success: rows.filter((r) => r.status === 'success').length,
      failed: rows.filter((r) => r.status !== 'success').length,
      reachRate: rows.length
        ? Number((rows.filter((r) => r.status === 'success').length / rows.length).toFixed(4))
        : null,
      scenesWithTraffic: [...perScene.keys()].length,
    };

    return {
      range: { from, to, days: daysBetween(from, to) },
      scenes: [...scenes, ...orphanScenes],
      daily: [...perDay]
        .map(([date, stat]) => ({ date, ...stat, reachRate: rateOf(stat) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      summary,
      note: this.buildNote(summary.attempted),
    };
  }

  /**
   * 区间解析：缺省「近 7 天（含今日）」；非法格式 / 超长区间一律 `10001`，**不静默回落**
   *
   * ⚠️ 不静默回落的理由同 D44 发票的 `status` 校验：运营传了一个拼错的日期，
   *    系统默默换成默认区间，他看到一份**看起来正常但答的不是他问题**的报表，
   *    而没有任何一处提示「你的入参被忽略了」。
   */
  private resolveRange(q: ReachQuery): { from: string; to: string } {
    const today = toBjIso(now())!.slice(0, 10);

    if (q.from !== undefined && !isDateStr(q.from)) {
      throw new BizException(ErrorCode.PARAM_INVALID, `from 不是合法日期（YYYY-MM-DD）：${q.from}`);
    }
    if (q.to !== undefined && !isDateStr(q.to)) {
      throw new BizException(ErrorCode.PARAM_INVALID, `to 不是合法日期（YYYY-MM-DD）：${q.to}`);
    }

    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -6); // 近 7 天（含端点）

    if (from > to) {
      throw new BizException(ErrorCode.PARAM_INVALID, `from（${from}）不能晚于 to（${to}）`);
    }
    if (daysBetween(from, to) > MAX_RANGE_DAYS) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `区间过大（${daysBetween(from, to)} 天 > ${MAX_RANGE_DAYS} 天）—— ` +
          '`ab_message` 只保留 90 天，更早的数据已被清理，查了也没有',
      );
    }
    return { from, to };
  }

  /** 页面口径说明 —— 「没有记录」与「记录为 0」必须能分开读 */
  private buildNote(attempted: number): string {
    const base =
      '到达率 = **投递成功数 / 已尝试投递数**。⚠️ 分母**不含**「因未启用被跳过」的通知 —— ' +
      '`ab_message` 按纪律只记「发过什么」，不记「因为没启用所以没发」（见 `MessageService` 头注）。' +
      '因此本页**算不出「应发未发」**，那要看场景开关与启用闸门（「模板配置」页）。';
    if (attempted === 0) {
      return (
        base +
        ' ⚠️ **当前区间内没有任何投递记录**：一期尚未申请微信账号，所有订阅消息场景的模板 ID 均为空，' +
        '启用闸门（fail-closed）因此拦住启用，投递侧在第 2 步即跳过、**不写日志** —— ' +
        '这是当前真实状态，不是接口故障。'
      );
    }
    return base;
  }
}

// =====================================================================
// 纯函数与小工具（导出供 e2e 直接单测，避免「只有 HTTP 一条验证路径」）
// =====================================================================

/** 区间上限（天）：与 `ab_message` 的 90 天保留期对齐 */
export const MAX_RANGE_DAYS = 90;

/**
 * 从 `payload` 取场景键
 *
 * ⚠️ 兼容**对象与文本**两种形态（见类头注释②）：mysql 驱动给对象，部分情形给文本。
 *    两者都认不出时归入「(未标注场景)」而不是丢弃 —— **丢掉的行会让合计对不上**，
 *    而合计对不上是本页唯一的正确性锚点。
 */
export function sceneOf(payload: unknown): string {
  let p: unknown = payload;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      return '(无法解析 payload)';
    }
  }
  const scene = (p as { scene?: unknown } | null)?.scene;
  return typeof scene === 'string' && scene.trim() !== '' ? scene : '(未标注场景)';
}

/** 到达率（分母 0 → `null`，**不是 0** —— 0 会被读成「发出去的全失败」） */
export function rateOf(s: { attempted: number; success: number }): number | null {
  return s.attempted ? Number((s.success / s.attempted).toFixed(4)) : null;
}

/** UTC `Date` → 北京日（`YYYY-MM-DD`） */
const bjDateOf = (d: Date): string => toBjIso(d)!.slice(0, 10);

/** 北京日 `00:00:00.000` 对应的 UTC `Date`（北京 = UTC+8，故减 8 小时） */
const bjStartOf = (date: string): Date => new Date(`${date}T00:00:00.000+08:00`);

/** 北京日 `23:59:59.999` 对应的 UTC `Date` */
const bjEndOf = (date: string): Date => new Date(`${date}T23:59:59.999+08:00`);

/** 含端点的天数差 */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

// =====================================================================
// 出参
// =====================================================================

export interface ReachQuery {
  /** 起始北京日（`YYYY-MM-DD`）；缺省 = `to` 往前 6 天 */
  from?: string;
  /** 截止北京日（`YYYY-MM-DD`）；缺省 = 今日 */
  to?: string;
}

export interface ReachSceneRow {
  scene: string;
  label: string;
  /** `live` = 有代码投递点；`pending` = 一期无投递点；`unknown` = 已下线场景的历史记录 */
  wiring: string;
  /** 场景当前是否启用（**它解释「为什么这条 attempted 是 0」**） */
  enabled: boolean;
  attempted: number;
  success: number;
  failed: number;
  /** `null` = 区间内没有尝试投递（**不是「到达率 0%」**） */
  reachRate: number | null;
}

export interface ReachView {
  range: { from: string; to: string; days: number };
  /** 按场景汇总（**含 0 投递的场景**，顺序与后台「模板配置」页一致） */
  scenes: ReachSceneRow[];
  /** 按北京日汇总（只含**有记录**的日子；空区间返回空数组） */
  daily: Array<{
    date: string;
    attempted: number;
    success: number;
    failed: number;
    reachRate: number | null;
  }>;
  summary: {
    attempted: number;
    success: number;
    failed: number;
    /** `null` = 区间内无任何投递（与「0%」不同） */
    reachRate: number | null;
    scenesWithTraffic: number;
  };
  note: string;
}
