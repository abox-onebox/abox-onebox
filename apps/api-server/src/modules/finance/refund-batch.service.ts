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
import {
  checkScopeExpectation,
  parseScopeLimit,
  REFUND_SCOPE_LIMIT_DEFAULT,
  REFUND_SCOPE_LIMIT_MAX,
  REFUND_SCOPE_SAMPLE_MAX,
  scopeLabel,
  type RefundBatchScope,
  type ScopeExpectation,
} from '../../common/utils/refund-batch-scope';
import { Building } from '../../database/entities/building.entity';
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
    // E5 台账口径：按条件批量要把「楼宇名」回给运营（「楼宇#3」不该出现在确认弹窗里）
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
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
  // E5 台账口径 · 按配送日 / 楼宇（预览 → 执行 两步式）
  // ==========================================================================

  /**
   * 预览：**只算不执行**，零资金动作
   *
   * 存在的意义是「让运营看见自己到底选了谁」—— 条件批量如果没有这一步，
   * 就是让人对着一个日期和一个楼名签一张空白支票。
   */
  async previewScope(scope: RefundBatchScope): Promise<ScopePreviewResult> {
    const rows = await this.loadScopeRows(scope);
    const buildingName = scope.buildingId ? await this.buildingName(scope.buildingId) : null;

    return {
      scope: { mealDate: scope.mealDate, buildingId: scope.buildingId ?? null },
      scopeLabel: scopeLabel(scope, buildingName),
      count: rows.length,
      amountFen: sumFen(rows),
      sample: rows.slice(0, REFUND_SCOPE_SAMPLE_MAX).map((r) => ({
        id: Number(r.id),
        refundNo: r.refundNo,
        orderNo: r.orderNo,
        amountFen: toFen(Number(r.amount)),
      })),
      sampleTruncated: rows.length > REFUND_SCOPE_SAMPLE_MAX,
      limit: REFUND_SCOPE_LIMIT_DEFAULT,
      limitMax: REFUND_SCOPE_LIMIT_MAX,
      warnings: scopeWarnings(rows.length, REFUND_SCOPE_LIMIT_DEFAULT),
    };
  }

  /**
   * 按条件批量通过（**断点续退**：一次最多 `limit` 笔，出参带 `remaining`）
   *
   * ## 为什么必须先比对预览数字
   * 预览到执行之间可能有人新提交了申请，或另一路处理掉一笔 —— 那时「运营看到的」
   * 和「实际要退的」就不是同一批了。数字对不上即拒（40029），运营重新预览即可。
   *
   * ## 为什么「再点一次」不会重复退
   * 已处理的单不再处于 `applying`，下次命中集里**根本没有它们**
   * ⇒ 不需要游标、不需要断点记录表，剩下的接着退就行。
   */
  async approveByScope(
    scope: RefundBatchScope,
    expected: ScopeExpectation,
    adminId: number,
    remark: string | undefined,
    limitRaw: unknown,
  ): Promise<BatchScopeResult> {
    const limit = parseScopeLimit(limitRaw);
    const rows = await this.verifyScope(scope, expected);
    const ids = rows.slice(0, limit).map((r) => Number(r.id));

    const result = await this.batchApprove(ids, adminId, remark);
    return this.withScope(result, scope, rows.length);
  }

  /** 按条件批量驳回（同上，断点续退） */
  async rejectByScope(
    scope: RefundBatchScope,
    expected: ScopeExpectation,
    adminId: number,
    reason: string,
    limitRaw: unknown,
  ): Promise<BatchScopeResult> {
    const limit = parseScopeLimit(limitRaw);
    const rows = await this.verifyScope(scope, expected);
    const ids = rows.slice(0, limit).map((r) => Number(r.id));

    const result = await this.batchReject(ids, adminId, reason);
    return this.withScope(result, scope, rows.length);
  }

  // ==========================================================================
  // 内部：入参收口 + 预读
  // ==========================================================================

  /**
   * 取条件命中的**全部**待审批退款单（只取统计与样例所需列）
   *
   * ⚠️ 只取 `applying` —— 这是断点续退能成立的唯一前提：处理过的单不再命中。
   * ⚠️ 走 `ab_order` 的子查询而不是 JOIN：分页/统计的 count 与明细要分开算，
   *    JOIN 会把两边的行数互相放大（与 `list()` 同一处教训）。
   * ⚠️ 索引：带楼宇时命中 `idx_order_building_meal (building_id, meal_date)`；
   *    不带楼宇时只按 `meal_date`（一期数据量下全表扫可接受，量上来再补索引）。
   */
  private async loadScopeRows(scope: RefundBatchScope): Promise<Refund[]> {
    const qb = this.refundRepo
      .createQueryBuilder('r')
      .select(['r.id', 'r.refundNo', 'r.orderNo', 'r.amount'])
      .where('r.status = :st', { st: RefundStatus.APPLYING });

    if (scope.buildingId) {
      qb.andWhere(
        'r.order_id IN (SELECT o.id FROM ab_order o WHERE o.meal_date = :mealDate AND o.building_id = :bid)',
        { mealDate: scope.mealDate, bid: scope.buildingId },
      );
    } else {
      qb.andWhere('r.order_id IN (SELECT o.id FROM ab_order o WHERE o.meal_date = :mealDate)', {
        mealDate: scope.mealDate,
      });
    }

    return qb.orderBy('r.id', 'ASC').getMany();
  }

  /** 执行前复核：条件仍成立 + 命中集合与预览一致 */
  private async verifyScope(
    scope: RefundBatchScope,
    expected: ScopeExpectation,
  ): Promise<Refund[]> {
    await this.buildingName(scope.buildingId); // 楼宇不存在即拒（条件写错不能在钱上试出来）
    const rows = await this.loadScopeRows(scope);

    const check = checkScopeExpectation({ count: rows.length, amountFen: sumFen(rows) }, expected);
    if (!check.ok) {
      throw new BizException(ErrorCode.REFUND_BATCH_SCOPE_CHANGED, check.message);
    }
    if (!rows.length) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        '该条件下已没有待审批的退款申请（可能刚被处理完），无需执行',
      );
    }
    return rows;
  }

  /** 楼宇名（顺带校验楼宇存在）；`null` = 未限定楼宇 */
  private async buildingName(buildingId?: number | null): Promise<string | null> {
    if (!buildingId) return null;
    const b = await this.buildingRepo.findOne({ where: { id: Number(buildingId) } });
    if (!b) {
      throw new BizException(ErrorCode.BUILDING_NOT_FOUND, `楼宇 #${buildingId} 不存在`);
    }
    return b.name ?? null;
  }

  /** 给批量结果补上「范围 + 还剩多少」 */
  private async withScope(
    result: BatchRefundResult,
    scope: RefundBatchScope,
    hitCount: number,
  ): Promise<BatchScopeResult> {
    const handled = result.counts.succeeded + result.counts.skipped + result.counts.failed;
    const remaining = Math.max(0, hitCount - handled);

    return {
      ...result,
      scope: { mealDate: scope.mealDate, buildingId: scope.buildingId ?? null },
      scopeLabel: scopeLabel(scope, await this.buildingName(scope.buildingId)),
      remaining,
      nextTip:
        remaining > 0
          ? `还剩 ${remaining} 笔未处理 —— 再点一次即可继续（已处理的不会重复退）`
          : null,
    };
  }

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

