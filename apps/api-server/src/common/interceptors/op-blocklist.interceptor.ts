import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { BizException } from '../exceptions/biz.exception';
import { ErrorCode } from '../constants/error-code';
import { OpBlocklistService } from '../services/op-blocklist.service';

/**
 * 知识助手禁止清单拦截器（全局注册 - P1-c - 2026-10-19）
 *
 * 仅对带 X-KB-OpBlock 头的写请求生效：解析头里的 op，若在服务端禁止清单中，
 * 直接抛 BizException(OP_BLOCKED)，HTTP 仍 200（code!=0 表达失败，契合后端约定）。
 *
 * 设计取舍：
 * - 普通后台人工写操作不带该头，直接放行（禁止清单约束的是助手自动化，不是人类管理员）。
 * - 仅 POST/PUT/DELETE 检查（GET 不写库）。
 * - 解码逻辑与 OperationLogInterceptor.decodeKbHeader 一致（base64 转 UTF-8，纯 ASCII 回落）。
 * - 查清单本身异常（如 DB 抖动）fail-open 放行并告警：目标接口自身也要 DB；
 *   且高危提交路径另有 OperationRequestService.create 的强闸（查异常即拒绝），双层不重叠失效。
 */
@Injectable()
export class OpBlocklistInterceptor implements NestInterceptor {
  private readonly logger = new Logger('OpBlocklist');

  constructor(private readonly svc: OpBlocklistService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<{
      method?: string;
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const method = req && req.method;
    if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return next.handle();
    const raw = this.firstHeader(req && req.headers, 'x-kb-opblock');
    if (!raw) return next.handle();
    const op = this.decodeOp(raw);
    if (!op) return next.handle();
    try {
      const blocked = await this.svc.isBlocked(op);
      if (blocked) {
        throw new BizException(
          ErrorCode.OP_BLOCKED,
          '操作 ' + op + ' 已被管理员列入禁止清单，助手无法执行',
        );
      }
    } catch (e) {
      if (e instanceof BizException) throw e;
      this.logger.warn('禁止清单查询失败，放行助手写操作：' + (e as Error).message);
    }
    return next.handle();
  }

  private decodeOp(raw: string): string | null {
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      if (decoded && Buffer.from(decoded, 'utf8').toString('base64') === raw.replace(/\s+/g, '')) {
        const obj = JSON.parse(decoded);
        return obj && typeof obj.op === 'string' ? obj.op : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  private firstHeader(
    h: Record<string, string | string[] | undefined> | undefined,
    k: string,
  ): string | null {
    const v = h && h[k];
    if (Array.isArray(v)) return v[0] != null ? v[0] : null;
    return v != null ? v : null;
  }
}
