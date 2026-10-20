import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { lookupOp, lookupQuery, OpMeta } from './op-meta';

/**
 * op 代理：bot 的「文本前端」忠实复用 api-server 既有 /api/v1 端点
 *
 * 设计原则（铁律）：**不另写 op 逻辑**，只把 KB 网页发出的请求在服务器内网重放一遍。
 * 这样后台的校验 / 幂等 / 审计 / 禁止清单 / 强制改密 全部原样生效，单一真源。
 *
 * 调用走 WECOM_INTERNAL_API_BASE（默认 127.0.0.1:PORT），服务器内网、同源，
 * 不经浏览器 → 不受 CORS 约束（KB 发布域白名单是给浏览器用的，bot 不需要）。
 *
 * 头字段与 KB 前端逐一对应（index.html execOp/submitRequest/approvalPost）：
 *   Authorization: Bearer <token>
 *   X-KB-Operator: base64(operatorName)
 *   X-KB-NL:      base64(自然语言原文，截断 500)
 *   X-KB-OpBlock: base64({op, params})   ← 触发后台禁止清单拦截
 *   Idempotency-Key: <随机>              ← 防企业微信重试导致的重复执行
 */

export interface Binding {
  operatorName: string;
  operatorToken?: string | null;
  approverToken?: string | null;
}

export interface ProxyResult {
  code: number;
  message: string;
  data: unknown;
}

const ARRAY_KEYS = new Set(['ids', 'targetDates', 'buildingGroupIds', 'items']);

@Injectable()
export class OpProxyService {
  private readonly logger = new Logger(OpProxyService.name);