/** 条件批量 · 预览结果（**只算不执行**） */
export interface ScopePreviewResult {
  scope: { mealDate: string; buildingId: number | null };
  /** 条件的人话（含楼宇名） */
  scopeLabel: string;
  /** 命中的**待审批**笔数 */
  count: number;
  amountFen: number;
  /** 前若干条样例（明细可能上千行，只给看得完的） */
  sample: { id: number; refundNo: string; orderNo: string; amountFen: number }[];
  sampleTruncated: boolean;
  limit: number;
  limitMax: number;
  /** 确认弹窗里要印出来的话（由服务端给，端上不自己编） */
  warnings: string[];
}

/** 条件批量 · 执行结果（在三类结果之上补「范围 + 还剩多少」） */
export interface BatchScopeResult extends BatchRefundResult {
  scope: { mealDate: string; buildingId: number | null };
  scopeLabel: string;
  /** 该条件下**还没处理**的笔数（>0 即断点续退的下一批） */
  remaining: number;
  /** 还有剩余时的下一步提示；`null` = 已处理完 */
  nextTip: string | null;
}

/** 命中金额合计（分） */
function sumFen(rows: Refund[]): number {
  return rows.reduce((s, r) => s + toFen(Number(r.amount)), 0);
}

/** 预览弹窗里的警示语（命中为空 / 超过批大小 / 不可逆 —— 三种都要说） */
function scopeWarnings(count: number, limit: number): string[] {
  const out: string[] = ['本操作会**逐笔真的把钱退出去**，不可撤销；执行前请核对下方的笔数与金额'];
  if (count === 0) out.push('该条件下当前**没有**待审批的退款申请，无需执行');
  if (count > limit) {
    out.push(
      `命中 ${count} 笔，一次最多处理 ${limit} 笔 —— ` +
        '执行后按返回的「剩余笔数」继续，已处理的不会重复退',
    );
  }
  return out;
}
