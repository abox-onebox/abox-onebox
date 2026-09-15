import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable, of } from 'rxjs';
import { Repository } from 'typeorm';

import { JwtPayload } from '../decorators/auth.decorator';
import { OPERATION_LOG_KEY, OperationLogMeta } from '../decorators/operation-log.decorator';
import { OperationLog } from '../../database/entities/system.entity';

/** 必须脱敏的字段名（小写比对，含嵌套） */
const REDACT_KEYS = [
  'password',
  'passwordhash',
  'newpassword',
  'oldpassword',
  'token',
  'refreshtoken',
  'secret',
];

/** 单字段最大入库长度，超长截断（避免把整个 base64 图片写进日志表） */
const MAX_FIELD_LEN = 2000;

/**
 * 操作日志拦截器（全局注册，按 `@OperationLog()` 元数据决定是否落库）
 *
 * 设计取舍：
 *   · **同步等待写库完成**再放行响应 —— 日志量小（只标写操作），
 *     可靠性优先于几毫秒延迟；e2e 里也才能「刚操作完就查到日志」。
 *   · **写库失败绝不影响业务**：catch 后仅 WARN。日志是旁路，
 *     不能因为日志表炸了就让「审批退款」失败。
 *   · 失败的业务请求**也记**（`response_data.error` 带错误码），
 *     审计场景下「谁试图做了什么但被拒」同样重要。
 */
@Injectable()
export class OperationLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('OperationLog');

  constructor(
    @InjectRepository(OperationLog) private readonly logRepo: Repository<OperationLog>,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const meta = this.reflector.getAllAndOverride<OperationLogMeta | undefined>(OPERATION_LOG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<{
      params?: Record<string, string>;
      query?: Record<string, unknown>;
      body?: unknown;
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      admin?: JwtPayload;
      user?: JwtPayload;
    }>();

    const subject = req.admin ?? (req.user?.typ === 'admin' ? req.user : undefined) ?? undefined;

    const targetId = this.resolveTargetId(req.params, meta.targetParam);
    const requestData = this.sanitize({
      params: req.params ?? {},
      query: req.query ?? {},
      body: req.body ?? {},
    });

    try {
      const data = await new Promise<unknown>((resolve, reject) => {
        next.handle().subscribe({ next: resolve, error: reject });
      });
      await this.write(subject, meta, targetId, req, requestData, data, null);
      return of(data);
    } catch (err) {
      await this.write(subject, meta, targetId, req, requestData, null, err);
      throw err;
    }
  }

  /** 取对象 ID：优先显式 params，其次常见命名 */
  private resolveTargetId(
    params: Record<string, string> | undefined,
    explicit?: string,
  ): string | null {
    if (!params) return null;
    const keys = explicit ? [explicit] : ['id', 'orderNo', 'leaderId', 'userId', 'username'];
    for (const k of keys) {
      const v = params[k];
      if (v !== undefined && v !== '') return String(v);
    }
    return null;
  }

  /** 递归脱敏 + 截断 */
  private sanitize(value: unknown, depth = 0): unknown {
    if (depth > 4) return '[depth-limit]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      return value.length > MAX_FIELD_LEN ? `${value.slice(0, MAX_FIELD_LEN)}…[truncated]` : value;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => this.sanitize(v, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.includes(k.toLowerCase()) ? '[redacted]' : this.sanitize(v, depth + 1);
    }
    return out;
  }

  private async write(
    subject: JwtPayload | undefined,
    meta: OperationLogMeta,
    targetId: string | null,
    req: { ip?: string; headers?: Record<string, string | string[] | undefined> },
    requestData: unknown,
    responseData: unknown,
    error: unknown,
  ): Promise<void> {
    try {
      const xff = req.headers?.['x-forwarded-for'];
      const ip = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() || req.ip || null;

      await this.logRepo.save(
        this.logRepo.create({
          adminUserId: subject?.sub ?? null,
          module: meta.module,
          action: meta.action,
          targetId,
          requestIp: ip ? ip.slice(0, 64) : null,
          requestData,
          responseData: this.sanitize(
            error
              ? {
                  error: {
                    code: (error as { code?: number }).code ?? null,
                    message: (error as Error).message,
                  },
                }
              : responseData,
          ),
          snapshot: {
            operator: subject?.username ?? null,
            role: subject?.role ?? null,
            at: new Date().toISOString(),
          },
        }),
      );
    } catch (e) {
      // 旁路失败不影响业务：仅告警
      this.logger.warn(`操作日志写入失败（业务已正常返回）：${(e as Error).message}`);
    }
  }
}
