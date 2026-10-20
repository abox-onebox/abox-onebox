/**
 * 指令解析（文本 → 结构化意图）
 *
 * v1 采用**结构化命令语言**（非自由自然语言），保证可追溯、可审计、不会误执行：
 *
 *   帮助                         → 帮助菜单
 *   我的申请  [status=...]       → 查我提交的高危审批进度（query q_my_requests）
 *   查询 <qKey> [k=v ...]        → 只读查数（query）
 *   执行 <opCode> [k=v ...]      → 直执行（operator，low 危免确认；high/mid 仍走后台）
 *   提交 <opCode> [k=v ...]      → 提交审批申请（operator，两步流第一步）
 *   撤回 <requestId> [reason=...]→ 撤回未审批申请（operator）
 *   审批通过 <requestId>         → 审批通过（approver）
 *   审批拒绝 <requestId> [reason=...] → 审批拒绝（approver）
 *
 * 参数写法：k=v 或 k="带空格的值"。数组类参数（ids/targetDates/buildingGroupIds/items）
 * 用逗号分隔，由 op-proxy 在发送前拆分数组。
 *
 * 自由自然语言（如「帮我把明天的套餐分配给量子大厦」）留作后续：可复用 KB 前端的
 * NL_KEYS 路由表，但对齐参数抽取成本高，v1 先用结构化命令跑通闭环。
 */

export type Intent =
  | { kind: 'help' }
  | { kind: 'my_requests'; params: Record<string, string> }
  | { kind: 'exec'; opCode: string; params: Record<string, string> }
  | { kind: 'submit'; opCode: string; params: Record<string, string> }
  | { kind: 'recall'; requestId: string; reason?: string }
  | { kind: 'query'; qCode: string; params: Record<string, string> }
  | { kind: 'approve'; requestId: string }
  | { kind: 'reject'; requestId: string; reason?: string }
  | { kind: 'unknown'; raw: string };

function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1];
    const val = m[3] ?? m[4] ?? m[5] ?? '';
    out[key] = val;
  }
  return out;
}

export function parseCommand(text: string): Intent {
  const t = (text || '').trim();
  if (!t) return { kind: 'unknown', raw: t };

  if (t === '帮助' || t === 'help' || t === '?') return { kind: 'help' };
  if (t === '我的申请' || t === '待审' || t === '我的待审') {
    return { kind: 'my_requests', params: {} };
  }

  const sp = t.indexOf(' ');
  const verb = sp === -1 ? t : t.slice(0, sp);
  const rest = sp === -1 ? '' : t.slice(sp + 1).trim();

  switch (verb) {
    case '执行':
    case 'exec': {
      const sp2 = rest.indexOf(' ');
      const opCode = sp2 === -1 ? rest : rest.slice(0, sp2);
      const params = parseParams(sp2 === -1 ? '' : rest.slice(sp2 + 1));
      if (!opCode) return { kind: 'unknown', raw: t };
      return { kind: 'exec', opCode, params };
    }
    case '提交':
    case 'submit': {
      const sp2 = rest.indexOf(' ');
      const opCode = sp2 === -1 ? rest : rest.slice(0, sp2);
      const params = parseParams(sp2 === -1 ? '' : rest.slice(sp2 + 1));
      if (!opCode) return { kind: 'unknown', raw: t };
      return { kind: 'submit', opCode, params };
    }
    case '查询':
    case 'query': {
      const sp2 = rest.indexOf(' ');
      const qCode = sp2 === -1 ? rest : rest.slice(0, sp2);
      const params = parseParams(sp2 === -1 ? '' : rest.slice(sp2 + 1));
      if (!qCode) return { kind: 'unknown', raw: t };
      return { kind: 'query', qCode, params };
    }
    case '撤回':
    case 'recall': {
      const sp2 = rest.indexOf(' ');
      const requestId = sp2 === -1 ? rest : rest.slice(0, sp2);
      const params = parseParams(sp2 === -1 ? '' : rest.slice(sp2 + 1));
      if (!requestId) return { kind: 'unknown', raw: t };
      return { kind: 'recall', requestId, reason: params.reason };
    }
    case '审批通过':
    case 'approve': {
      const requestId = rest.trim();
      if (!requestId) return { kind: 'unknown', raw: t };
      return { kind: 'approve', requestId };
    }
    case '审批拒绝':
    case 'reject': {
      const sp2 = rest.indexOf(' ');
      const requestId = sp2 === -1 ? rest : rest.slice(0, sp2);
      const params = parseParams(sp2 === -1 ? '' : rest.slice(sp2 + 1));
      if (!requestId) return { kind: 'unknown', raw: t };
      return { kind: 'reject', requestId, reason: params.reason };
    }
    default:
      return { kind: 'unknown', raw: t };
  }
}

export const HELP_TEXT = [
  '【KB 助手 · 企业微信指令】',
  '帮助 / 我的申请',
  '查询 <qKey> [k=v]  例：查询 q_orders date=2026-10-20',
  '执行 <opCode> [k=v]  例：执行 publish_assignment id=123 action=publish',
  '提交 <opCode> [k=v]  例：提交 force_refund orderNo=A123 reason=错单',
  '撤回 <requestId> [reason=...]',
  '审批通过 <requestId> / 审批拒绝 <requestId> [reason=...]',
  'opCode 清单见后台「替操作」页；数组参数用逗号分隔（ids=1,2,3）。',
].join('\n');
