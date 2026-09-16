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

    const targetId = this.resolveTargetId(req.params, req.body, meta.targetParam);
    const requestData = this.sanitize({
      params: req.params ?? {},
      query: req.query ?? {},
      body: req.body ?? {},
    });

    try {
      const data = await new Promise<unknown>((resolve, reject) => {
        next.handle().subscribe({ next: resolve, error: reject });
      });
      // 请求里没有 id 的（新建类）拿响应里的新对象 id 兜底，见下方注释
      const finalTargetId = targetId ?? this.resolveTargetIdFromResponse(data);
      await this.write(subject, meta, finalTargetId, req, requestData, data, null);
      return of(data);
    } catch (err) {
      await this.write(subject, meta, targetId, req, requestData, null, err);
      throw err;
    }
  }

  /**
   * 取操作对象 ID
   *
   * 顺序：显式 `targetParam` → 常见 **params** 命名 → 常见 **body** 命名。
   *
   * ⚠️ 为什么要看 body：像 D10 手动改单这种「目标对象在请求体里」的接口
   *    （`POST /admin/orders/manual-adjust` 带 `{orderNo}`），只看 params 会得到
   *    `targetId=null`。这条日志就再也挂不到那笔订单上了 —— 而订单详情页正是
   *    靠 `target_id` 反查「这单被谁改过」的。
   *    显式 `targetParam` 仍优先，方便个别接口指定非通用字段名。
   */
  private resolveTargetId(
    params: Record<string, string> | undefined,
    body: unknown,
    explicit?: string,
  ): string | null {
    const bodyObj =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    const keys = explicit ? [explicit] : ['id', 'orderNo', 'leaderId', 'userId', 'username'];

    for (const k of keys) {
      const v = params?.[k];
      if (v !== undefined && v !== '') return String(v);
    }
    for (const k of keys) {
      const v = bodyObj?.[k];
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
    return null;
  }

  /**
   * 新建类接口的兜底：从**响应体**里取新对象的 id
   *
   * ⚠️ 为什么需要：`POST /admin/suppliers` 这类「创建」接口，请求 `params` 与
   *    `body` 里**都没有 id**（id 由服务端生成）—— 只看请求必然拿到
   *    `targetId = null`。这条日志就再也挂不到那个对象上了：日后要查「这家
   *    供应商是谁建的」只能靠翻 `request_data` 全文比对名字，审计等于半残。
   *
   * 只认 `id` 与 `data.id` 两种形状（统一响应会包一层），**不深挖**：
   * 猜得越深越容易把子对象的 id 当成目标（响应里同时有 `order.id` 与 `user.id`
   * 时，选错一个就把「改了这单」记成「改了这个用户」）。
   * 个别接口需要精确指定时，仍用 `@OperationLog({ targetParam })` 显式声明。
   */
  private resolveTargetIdFromResponse(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    const pickId = (v: unknown): string | null => {
      if (v === null || v === undefined || v === '') return null;
      return typeof v === 'number' || typeof v === 'string' ? String(v) : null;
    };
    const outer = data as Record<string, unknown>;
    const inner =
      outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data)
        ? (outer.data as Record<string, unknown>)
        : outer;
    return pickId(inner.id);
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