  private base(): string {
    return (
      process.env.WECOM_INTERNAL_API_BASE || 'http://127.0.0.1:' + (process.env.PORT || '3000')
    );
  }
  private b64(s: string): string {
    return Buffer.from(s, 'utf8').toString('base64');
  }
  private idem(): string {
    return crypto.randomBytes(12).toString('hex');
  }
  private fill(endpoint: string, params: Record<string, string>): string {
    return endpoint.replace(/:(\w+)/g, (_m, k: string) => encodeURIComponent(params[k] ?? ''));
  }
  private coerce(params: Record<string, string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') continue;
      out[k] = ARRAY_KEYS.has(k) && v.includes(',') ? v.split(',').map((x) => x.trim()) : v;
    }
    return out;
  }

  private async call(url: string, init: RequestInit): Promise<ProxyResult> {
    try {
      const resp = await fetch(url, init);
      const text = await resp.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      // body 经 JSON.parse 出来是 unknown；收敛成「可能缺字段的对象」再按字段判定，
      // 与原先 any 写法的运行时语义逐分支等价（null/标量/字符串/对象四种入参都走过）。
      const parsed = (body ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
      const code = typeof parsed.code === 'number' ? parsed.code : resp.ok ? 0 : resp.status;
      const message = parsed.message ? String(parsed.message) : String(text).slice(0, 300);
      const data = parsed.data !== undefined ? parsed.data : null;
      return { code, message, data };
    } catch (e) {
      this.logger.error('op 代理请求失败：' + (e as Error).message);
      return { code: -1, message: '请求未送达：' + (e as Error).message, data: null };
    }
  }

  private opHeaders(
    b: Binding,
    opCode: string,
    params: Record<string, string>,
    nlText: string,
  ): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (b.operatorToken || ''),
      'X-KB-Operator': this.b64(b.operatorName),
      'X-KB-NL': this.b64((nlText || '').slice(0, 500)),
      'X-KB-OpBlock': this.b64(JSON.stringify({ op: opCode, params })),
      'Idempotency-Key': this.idem(),
    };
  }
  private approveHeaders(
    b: Binding,
    requestId: string,
    action: 'approve' | 'reject',
    nlText: string,
  ): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (b.approverToken || ''),
      'X-KB-Operator': this.b64(b.operatorName),
      'X-KB-NL': this.b64((nlText || '').slice(0, 500)),
      'X-KB-OpBlock': this.b64(
        JSON.stringify({ op: 'approval', params: { id: requestId, action } }),
      ),
      'Idempotency-Key': this.idem(),
    };
  }
  private queryHeaders(b: Binding): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (b.operatorToken || ''),
      'X-KB-Operator': this.b64(b.operatorName),
    };
  }

  private needOperator(b: Binding): ProxyResult | null {
    if (!b.operatorToken)
      return {
        code: 401,
        message: '该 userid 未绑定 operator 令牌，请联系管理员在后台预绑定。',
        data: null,
      };
    return null;
  }
  private needApprover(b: Binding): ProxyResult | null {
    if (!b.approverToken)
      return {
        code: 401,
        message: '该 userid 未绑定 approver 令牌，请联系管理员在后台预绑定。',
        data: null,
      };
    return null;
  }

  /** 直执行（operator 令牌；low 危后台免确认，high/mid 仍过后台校验） */
  async exec(
    opCode: string,
    params: Record<string, string>,
    b: Binding,
    nlText: string,
  ): Promise<ProxyResult> {
    const fail = this.needOperator(b);
    if (fail) return fail;
    const meta: OpMeta | undefined = lookupOp(opCode);
    if (!meta) return { code: 404, message: `未知操作码 ${opCode}`, data: null };
    const missing = meta.required.filter((k) => params[k] == null || params[k] === '');
    if (missing.length)
      return { code: 422, message: `缺少必填参数：${missing.join('、')}`, data: null };
    const url = this.base() + '/api/v1' + this.fill(meta.endpoint, params);
    const init: RequestInit = {
      method: meta.method,
      headers: this.opHeaders(b, opCode, params, nlText),
    };
    if (meta.method !== 'GET') init.body = JSON.stringify(this.coerce(params));
    return this.call(url, init);
  }

  /** 提交审批申请（operator 令牌，两步流第一步） */
  async submit(
    opCode: string,
    params: Record<string, string>,
    b: Binding,
    nlText: string,
  ): Promise<ProxyResult> {
    const fail = this.needOperator(b);
    if (fail) return fail;
    const meta: OpMeta | undefined = lookupOp(opCode);
    if (!meta) return { code: 404, message: `未知操作码 ${opCode}`, data: null };
    const missing = meta.required.filter((k) => params[k] == null || params[k] === '');
    if (missing.length)
      return { code: 422, message: `缺少必填参数：${missing.join('、')}`, data: null };
    const url = this.base() + '/api/v1/admin/operation-requests';
    const body = {
      opCode,
      params: this.coerce(params),
      submitterKb: b.operatorName,
      submitterNl: (nlText || '').slice(0, 500),
      submitterOpBlock: { op: opCode, params },
    };
    const init: RequestInit = {
      method: 'POST',
      headers: this.opHeaders(b, opCode, params, nlText),
      body: JSON.stringify(body),
    };
    return this.call(url, init);
  }

  /** 撤回未审批申请（operator 令牌） */
  async recall(
    requestId: string,
    reason: string | undefined,
    b: Binding,
    nlText: string,
  ): Promise<ProxyResult> {
    const fail = this.needOperator(b);
    if (fail) return fail;
    const url =
      this.base() + '/api/v1/admin/operation-requests/' + encodeURIComponent(requestId) + '/recall';
    const params = { id: requestId, reason: reason || '' };
    const init: RequestInit = {
      method: 'POST',
      headers: this.opHeaders(b, 'recall_request', params, nlText),
      body: JSON.stringify(this.coerce(params)),
    };
    return this.call(url, init);
  }

  /** 只读查数（operator 令牌） */
  async query(qCode: string, params: Record<string, string>, b: Binding): Promise<ProxyResult> {
    const fail = this.needOperator(b);
    if (fail) return fail;
    const meta: OpMeta | undefined = lookupQuery(qCode);
    if (!meta) return { code: 404, message: `未知查询码 ${qCode}`, data: null };
    let url = this.base() + '/api/v1' + this.fill(meta.endpoint, params);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, v);
    const q = qs.toString();
    if (q) url += '?' + q;
    return this.call(url, { method: 'GET', headers: this.queryHeaders(b) });
  }

  /** 审批通过（approver 令牌） */
  async approve(requestId: string, b: Binding, nlText: string): Promise<ProxyResult> {
    const fail = this.needApprover(b);
    if (fail) return fail;
    const url =
      this.base() +
      '/api/v1/admin/operation-requests/' +
      encodeURIComponent(requestId) +
      '/approve';
    return this.call(url, {
      method: 'POST',
      headers: this.approveHeaders(b, requestId, 'approve', nlText),
      body: '{}',
    });
  }

  /** 审批拒绝（approver 令牌） */
  async reject(
    requestId: string,
    reason: string | undefined,
    b: Binding,
    nlText: string,
  ): Promise<ProxyResult> {
    const fail = this.needApprover(b);
    if (fail) return fail;
    const url =
      this.base() + '/api/v1/admin/operation-requests/' + encodeURIComponent(requestId) + '/reject';
    const body = reason ? JSON.stringify({ reason }) : '{}';
    return this.call(url, {
      method: 'POST',
      headers: this.approveHeaders(b, requestId, 'reject', nlText),
      body,
    });
  }
}
