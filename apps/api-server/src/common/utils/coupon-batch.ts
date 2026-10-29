import { createHash, randomBytes } from 'crypto';

/**
 * 代金券批量发放的**纯判据**（2026-10-29）
 *
 * ## 为什么要从 service 里抽出来
 * 批量发券的三件事最容易出错，且**错了不会报异常、只会静默发错人**：
 *   ① 人群解析（谁该拿到券）；
 *   ② 幂等（同一个人会不会拿到两张）；
 *   ③ 回收资格（已核销的券能不能撤）。
 * 这三件都是「输入 → 结论」的纯计算，却原本要写在 service 里、靠连数据库的集成测试才碰得到。
 * 本项目**没有** coupon service 的单测（与 `order.service` 同族缺口），放进 service 等于
 * **没有任何东西拦得住它** —— 而批量的放大效应（一次几十张券）让它比单人发券更需要被拦。
 *
 * ⇒ 故判据一律抽成纯函数（与 `blind-box.ts` / `reconciliation-refund.ts` 同口径），
 *    由 `test/unit/coupon-batch.spec.ts` 看住；service 只负责取数与落库。
 *
 * ⚠️ 本文件**不 import 任何实体 / 数据源**：可测性是刻意换来的，不要往回加。
 */

/** 人群解析用的用户最小信息（service 查库后投喂进来） */
export interface TargetUserRow {
  id: number;
  phone?: string | null;
  /** `ab_user.status`：1=正常 2=黑名单 */
  status?: number | null;
}

export type CouponGrantScope = 'all' | 'building' | 'phones' | 'userIds';

/** 批量发券的人群参数（与 `GrantCouponBatchBodyDto` 同构，去掉券本身的参数） */
export interface ResolveInput {
  scope: CouponGrantScope;
  buildingId?: number | null;
  phones?: string[];
  userIds?: number[];
  excludeBlacklist?: boolean;
}

export interface ResolveResult {
  /** 参数本身不合法（人群必填项缺失 / 空清单）；非 null 时调用方应直接报 PARAM_INVALID */
  paramError: string | null;
  /** 去重后的目标用户 id（保持传入顺序，便于试算样例稳定） */
  userIds: number[];
  /** 被排除的人数（黑名单）；`excludeBlacklist=false` 时恒为 0 */
  excludedCount: number;
  /** `phones` 人群里查无此人的号码（去重、保序）—— **不静默丢弃** */
  unmatchedPhones: string[];
  /** `userIds` 人群里查无此人的 id（同上） */
  unmatchedUserIds: number[];
}

/**
 * 解析「这一批券要发给谁」
 *
 * @param candidates 调用方**按 scope 已经查好**的候选用户（未删除；`phones`/`userIds`
 *                   人群即「查到的那部分」，`all`/`building` 即「全部/整栋楼」）
 * @param input 人群参数
 *
 * ⚠️ 刻意**不在这里查库**：查库口径（要不要带 `deleted_at IS NULL`）属于 service 的职责，
 *    混进来就没法单测了。调用方必须保证 `candidates` 已按 scope 过滤。
 */
