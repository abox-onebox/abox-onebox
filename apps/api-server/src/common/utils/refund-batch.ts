/**
 * E5 · 批量退款审批的**判据纯函数**（2026-10-29）
 *
 * ## 为什么要有这个文件
 * 运营出口此前只有 `POST /admin/orders/:orderNo/force-refund`（**单笔**）：楼宇封控、
 * 异常运营日这类「一批单要一起退」的场景，运营只能一笔一笔点。而 `refund.service.ts`
 * **全仓没有单测** ⇒ 批量编排的判据若写进服务方法，就没有任何机械检查会拦它。
 * 抽成纯函数后可直接喂样本断言（见 `test/unit/refund-batch.spec.ts`）。
 *
 * ## ⛔ 本文件**不做**的事：不发明新的退款执行路径
 * 批量只是「把 N 个 id 依次喂给既有的 `approveByAdmin` / `rejectByAdmin`」的**编排层**，
 * 账务口径零分叉（与 `ADR-N1N2W1` §D-N2-3 一致：真要撤，走既有的逐单审批通道）。
 *
 * ## 批次的真正风险：部分成功 + 重试 = 资金事故
 * 一次批量里第 7 笔微信通道超时，前 6 笔已退、后 43 笔没退。此时运营**必然**会再点一次：
 * - 若返回「全部失败」⇒ 运营以为都没退，重试 ⇒ 前 6 笔撞 `40013` 再次报错 ⇒ 一片红，
 *   运营不知道到底退了几笔，只能人工一笔笔对账；
 * - 若返回「全部成功」⇒ 6 笔之外的 43 笔被当成已处理，钱没退出去。
 *
 * 两种都是**谎报**。故这里把结果**强行拆三类**（成功 / 跳过 / 失败），并且：
 * - 「跳过」= 该单已不是待审批（大概率是上一批已处理）⇒ **不是失败**，重试时不再打扰；
 * - 「失败」= 真的没办成 ⇒ 可原样勾回来重试，已成功的不会重复退（下游有原子占位）。
 *
 * ⚠️ 因此**批量重试是安全的**：安全性不靠前端去重、也不靠幂等键，
 *    而靠下游单笔的 `WHERE id=? AND status='applying'` 原子占位 + 这里的三类归并。
 */

import { ErrorCode } from '../constants/error-code';

/**
 * 单次批量的 id 上限
 *
 * 为什么是 50：批量**串行**执行（每笔都要过一遍账务事务 + 微信通道），一笔按 1 秒算，
 * 50 笔约 1 分钟，已经贴着网关超时的边；再大的批次运营也无从逐笔核对结果 ——
 * 「一次退 500 笔、其中 3 笔失败」的返回，运营根本不会去看那 3 笔是谁。
 * 真要退更多，分几批点，每批的返回都能当场看完。
 */
export const REFUND_BATCH_MAX_IDS = 50;

/**
 * 归并成「跳过」而非「失败」的错误码
 *
 * 只有 `40013 REFUND_STATUS_ILLEGAL` —— 它的语义是「这一单已经不是待审批了」，
 * 在批量语境下几乎只可能是**上一轮已处理**（或另一位操作员同时点了）。
 * 这不是本次操作的失败，重试也修不好，如实归到 skipped。
 *
 * ⚠️ 刻意**不含** `40012 REFUND_NOT_FOUND`：id 在预检阶段已逐个查过存在，
 *    运行时变成不存在说明数据被删 —— 那是真异常，该报红去查，不该悄悄跳过。
 * ⚠️ 刻意**不含** `40011 REFUND_AMOUNT_MISMATCH`：金额对不上是**必须人来看**的信号，
 *    跳过它等于把一笔「不知道该退多少」的单永远留在列表里。
 */
export const BATCH_SKIPPABLE_CODES: readonly number[] = [ErrorCode.REFUND_STATUS_ILLEGAL];

/** id 列表归一化结果 */
export interface BatchIdsVerdict {
  /** 去重后、保序、仅正整数的 id */
  ids: number[];
  /** 被丢掉的非法值个数（非数字 / 非整数 / ≤ 0） */
  invalidCount: number;
  /** 重复项个数（同一 id 出现多次） */
  dupCount: number;
}

/**
 * 归一化前端勾选的 id 列表
 *
 * ## 三条取舍
 * 1. **重复项合并而不是报错**：运营在列表里跨页勾选、或点了两次，是常见操作，
 *    合并掉即可；为这种事整批拒绝只会让人重勾一遍。
 * 2. **非法值丢弃而不是报错**：id 由端上从列表行里取，理论上不该有脏值。
 *    真出现了说明**调用方写错了**（与 `30023` 同族），但整批拒绝会让运营办不成事 ——
 *    丢弃 + 计数，由服务层把「丢了几个」写进返回，调用方可自查。
 * 3. **保序**：结果数组按入参顺序，运营看到的返回顺序与勾选顺序一致，便于对照。
 */
