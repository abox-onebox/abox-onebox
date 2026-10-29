import type { QueryOrderResult } from '../../providers/wx-pay/wx-pay.provider';

/**
 * P3 · 支付单边账补齐的**判据纯函数**（2026-10-29）
 *
 * ## 为什么判据必须是纯函数
 * `order.service.ts` 全仓没有单测（见《工程纪律》），凡写在服务方法里的判定
 * 就**没有任何机械检查**会拦它 —— 写错了只能等线上资金差错来暴露。
 * 把「查单结果 → 该做什么」抽成纯函数，单测就能直接喂样本断言。
 *
 * ## 动作词典（**四种，不可再合并**）
 *
 * | 动作 | 触发条件 | 为什么是这个动作 |
 * |---|---|---|
 * | `paid` | 微信明确 `SUCCESS` 且金额与本地一致 | 钱已收，本地补入账 |
 * | `amount_mismatch` | 微信 `SUCCESS` 但金额与本地不符 | **不入账**：宁可挂着，不可按错额入账（`markPaid` 也会拒，此处只是先分类） |
 * | `still_unpaid` | 微信明确 `NOTPAY/CLOSED/PAYERROR/REVOKED/ACCEPT` | 用户确实没付成 ⇒ 交给既有截单流程，本处**不动单** |
 * | `not_found` | 微信明确无此单 | 订单号可能根本没送到微信 ⇒ 记一笔交人工 |
 * ⛔ 查询**失败**由调用方 `catch` 后计 `failed`，**不经过本函数** ——
 *    因为「没拿到回答」必须导致「不动单 + 下次重试」，不能落进上表任何一格。
 *
 * ## ⛔ 三条不可逾越的红线
 * 1. **`found:false` 绝不等于「没付」** —— 它是「微信说没这笔单」（可能订单号没送达），
 *    而「通道挂了」是异常，两者一旦合并，「收了钱还关单」的资金差错就无人能拦；
 * 2. **`REFUND` 不算已支付** —— 付过又退了，本地补入账会凭空造一笔已付订单；
 * 3. **本函数不写库、不发通知**，只回答「该做什么」。副作用一律在服务层，
 *    这样同一份判据既服务定时跑批，也服务将来端上被动补齐。
 */

export type ReconcileAction = 'paid' | 'amount_mismatch' | 'still_unpaid' | 'not_found';

/** 判据入参：本地订单快照 + 微信查单结果 */
export interface ReconcileDecisionInput {
  /** 本地待支付金额（分） */
  payAmountFen: number;
  /** 微信查单结果（调用方保证：查询失败**不会**走到这里） */
  query: QueryOrderResult;
}

export interface ReconcileDecision {
  action: ReconcileAction;
  /** 人话说明（进日志与后台补跑回执，便于运营不读码也能懂） */
  note: string;
}

/** 微信明确回答「已支付且可入账」的状态 */
const PAID_STATES = new Set(['SUCCESS']);

/** 微信明确回答「这笔没付成」的状态（不含 UNKNOWN —— 那不是回答） */
const UNPAID_STATES = new Set(['NOTPAY', 'CLOSED', 'REVOKED', 'PAYERROR', 'ACCEPT']);

/**
 * 查单结果 → 动作
 *
 * @param input 见 `ReconcileDecisionInput`
 * @returns 动作 + 说明；**不抛异常**（调用方已保证 `query` 是成功拿到的回答）
 */
export function decideReconcileAction(input: ReconcileDecisionInput): ReconcileDecision {
  const { payAmountFen } = input;
  const q = input.query;

  // ① 微信明确「没这笔单」—— 与「查询失败」严格分开（后者根本不会进来）
  if (!q.found) {
    return {
      action: 'not_found',
      note: '微信侧查无此订单（订单号可能未送达微信），需人工核对',
    };
  }

  // ② 明确已支付：先核金额，再决定能不能入账
  if (PAID_STATES.has(q.tradeState)) {
    if (typeof q.amountFen !== 'number' || q.amountFen <= 0) {
      return {
        action: 'amount_mismatch',
        note: '微信返回已支付但未给出有效金额，不予入账（防按未知金额入账）',
      };
    }
    if (q.amountFen !== payAmountFen) {
      return {
        action: 'amount_mismatch',
        note: `微信实收 ${q.amountFen} 分与本地应收 ${payAmountFen} 分不符，不予入账`,
      };
    }
    return { action: 'paid', note: '微信侧已支付，本地补入账' };
  }

  // ③ 明确未支付 / 已关单 / 支付失败 —— 交既有截单流程，本处不动单
  if (UNPAID_STATES.has(q.tradeState)) {
    return {
      action: 'still_unpaid',
      note: `微信侧状态为 ${q.tradeState}，未产生收款（保持原状，由截单流程处理）`,
    };
  }

  // ④ 兜底：`REFUND`（付过又退）与 `UNKNOWN`（拿到了回答但看不懂）都**不可入账**
  return {
    action: 'still_unpaid',
    note: `微信侧状态为 ${q.tradeState}，不可判定为有效收款 —— 保持原状并留痕，需人工核对`,
  };
}
