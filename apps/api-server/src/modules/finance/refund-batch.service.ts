import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { REFUND_STATUS_LABEL, RefundStatus } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { toFen } from '../../common/utils/money';
import {
  batchTips,
  classifyBatchError,
  classifyBatchOutcome,
  normalizeBatchIds,
  REFUND_BATCH_MAX_IDS,
} from '../../common/utils/refund-batch';
import { Refund } from '../../database/entities/order.entity';
import { RefundService } from './refund.service';

/**
 * E5 · 批量退款审批（D41 / D42 的批量形态 · 2026-10-29）
 *
 * ## 这是什么、不是什么
 * 本服务**不实现任何退款逻辑** —— 它只是把 N 个 id 依次喂给既有的
 * `RefundService.approveByAdmin` / `rejectByAdmin`。账务、余额退回、佣金冲销、
 * 退券、微信通道调用全在下游那一个执行口里，批量与单笔**共用同一条代码路径**
 * （与 `ADR-N1N2W1` §D-N2-3「真要撤，走既有的逐单审批通道」一致）。
 * ⇒ 这里加的任何「批量特例」都会变成两套口径，那是比没有批量更糟的状态。
 *
 * ## 为什么不是「一个大事务」
 * 有人会想把 N 笔包进一个事务，失败了整体回滚，看起来干净。但：
 * ① 每笔退款都要**调微信通道**（事务外的 IO），把它塞进事务会把连接池压死；
 * ② 更致命的是 —— 事务回滚了，微信那边**已经退出去的钱退不回来**，
 *    「看起来整体成功或整体失败」在资金动作里是**假的**。
 * ⇒ 逐笔独立提交，用**如实的三类结果**（成功 / 跳过 / 失败）把不干净的部分暴露出来。
 *
 * ## 为什么串行而不是并发
 * 并发 N 笔退款会让同一用户的多笔单互相抢行锁、也会把微信通道的频率打满；
 * 且失败归因会变乱（谁先谁后不确定）。批量是**运营当场看着结果**的操作，
 * 慢一点（50 笔约 1 分钟）换来可核对，值得。
 *
 * ## ⛔ 不提供「按条件批量」
 * 只有显式 id 列表：运营必须在列表里逐个勾过。见 `BatchApproveRefundDto` 的注释。
 */
@Injectable()
export class RefundBatchService {
  private readonly logger = new Logger('RefundBatchService');

  constructor(
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
    private readonly refundService: RefundService,
  ) {}

  // ==========================================================================
  // D41 批量 · 审批通过
  // ==========================================================================
  async batchApprove(
    rawIds: unknown,
    adminId: number,
    remark?: string,
  ): Promise<BatchRefundResult> {
    const batch = await this.prepare(rawIds);

    const succeeded: BatchRefundSucceededItem[] = [];
    const skipped: BatchRefundSkippedItem[] = [];
    const failed: BatchRefundFailedItem[] = [];

    for (const id of batch.ids) {
      const refund = batch.map.get(id)!;

      // 预读已判过状态：非待审批的直接跳过，**不进执行口**
      // （进了也是抛 40013，意义相同，但会污染日志、且浪费一次事务）
      if (refund.status !== RefundStatus.APPLYING) {
        skipped.push({
          ...this.brief(refund),
          reason:
            `当前状态「${REFUND_STATUS_LABEL[refund.status] ?? refund.status}」，` +
            '不是待审批（可能已被处理，或列表数据已过期）',
        });
        continue;
      }

      try {
        const r = await this.refundService.approveByAdmin(id, adminId, remark);
        succeeded.push({
          id,
          refundNo: r.refundNo,
          orderNo: r.orderNo,
          amountFen: r.refundedFen,
          wxRefundedFen: r.wxRefundedFen,
          balanceRefundedFen: r.balanceRefundedFen,
          /** 微信通道未受理 = 已入队重试：账务已落库，运营**不要**重复审批 */
          wxDelivered: r.wxDelivered,
          retryQueued: r.retryQueued,
        });
      } catch (err) {
        this.pushError(skipped, failed, id, refund, err);
      }
    }

    return this.summarize('approve', batch, succeeded, skipped, failed, adminId);
  }

