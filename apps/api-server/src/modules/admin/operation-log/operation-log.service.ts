import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { ROLE_LABEL } from '../../../common/constants/admin-role';
import { addDays, bjDateTime, toBjIso } from '../../../common/utils/time';
import { normalizePage, paginate } from '../../../common/utils/response';
import { AdminUser, OperationLog } from '../../../database/entities/system.entity';
import { OperationLogQueryDto } from '../dto/admin.dto';

/** 操作日志对外视图 */
export interface OperationLogItem {
  id: number;
  operatorId: number | null;
  operatorName: string | null;
  operatorRole: string | null;
  operatorRoleLabel: string | null;
  module: string;
  action: string;
  targetId: string | null;
  requestIp: string | null;
  requestData: unknown;
  responseData: unknown;
  /** 是否失败（审计关注「谁试图做了什么但被拒」） */
  failed: boolean;
  createdAt: string | null;
}

/**
 * 操作日志查询 · D56
 *
 * 数据源 `ab_operation_log`，由 `OperationLogInterceptor` 按 `@OperationLog()`
 * 元数据写入（写入失败只 WARN，不影响业务 —— 见该拦截器注释）。
 *
 * ⚠️ **日期过滤按北京时间自然日**：`date=2026-09-15` → `[15 00:00+08, 16 00:00+08)`。
 *    库里的 `created_at` 是 UTC 存储，直接按字符串 truncate 会错 8 小时。
 */
@Injectable()
export class OperationLogService {
  constructor(
    @InjectRepository(OperationLog) private readonly logRepo: Repository<OperationLog>,
    @InjectRepository(AdminUser) private readonly adminRepo: Repository<AdminUser>,
  ) {}

  async list(q: OperationLogQueryDto) {
    const { page, pageSize, skip } = normalizePage(q);

    const where: Record<string, unknown> = {};
    if (q.operatorId) where.adminUserId = q.operatorId;
    if (q.module) where.module = q.module;
    if (q.date) {
      where.createdAt = Between(bjDateTime(q.date, 0), bjDateTime(addDays(q.date, 1), 0));
    }

    const [rows, total] = await this.logRepo.findAndCount({
      where,
      order: { id: 'DESC' },
      skip,
      take: pageSize,
    });

    const names = await this.operatorNames(rows.map((r) => r.adminUserId));

    return {
      ...paginate(
        rows.map((r) => this.toItem(r, names)),
        total,
        page,
        pageSize,
      ),
      /** 供前端「操作人」下拉用；日志量不大，直接全量给 */
      operators: await this.operatorOptions(),
    };
  }

  // ------------------------------------------------------------------ 内部

  private async operatorNames(
    ids: Array<number | null | undefined>,
  ): Promise<Map<number, { name: string; role: string }>> {
    const uniq = [...new Set(ids.filter((v): v is number => typeof v === 'number' && v > 0))];
    if (uniq.length === 0) return new Map();
    const rows = await this.adminRepo.find({ where: uniq.map((id) => ({ id })) });
    return new Map(rows.map((r) => [r.id, { name: r.realName ?? r.username, role: r.role }]));
  }

  private async operatorOptions(): Promise<
    Array<{ id: number; name: string; role: string; roleLabel: string }>
  > {
    const rows = await this.adminRepo.find({ order: { id: 'ASC' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.realName ?? r.username,
      role: r.role,
      roleLabel: ROLE_LABEL[r.role] ?? r.role,
    }));
  }

  private toItem(
    log: OperationLog,
    names: Map<number, { name: string; role: string }>,
  ): OperationLogItem {
    const operator = log.adminUserId ? names.get(log.adminUserId) : undefined;
    const resp = log.responseData as { error?: { code?: number } } | null | undefined;

    return {
      id: log.id,
      operatorId: log.adminUserId ?? null,
      operatorName: operator?.name ?? null,
      operatorRole: operator?.role ?? null,
      operatorRoleLabel: operator ? (ROLE_LABEL[operator.role] ?? operator.role) : null,
      module: log.module,
      action: log.action,
      targetId: log.targetId ?? null,
      requestIp: log.requestIp ?? null,
      requestData: log.requestData ?? null,
      responseData: log.responseData ?? null,
      failed: !!resp?.error,
      createdAt: toBjIso(log.createdAt),
    };
  }
}