export function resolveTargets(candidates: TargetUserRow[], input: ResolveInput): ResolveResult {
  const excludeBlacklist = input.excludeBlacklist !== false; // 默认排除
  const empty: ResolveResult = {
    paramError: null,
    userIds: [],
    excludedCount: 0,
    unmatchedPhones: [],
    unmatchedUserIds: [],
  };

  // ---------------------------------------------------------------- 参数合法性
  if (input.scope === 'building' && input.buildingId == null) {
    return { ...empty, paramError: 'scope=building 必须给 buildingId' };
  }
  if (input.scope === 'phones' && (!input.phones || input.phones.length === 0)) {
    return { ...empty, paramError: 'scope=phones 必须给手机号清单' };
  }
  if (input.scope === 'userIds' && (!input.userIds || input.userIds.length === 0)) {
    return { ...empty, paramError: 'scope=userIds 必须给用户 id 清单' };
  }

  const isBlack = (u: TargetUserRow): boolean => u.status === 2;

  // ---------------------------------------------------------------- all / building
  if (input.scope === 'all' || input.scope === 'building') {
    const kept: number[] = [];
    let excluded = 0;
    for (const u of candidates) {
      if (excludeBlacklist && isBlack(u)) {
        excluded += 1;
        continue;
      }
      kept.push(u.id);
    }
    return { ...empty, userIds: dedupe(kept), excludedCount: excluded };
  }

  // ---------------------------------------------------------------- phones
  if (input.scope === 'phones') {
    const wanted = dedupe((input.phones ?? []).map((p) => String(p).trim()).filter(Boolean));
    // 一条号码可能命中多个用户（历史脏数据）时取第一个 —— 与「按手机号反查用户」同源口径
    const byPhone = new Map<string, TargetUserRow>();
    for (const u of candidates) {
      const p = (u.phone ?? '').trim();
      if (p && !byPhone.has(p)) byPhone.set(p, u);
    }
    const userIds: number[] = [];
    const unmatchedPhones: string[] = [];
    let excluded = 0;
    for (const p of wanted) {
      const hit = byPhone.get(p);
      if (!hit) {
        unmatchedPhones.push(p);
        continue;
      }
      if (excludeBlacklist && isBlack(hit)) {
        excluded += 1;
        continue;
      }
      userIds.push(hit.id);
    }
    return { ...empty, userIds: dedupe(userIds), excludedCount: excluded, unmatchedPhones };
  }

  // ---------------------------------------------------------------- userIds
  const wanted = dedupe((input.userIds ?? []).filter((n) => Number.isInteger(n) && n > 0));
  const byId = new Map<number, TargetUserRow>();
  for (const u of candidates) byId.set(u.id, u);
  const userIds: number[] = [];
  const unmatchedUserIds: number[] = [];
  let excluded = 0;
  for (const id of wanted) {
    const hit = byId.get(id);
    if (!hit) {
      unmatchedUserIds.push(id);
      continue;
    }
    if (excludeBlacklist && isBlack(hit)) {
      excluded += 1;
      continue;
    }
    userIds.push(id);
  }
  return { ...empty, userIds: dedupe(userIds), excludedCount: excluded, unmatchedUserIds };
}

/** 手机号脱敏：`138****1234`；无号码时给一个看得懂的占位（不回传空串让人以为漏了） */
export function maskPhone(phone?: string | null): string {
  const p = (phone ?? '').trim();
  if (p.length < 7) return '（未填手机号）';
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

/**
 * 这张券现在能不能回收
 *
 * ⭐ **只有 `unused` 可撤**：`used` 的券已经被订单用作抵扣，撤掉等于让那笔订单白拿优惠
 *    （订单金额不会回退，券却「复活」）—— 这是「回收」与「退券」的根本区别：
 *    退券（`releaseForOrder`）是**跟着订单走**的还原，回收是**运营主动作废**，
 *    后者绝不能动已经产生经济后果的券。
 */
export function canRevoke(status: string | null | undefined): boolean {
  return status === 'unused';
}

/**
 * 派生批次号
 *
 * - 传了幂等键 → 由键**确定性**派生（`sha1` 前 16 位）：同一个键永远得到同一个批次号，
 *   这是「重复提交跳过」能成立的前提；
 * - 没传 → 随机（每次都是新的一批，允许运营刻意发两批同样的券）。
 *
 * @param rand 随机源（**由调用方传入**以保持本函数纯净可测）；不传则内部取 6 字节随机
 */
export function deriveBatchNo(idempotencyKey?: string | null, rand?: string): string {
  const key = (idempotencyKey ?? '').trim();
  if (key) {
    return `B${createHash('sha1').update(key).digest('hex').slice(0, 16).toUpperCase()}`;
  }
  const r = rand && rand.length > 0 ? rand : randomBytes(6).toString('hex');
  return `B${r.toUpperCase()}`.slice(0, 32);
}

/** 保序去重 */
function dedupe<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