  // ==========================================================================
  // D42 批量 · 审批驳回
  // ==========================================================================
  async batchReject(rawIds: unknown, adminId: number, reason: string): Promise<BatchRefundResult> {
    const batch = await this.prepare(rawIds);

    const succeeded: BatchRefundSucceededItem[] = [];
    const skipped: BatchRefundSkippedItem[] = [];
    const failed: BatchRefundFailedItem[] = [];

    for (const id of batch.ids) {
      const refund = batch.map.get(id)!;

      if (refund.status !== RefundStatus.APPLYING) {
        skipped.push({
          ...this.brief(refund),
          reason:
            `当前状态「${REFUND_STATUS_LABEL[refund.status] ?? refund.status}」，` +
            '不是待审批（可能已被处理，或列表数据已过期）',
        });
        continue;
      }

      try {
        const r = await this.refundService.rejectByAdmin(id, adminId, reason);
        succeeded.push({
          id,
          refundNo: r.refundNo,
          orderNo: r.orderNo,
          amountFen: toFen(Number(refund.amount)),
          wxRefundedFen: 0,
          balanceRefundedFen: 0,
          wxDelivered: false,
          retryQueued: false,
          /** 驳回把订单退回的节点（运营据此知道用户接下来处于哪一步） */
          orderStatus: r.orderStatus,
        });
      } catch (err) {
        this.pushError(skipped, failed, id, refund, err);
      }
    }

    return this.summarize('reject', batch, succeeded, skipped, failed, adminId);
  }

  // ==========================================================================
  // 内部：入参收口 + 预读
  // ==========================================================================

