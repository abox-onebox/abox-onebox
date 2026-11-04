import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import { toBjIso } from '../../common/utils/time';
import { AiInsightService } from './ai-insight.service';

/*
 * ⚠️ 两个约定，缺一个功能就残废（都是实测踩出来的）：
 *
 * ① **DTO 必须 `export`**。`scripts/gen-wecom-catalog.mjs::parseDtoClass` 用
 *    `/^export\s+class\s+(\w+)\b/` 找 DTO —— 不加 `export` 时它解析不出字段，
 *    该端点在企微目录里被标成入参 `*`（只能收一整段 JSON），
 *    同事问「要不要填参数」时机器人**无法逐参数引导**，且 `wecom:hints` 会把整端点跳过。
 *    症状极隐蔽：接口能用、页面能用，只有企微侧退化成「你自己拼 JSON」。
 *
 * ② **DTO 必须在控制器之前**（同一个坑已在 launch-draft 控制器里踩过）：
 *    开着 `emitDecoratorMetadata` 时 `@Query() q: ListInsightDto` 会在类定义那一刻
 *    求值 `design:paramtypes`，若 DTO 在文件末尾则处于 TDZ，抛
 *    `ReferenceError: Cannot access '...' before initialization` —— **生产启动即崩**，
 *    而 `tsc --noEmit` 完全看不出来。由 `route:audit` 门禁在 ts-node 里抓。
 */
export class ListInsightDto {
  /** 节点筛选（如 `daily-report`）。不传 = 全部 */
  @IsOptional()
  @IsString()
  kind?: string;

  /** 状态筛选：open / adopted / dismissed。不传 = 全部 */
  @IsOptional()
  @IsIn(['open', 'adopted', 'dismissed'], { message: 'status 只能是 open / adopted / dismissed' })
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class DecideInsightDto {
  /**
   * 目标状态。
   * 允许退回 `open`：现实里「先标了采纳、事后发现没做」很常见，
   * 逼人重新生成一份不如让他改回来。
   */
  @IsIn(['open', 'adopted', 'dismissed'], { message: 'status 只能是 open / adopted / dismissed' })
  status!: string;
}

/**
 * 后台 · AI 台账（`ab_ai_insight`）
 * ==================================================================
 * 把 15 个 AI 节点的产出从「生成即消失」变成**可检索、可标记、可复盘**的记录。
 *
 * ## 为什么需要这一页（缺口本身）
 * 企微会话 10 分钟就过期，每日 09:00 编排推完只留一行「推了 N 字」日志。
 * 于是三个问题都答不上来：
 * 1. 「上周 AI 说该上哪几个品」→ 只能重新生成，而 LLM 非确定，**上次那个说法永久丢失**；
 * 2. 「AI 建议了 12 次，采纳了几次」→ 无记录，AI 化的价值无法评估；
 * 3. 「这条建议准不准」→ 没有台账就没有回看。
 *
 * ## 权限
 * `super_admin / admin / operator` 都可读、都可标记。
 * 标记**不改任何业务数据**（只是给自己留个记号），故不需要收紧到管理员 ——
 * 收紧的代价是「运营看完想标一下却 403」，而收益为零（他自己就能在备注里写）。
 * ⚠️ 与「确认开团」不同：那个真写排期，所以只给 admin。
 *
 * ## 为什么不做「一键执行」
 * 是明确方向，但不是这一步。执行要逐节点定义动作（发券/建模板/招募/排期），
 * 每个动作的「可撤销性」与「错判代价」都不同 —— 一次性统一做必然有一半是错的。
 * 本批先把 `payload_json` 的位置留好（实体里已预留），下一批从「开团草稿」这个
 * 已经有确认闭环的节点先接。
 */
@Controller('admin/ai-insight')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class AiInsightAdminController {
  constructor(private readonly svc: AiInsightService) {}

  /** 列表（分页）。正文只给 120 字摘要，全文走详情 —— 列表不需要几 KB 文本 */
  @Get()
  async list(@Query() q: ListInsightDto): Promise<{
    list: Array<Record<string, unknown>>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const r = await this.svc.list(q);
    return {
      ...r,
      list: r.list.map((x) => ({ ...x, createdAt: toBjIso(x.createdAt) })),
    };
  }

  /**
   * 节点清单（筛选下拉用）。
   * 只列**库里真实出现过**的 kind，不写死枚举 —— 新增节点后不用改前端。
   * ⚠️ 必须声明在 `:id` 之前：Nest 按声明顺序匹配，否则 `kinds` 会被当成 id 解析而 400。
   */
  @Get('kinds')
  async kinds(): Promise<{ list: Array<{ kind: string; count: number }> }> {
    return { list: await this.svc.kinds() };
  }

  /** 详情（含全文与 meta） */
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    const row = await this.svc.detail(id);
    let meta: unknown = null;
    if (row.metaJson) {
      try {
        meta = JSON.parse(row.metaJson);
      } catch {
        // 落库时是我们自己 stringify 的，解析不出说明数据被外力改坏 ——
        // 不抛错（页面还能看正文），原样把脏串回显，好过假装没有
        meta = { parseError: true, raw: row.metaJson };
      }
    }
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      source: row.source,
      status: row.status,
      actorName: row.actorName,
      decidedBy: row.decidedBy,
      meta,
      createdAt: toBjIso(row.createdAt),
      decidedAt: toBjIso(row.decidedAt),
    };
  }

  /** 标记采纳 / 忽略 / 退回待看 */
  @Post(':id/decide')
  async decide(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DecideInsightDto,
    @CurrentAdmin() admin: JwtPayload | undefined,
  ): Promise<{ id: number; status: string }> {
    const row = await this.svc.decide(id, dto.status, admin?.username ?? null);
    return { id: row.id, status: row.status };
  }
}