export function normalizeBatchIds(raw: unknown): BatchIdsVerdict {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const seen = new Set<number>();
  const ids: number[] = [];
  let invalidCount = 0;
  let dupCount = 0;

  for (const item of list) {
    // 只认 number / 数字字符串：布尔、null、对象、数组一律算非法
    if (typeof item !== 'number' && typeof item !== 'string') {
      invalidCount += 1;
      continue;
    }
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(n)) {
      dupCount += 1;
      continue;
    }
    seen.add(n);
    ids.push(n);
  }

  return { ids, invalidCount, dupCount };
}

/** 批次整体结论（给 tips 与端上提示用，不替代逐条结果） */
export type BatchOutcome =
  /** 没有失败（含「有跳过但没失败」—— 该办的都办了） */
  | 'ok'
  /** 有失败、也有办成的（最需要运营当场看 failed 列表的那种） */
  | 'partial'
  /** 一条都没办成，且全是失败 */
  | 'failed'
  /** 一条都没动：所选全都不是待审批（页面没刷新 / 已被处理） */
  | 'noop';

/**
 * 批次整体结论
 *
 * ⚠️ 判据里 `skipped` **不算失败**（否则重试一片红，见文件头注），
 *    但 `skipped` 也不算成功 —— 全 skipped 时得让运营知道「本次一笔都没退」，
 *    而不是弹一个「操作成功」。
 */
export function classifyBatchOutcome(counts: {
  succeeded: number;
  skipped: number;
  failed: number;
}): BatchOutcome {
  const { succeeded, skipped, failed } = counts;

  if (succeeded === 0 && failed === 0 && skipped > 0) return 'noop';
  if (failed === 0) return 'ok';
  return succeeded > 0 || skipped > 0 ? 'partial' : 'failed';
}

/** 人话提示（端上直接展示，不自己拼） */
export function batchTips(
  outcome: BatchOutcome,
  counts: { succeeded: number; skipped: number; failed: number },
  opt: { action: 'approve' | 'reject'; retryQueuedCount?: number } = { action: 'approve' },
): string {
  const verb = opt.action === 'approve' ? '退款' : '驳回';
  const queued = opt.retryQueuedCount ?? 0;

  switch (outcome) {
    case 'noop':
      return (
        `所选 ${counts.skipped} 笔都不是「待审批」状态，` +
        `本次未做任何${verb} —— 请刷新列表后重新勾选（可能是已被处理或页面数据已过期）`
      );
    case 'ok':
      return (
        `${counts.succeeded} 笔已${verb}` +
        (counts.skipped ? `（另有 ${counts.skipped} 笔此前已处理，本次跳过）` : '') +
        (queued
          ? `；其中 ${queued} 笔微信通道暂时失败，已自动排队重试，无需重复审批`
          : opt.action === 'approve'
            ? '；微信原路退回 1–3 个工作日到账，余额抵扣部分已即时退回'
            : '')
      );
    case 'partial':
      return (
        `${counts.succeeded} 笔已${verb}、${counts.skipped} 笔跳过、${counts.failed} 笔失败` +
        ' —— 请按 failed 列表中的提示处理后重新勾选重试；' +
        '已成功的不会重复退，可直接整批重提'
      );
    case 'failed':
      return `${counts.failed} 笔全部未${verb}，原因见 failed 列表；处理后可原样重试`;
  }
}

/** 单笔执行异常的归并结果 */
export interface BatchErrorVerdict {
  kind: 'skipped' | 'failed';
  /** 业务码（非 BizException 则为 null） */
  code: number | null;
  /** 人话原因（进 failed[].message） */
  message: string;
}

/**
 * 把单笔执行的异常归并成「跳过」还是「失败」
 *
 * 为什么用鸭子类型而不是 `instanceof BizException`：批量编排会 `catch` 到**任何**抛出的
 * 东西（`deliverOrQueueRefund` 之外的通道错误、TypeORM 的 `QueryFailedError`、
 * 以及单测里构造的假异常）。只对「带业务码」的对象做归并，其余一律按失败处理 ——
 * **认不出的错误绝不跳过**（跳过意味着运营不会再看到它）。
 */
export function classifyBatchError(err: unknown): BatchErrorVerdict {
  const raw = (err as { code?: unknown } | null | undefined)?.code;
  const code = typeof raw === 'number' ? raw : null;
  const message =
    err instanceof Error && err.message ? err.message : '未知错误（已记录日志，请联系开发排查）';

  if (code !== null && BATCH_SKIPPABLE_CODES.includes(code)) {
    return { kind: 'skipped', code, message };
  }
  return { kind: 'failed', code, message };
}
