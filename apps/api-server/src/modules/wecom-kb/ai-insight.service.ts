import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import { AiInsight } from '../../database/entities';

/** 一次 AI 生成的留档入参 */
export interface RecordInsightInput {
  /** 节点标识，与生成脚本同名（`daily-report` / `meal-proposal` / …） */
  kind: string;
  /** 一句话标题（列表页展示） */
  title: string;
  /** AI 输出全文，**不做截断**（截断正是丢关键结论的环节，见实体注释） */
  content: string;
  source?: 'chat' | 'admin' | 'cron';
  actorId?: number | null;
  actorName?: string | null;
  meta?: {
    /** `llm` = 真调模型；`rules` = 降级到规则兜底。事后复盘必须知道是哪种 */
    mode?: string;
    elapsedMs?: number;
    /** 入参摘要（日期档位 / 楼群数 / 是否指定范围），便于复现 */
    input?: Record<string, unknown>;
    /** 结构化动作占位（本批恒 null，留给「一键执行」批次） */
    payload?: unknown;
  };
}

export interface ListInsightQuery {
  kind?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

/** 处置状态白名单（与实体注释一致） */
const DECIDABLE = ['open', 'adopted', 'dismissed'] as const;
type DecidableStatus = (typeof DECIDABLE)[number];

/**
 * ai-insight · AI 产出留档（`ab_ai_insight` 的读写唯一入口）
 *
 * ## 谁写、谁读
 * - **写**：`WecomChatService` 的 15 个 AI 节点 + 每日 09:00 编排（`source` 区分 chat/admin/cron）
 * - **读**：后台「AI 台账」页（`/admin/ai-insight/*`）
 *
 * ## ⭐ 为什么 record() 吞异常，而不是让调用方 try/catch
 *
 * 留档是**旁路**。它失败绝不能连带「AI 回复失败」——用户在企微等 5 秒拿到的是
 * 「生成失败，请重试」，而真实原因只是台账表写不进去，这是拿主功能给旁路陪葬。
 *
 * 但「吞异常」有个已知的坏形态：**台账静默全空，没人发现**（等价于「恒绿的检查」）。
 * 故这里做两件事补偿：
 * 1. 失败记 `logger.error`（带 kind 与错误信息），**不是 warn** —— 它在监控里要能被捞到；
 * 2. 后台列表页展示「最近一条留档时间」，长期空 = 人一眼能看出链路断了。
 *
 * ⚠️ 仍然存在的边界：若 DB 长时间不可用，AI 照常回复、台账全空，只有日志能证明。
 *    这是刻意选择（保主功能），不是遗漏。
 */
@Injectable()
export class AiInsightService {
  private readonly logger = new Logger(AiInsightService.name);

  constructor(@InjectRepository(AiInsight) private readonly repo: Repository<AiInsight>) {}

  /**
   * 记一条 AI 产出。**永不抛异常**（见类注释）。
   *
   * `content` 为空白时直接跳过：没有结论就没有留档价值，
   * 存一条空壳只会让「最近一条时间」这个健康指标说谎。
   */
  async record(input: RecordInsightInput): Promise<void> {
    const content = (input.content ?? '').trim();
    if (!content) return;

    try {
      const row = this.repo.create({
        kind: input.kind.slice(0, 64),
        // 标题兜底：调用方漏传时用 kind + 首行，好过空标题
        title: (input.title?.trim() || `${input.kind}：${content.split('\n')[0]}`).slice(0, 255),
        content,
        metaJson: input.meta ? JSON.stringify(input.meta) : null,
        source: input.source ?? 'chat',
        status: 'open',
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
      });
      await this.repo.insert(row);
    } catch (e) {
      // 不抛：留档失败不得影响 AI 回复本身
      this.logger.error(
        `AI 留档写入失败（kind=${input.kind}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** 列表（分页信封）。`content` 不返回全文，只给开头摘要 —— 列表页不需要几 KB 文本 */
  async list(q: ListInsightQuery): Promise<{
    list: Array<
      Pick<AiInsight, 'id' | 'kind' | 'title' | 'source' | 'status' | 'actorName' | 'createdAt'> & {
        excerpt: string;
      }
    >;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));

    const qb = this.repo.createQueryBuilder('t');
    if (q.kind) qb.andWhere('t.kind = :kind', { kind: q.kind });
    if (q.status) qb.andWhere('t.status = :status', { status: q.status });
    qb.orderBy('t.createdAt', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [rows, total] = await qb.getManyAndCount();
    return {
      list: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        source: r.source,
        status: r.status,
        actorName: r.actorName ?? null,
        createdAt: r.createdAt,
        // 列表摘要：去掉 markdown 记号后的前 120 字，纯展示用途
        excerpt: (r.content ?? '')
          .replace(/[#*`>\-|]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120),
      })),
      total,
      page,
      pageSize,
    };
  }

  /** 详情（含全文与 meta）。找不到 → 404 业务错误，不返回 null 让前端自己猜 */
  async detail(id: number): Promise<AiInsight> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new BizException(ErrorCode.NOT_FOUND, 'AI 留档不存在');
    return row;
  }

  /**
   * 标记采纳 / 忽略（也可退回 open）。
   *
   * 不做「已采纳 → 已忽略」的互斥校验：现实中「先标采纳、事后发现没做」很常见，
   * 允许改回来比逼人重新生成一份更省事。`decidedAt` 会随之覆盖，日志在操作日志里。
   */
  async decide(id: number, status: string, byName: string | null): Promise<AiInsight> {
    if (!DECIDABLE.includes(status as DecidableStatus)) {
      throw new BizException(ErrorCode.PARAM_INVALID, `status 只能是 ${DECIDABLE.join(' / ')}`);
    }
    const row = await this.detail(id);
    await this.repo.update(
      { id },
      {
        status,
        decidedAt: status === 'open' ? null : new Date(),
        decidedBy: status === 'open' ? null : byName,
      },
    );
    return { ...row, status, decidedAt: status === 'open' ? null : new Date() };
  }

  /** 可选节点清单（给前端筛选下拉用：只列库里有数据的 kind，不写死枚举） */
  async kinds(): Promise<Array<{ kind: string; count: number }>> {
    const rows = (await this.repo
      .createQueryBuilder('t')
      .select('t.kind', 'kind')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.kind')
      .orderBy('count', 'DESC')
      .getRawMany()) as Array<{ kind: string; count: string | number }>;
    return rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
  }
}