  /**
   * 归一化 + 上限 + 存在性预检
   *
   * ⚠️ **预检阶段「整批拒绝」的只有一种情况：id 不存在**。
   *    勾到不存在的 id 是操作失误（多半是页面过期后还拿着旧 id），
   *    继续处理剩下的会让运营以为「没报错的那几笔成了」—— 实际上他勾的那一笔根本没办。
   *    故 fail-fast：一个不存在的 id 就整批不动，运营重新勾一遍即可（资金零变动）。
   */
  private async prepare(rawIds: unknown): Promise<{
    ids: number[];
    map: Map<number, Refund>;
    input: BatchRefundResult['input'];
  }> {
    const { ids, invalidCount, dupCount } = normalizeBatchIds(rawIds);

    if (!ids.length) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `ids 中没有有效的退款单 id（收到 ${invalidCount} 个非法值），本次未做任何变更`,
      );
    }
    if (ids.length > REFUND_BATCH_MAX_IDS) {
      throw new BizException(
        ErrorCode.REFUND_BATCH_TOO_LARGE,
        `单次最多 ${REFUND_BATCH_MAX_IDS} 笔，本次 ${ids.length} 笔，请分批提交`,
      );
    }

    const rows = await this.refundRepo.find({ where: { id: In(ids) } });
    const map = new Map(rows.map((r) => [Number(r.id), r]));
    const missing = ids.filter((id) => !map.has(id));
    if (missing.length) {
      throw new BizException(
        ErrorCode.REFUND_NOT_FOUND,
        `退款单不存在：${missing.join('、')} —— 本次未执行任何操作，请刷新列表后重新勾选`,
      );
    }

    return {
      ids,
      map,
      input: { requested: ids.length, invalidCount, dupCount },
    };
  }

  /** 把单笔异常归进 skipped 或 failed（判据见 `refund-batch.ts`） */
  private pushError(
    skipped: BatchRefundSkippedItem[],
    failed: BatchRefundFailedItem[],
    id: number,
    refund: Refund,
    err: unknown,
  ): void {
    const verdict = classifyBatchError(err);
    if (verdict.kind === 'skipped') {
      skipped.push({
        ...this.brief(refund),
        reason: `执行前已被处理（${verdict.message}）`,
      });
      return;
    }
    failed.push({
      id,
      refundNo: refund.refundNo ?? null,
      orderNo: refund.orderNo ?? null,
      code: verdict.code,
      message: verdict.message,
    });
  }

  private brief(refund: Refund): BatchRefundSkippedItem {
    return {
      id: Number(refund.id),
      refundNo: refund.refundNo,
      orderNo: refund.orderNo,
      amountFen: toFen(Number(refund.amount)),
      reason: '',
    };
  }

  /** 汇总：一个批次只落**一条**日志（T1/T2 纪律：不按笔刷屏） */
  private summarize(
    action: 'approve' | 'reject',
    batch: { input: BatchRefundResult['input'] },
    succeeded: BatchRefundSucceededItem[],
    skipped: BatchRefundSkippedItem[],
    failed: BatchRefundFailedItem[],
    adminId: number,
  ): BatchRefundResult {
    const counts = {
      succeeded: succeeded.length,
      skipped: skipped.length,
      failed: failed.length,
    };
    const outcome = classifyBatchOutcome(counts);
    const retryQueuedCount = succeeded.filter((s) => s.retryQueued).length;

    this.logger.log(
      `E5 批量${action === 'approve' ? '退款审批通过' : '驳回'}：操作员#${adminId} ` +
        `请求 ${batch.input.requested} 笔 → 成功 ${counts.succeeded} · 跳过 ${counts.skipped} · 失败 ${counts.failed}` +
        (retryQueuedCount ? `（其中 ${retryQueuedCount} 笔微信通道已排队重试）` : ''),
    );

    return {
      action,
      input: batch.input,
      counts,
      outcome,
      succeeded,
      skipped,
      failed,
      amounts: {
        handledFen: succeeded.reduce((s, x) => s + x.amountFen, 0),
        wxRefundedFen: succeeded.reduce((s, x) => s + x.wxRefundedFen, 0),
        balanceRefundedFen: succeeded.reduce((s, x) => s + x.balanceRefundedFen, 0),
      },
      retryQueuedCount,
      /** 无论成败都给一句话结论：运营不该自己去数三个数组 */
      tips: batchTips(outcome, counts, { action, retryQueuedCount }),
    };
  }
}

// --------------------------------------------------------------------------
// 出参类型（端上照此渲染，不自己拼）
// --------------------------------------------------------------------------

export interface BatchRefundSucceededItem {
  id: number;
  refundNo: string;
  orderNo: string;
  amountFen: number;
  wxRefundedFen: number;
  balanceRefundedFen: number;
  /** 微信通道是否已受理（false = 已排队重试，见 `retryQueued`） */
  wxDelivered: boolean;
  retryQueued: boolean;
  /** 仅驳回：订单回退后的状态 */
  orderStatus?: string;
}

export interface BatchRefundSkippedItem {
  id: number;
  refundNo: string;
  orderNo: string;
  amountFen: number;
  /** 为什么跳过（人话，直接可展示） */
  reason: string;
}

export interface BatchRefundFailedItem {
  id: number;
  refundNo: string | null;
  orderNo: string | null;
  /** 业务码（null = 非业务异常，多半要找开发） */
  code: number | null;
  message: string;
}

export interface BatchRefundResult {
  action: 'approve' | 'reject';
  input: { requested: number; invalidCount: number; dupCount: number };
  counts: { succeeded: number; skipped: number; failed: number };
  /** `ok` 无失败 / `partial` 部分失败 / `failed` 全失败 / `noop` 一笔没动 */
  outcome: 'ok' | 'partial' | 'failed' | 'noop';
  succeeded: BatchRefundSucceededItem[];
  skipped: BatchRefundSkippedItem[];
  failed: BatchRefundFailedItem[];
  amounts: { handledFen: number; wxRefundedFen: number; balanceRefundedFen: number };
  retryQueuedCount: number;
  tips: string;
}
