/**
 * E5（台账原始口径）· 「按配送日 / 楼宇」批量退款的**判据纯函数**（2026-10-29）
 *
 * ## 与「显式 id 批量」的区别，以及为什么仍然安全
 * 上一版只收显式 id（运营逐个勾）。台账原始口径要的是**按条件**批量：
 * 「把这个配送日（这个楼）的待审批全退了」。这形状天然更危险 ——
 * 运营看不到自己到底选了谁。故本文件把安全护栏**写进判据**，而不是靠人小心：
 *
 *   ① **先预览、后执行**：执行必须带回预览时看到的「笔数 + 合计金额」，
 *      服务端重算比对，不一致即拒（40029）。运营看到的和执行的必须是同一批。
 *   ② **断点续退**：一次最多处理 `limit` 笔（缺省/上限 50），出参带 `remaining`。
 *      剩下的下次再点 —— 「没退完」是**显式状态**，不是一个跑 5 分钟的请求。
 *   ③ **只取 `applying`**：已处理过的单根本不会进命中集，
 *      所以「再点一次」天然只处理剩下的，不需要任何游标或断点记录表。
 *
 * ⚠️ 与 `ADR-N1N2W1` §D-N2-3 **不冲突**：那条禁的是「楼宇停用 / 停售**动作**自动触发
 *    批量退款」。这里是运营**主动发起**且必须先看预览，是两件事。
 *
 * ## 为什么「预览数字要回传」而不是服务端记住
 * 记住要存状态（内存会在多实例下失效、落库又是一张表）。让端上把看到的数字带回来，
 * 等价于给这批数据加一把**乐观锁**：期间若有人新提交了申请、或另一路处理掉了一笔，
 * 数字就对不上，本次拒绝 —— 运营重新预览即可。零存储，且失败得明明白白。
 */

import { ErrorCode } from '../constants/error-code';

/** 一次批量最多处理多少笔（断点续退的「批大小」） */
export const REFUND_SCOPE_LIMIT_DEFAULT = 50;
export const REFUND_SCOPE_LIMIT_MAX = 50;

/** 预览里最多回带多少条样例（明细可能上千行，别把返回体撑爆） */
export const REFUND_SCOPE_SAMPLE_MAX = 10;

export interface RefundBatchScope {
  /** 配送日（出餐日 YYYY-MM-DD） */
  mealDate: string;
  /** 楼宇 id；`null` = 该配送日**全部**楼宇 */
  buildingId: number | null;
}

export interface ScopeExpectation {
  /** 预览里展示的可退笔数 */
  count: number;
  /** 预览里展示的合计金额（分） */
  amountFen: number;
}

/**
 * 归一化 `limit`
 *
 * ⚠️ **不报错、只夹取**：limit 是「这批处理多少」的节奏参数，不是业务输入。
 *    传 0 / 负数 / 一万进来，按缺省或上限处理即可 —— 为这种事拒绝一次资金操作
 *    不划算，运营还得再填一遍条件。
 */
export function parseScopeLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return REFUND_SCOPE_LIMIT_DEFAULT;
  return Math.min(Math.floor(n), REFUND_SCOPE_LIMIT_MAX);
}

/** 条件的人话（进日志、进预览标题、进操作日志的 target） */
export function scopeLabel(scope: RefundBatchScope, buildingName?: string | null): string {
  const where = scope.buildingId ? (buildingName ?? `楼宇#${scope.buildingId}`) : '全部楼宇';
  return `${scope.mealDate} · ${where}`;
}

/** 条件的机器指纹（只进日志，用于「这两次是不是同一个条件」的排查） */
export function scopeFingerprint(scope: RefundBatchScope): string {
  return `${scope.mealDate}|${scope.buildingId ?? '*'}`;
}

/**
 * 预览数字与执行时重算的数字是否一致
 *
 * @param actual   执行前**当场**重算出的命中情况（全量，不是本批 limit 的条数）
 * @param expected 运营预览时看到的数字；`null` = 调用方没带（**不校验**）
 *
 * ⚠️ **笔数与金额都要比对**：只比笔数会漏掉「一笔被驳回 + 另一笔新提交」这种
 *    笔数相同、金额不同的情况 —— 那仍然是「运营看到的」和「实际要退的」不是同一批。
 */
export function checkScopeExpectation(
  actual: ScopeExpectation,
  expected: ScopeExpectation | null | undefined,
): { ok: boolean; code: number | null; message: string } {
  if (!expected) return { ok: true, code: null, message: '未附带预览数字，跳过比对' };

  if (expected.count !== actual.count) {
    return {
      ok: false,
      code: ErrorCode.REFUND_BATCH_SCOPE_CHANGED,
      message:
        `命中笔数已从 ${expected.count} 笔变成 ${actual.count} 笔` +
        '（期间有人新提交了申请，或另一路已处理掉一笔）—— 请重新预览后再执行',
    };
  }

  if (expected.amountFen !== actual.amountFen) {
    return {
      ok: false,
      code: ErrorCode.REFUND_BATCH_SCOPE_CHANGED,
      message:
        `合计金额已从 ¥${(expected.amountFen / 100).toFixed(2)} 变成 ` +
        `¥${(actual.amountFen / 100).toFixed(2)} —— 请重新预览后再执行`,
    };
  }

  return { ok: true, code: null, message: `命中 ${actual.count} 笔，与预览一致` };
}
