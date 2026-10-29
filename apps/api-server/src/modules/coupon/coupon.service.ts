import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { randomBytes } from 'crypto';

import { CouponDef, UserCoupon } from '../../database/entities/coupon.entity';
import { User } from '../../database/entities/user.entity';
import {
  AvailableCouponResult,
  CouponDefResult,
  CouponGrantBatchResult,
  CouponGrantScope,
  CouponObtainedFrom,
  CouponValidityType,
  MyCouponResult,
  UserCouponResult,
} from '@abox/shared-types';
import { toFen, money } from '../../common/utils/money';
import { bjDateTime, now, toBjIso } from '../../common/utils/time';
import {
  canRevoke,
  deriveBatchNo,
  maskPhone,
  resolveTargets,
  type TargetUserRow,
} from '../../common/utils/coupon-batch';
import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';

/** 发放入参（内部，兼容「按券种定义发放」与「纯手动补偿券」两种路径） */
export interface GrantInput {
  userId: number;
  /** 关联券种定义 id（用于回写 issuedCount / 限量校验）；纯补偿券可空 */
  couponDefId?: number | null;
  name?: string;
  /** 面额（分，必填） */
  faceValueFen: number;
  /** 使用门槛（分）；缺省 0 */
  thresholdFen?: number;
  validityType: CouponValidityType;
  validDays?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  obtainedFrom?: CouponObtainedFrom;
  remark?: string | null;
}

/**
 * 单批发放硬上限
 *
 * ⚠️ 这不是技术上限（几千条 INSERT 在一个事务里也没问题），是**误操作上限** ——
 *    一次动作影响上千人时，「试算」这一步的确认意义会被稀释：运营看着 1200 这个数字
 *    和看着 73 这个数字，按下去的心理负担完全不同。真要全员发且人数超了，就分批。
 */
const MAX_BATCH_GRANT = 2000;

/** 批量发放入参（内部；人群参数 + 与单人发放同构的券参数） */
export interface GrantBatchInput {
  scope: CouponGrantScope;
  buildingId?: number | null;
  phones?: string[];
  userIds?: number[];
  couponDefId?: number | null;
  name?: string;
  faceValueFen: number;
  thresholdFen?: number;
  validityType: CouponValidityType;
  validDays?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  obtainedFrom?: CouponObtainedFrom;
  remark?: string | null;
  /** `true` = 只试算不写库 */
  dryRun?: boolean;
  /** 幂等键；同键 = 同批，已发过的用户自动跳过 */
  idempotencyKey?: string | null;
  /** 是否排除黑名单用户（默认 `true`） */
  excludeBlacklist?: boolean;
}

/**
 * 代金券核心服务（独立券系统 · 2026-10-23）
 *
 * 职责：发放（grant）/ 我的券列表 / 订单可用券列表 / 下单核销（reserveForOrder）。
 * 券的「定义」与「持有」分离：`CouponDef` 只描述一种券的通用规则，`UserCoupon` 是发给
 * 具体用户的那一张（带唯一券码、独立有效期、核销状态）。
 *
 * ⚠️ 逻辑过期：数据库 `status` 只存 `unused/used`，「已过期」由查询期按 `valid_to` 判定，
 *    不依赖定时任务回填 —— 避免「过期券仍可被筛选」的竞态。
 */
@Injectable()
export class CouponService {
  private readonly logger = new Logger('Coupon');

  constructor(private readonly dataSource: DataSource) {}

  /** 生成唯一券码（AB + 时间 base36 + 随机），碰撞由调用方重试兜底 */
  private genCode(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rnd = randomBytes(4).toString('hex').toUpperCase();
    return `AB${ts}${rnd}`;
  }

  /** 当前是否在有效期窗口内（含边界） */
  private inWindow(uc: UserCoupon, now: Date): boolean {
    return now.getTime() >= uc.validFrom.getTime() && now.getTime() <= uc.validTo.getTime();
  }

  /**
   * 计算某券作用于订单的实际抵扣额（分）
   *   · 门槛不满足 → 0
   *   · 满足 → min(面额, 订单额)（面额不应超过订单额；双保险）
   */
  private discountOf(faceValueFen: number, thresholdFen: number, totalFen: number): number {
    if (thresholdFen > totalFen) return 0;
    return Math.min(faceValueFen, totalFen);
  }

  /** 把实体映射为下发出参（金额 → 分；时间 → ISO +08:00） */
  private toResult(uc: UserCoupon): UserCouponResult {
    const validFrom = uc.validFrom instanceof Date ? uc.validFrom : new Date(uc.validFrom);
    const validTo = uc.validTo instanceof Date ? uc.validTo : new Date(uc.validTo);
    const usedAt = uc.usedAt instanceof Date ? uc.usedAt : uc.usedAt ? new Date(uc.usedAt) : null;
    const revokedAt =
      uc.revokedAt instanceof Date ? uc.revokedAt : uc.revokedAt ? new Date(uc.revokedAt) : null;
    return {
      id: uc.id,
      code: uc.code,
      name: uc.name,
      faceValueFen: toFen(Number(uc.faceValue)),
      thresholdFen: toFen(Number(uc.threshold)),
      // ⚠️ 一律走 `toBjIso`（真做 +8 换算）—— 曾写成 `toISOString().replace('Z','+08:00')`，
      //    那只是把 **UTC** 时间贴了个 +08:00 的标签，券的有效期会整体差 8 小时。
      validFrom: toBjIso(validFrom) ?? '',
      validTo: toBjIso(validTo) ?? '',
      status: uc.status as UserCouponResult['status'],
      obtainedFrom: uc.obtainedFrom as UserCouponResult['obtainedFrom'],
      usedAt: toBjIso(usedAt),
      orderNo: uc.orderNo ?? null,
      grantBatchNo: uc.grantBatchNo ?? null,
      revokedAt: toBjIso(revokedAt),
      createdAt:
        toBjIso(uc.createdAt instanceof Date ? uc.createdAt : new Date(uc.createdAt)) ?? '',
    };
  }

  // ---------------------------------------------------------- 内部复用件（单人 / 批量同源）

  /**
   * 解析有效期（与 `now()` 同源）
   *
   * ⚠️ 单人发放与批量发放**必须共用这一份**：两套解析迟早会在「period 型边界」
   *    或「时区换算」上漂移，而漂移的表现是「同一张券在两种发法下差 8 小时」。
   */
  private resolveValidity(
    input: Pick<GrantInput, 'validityType' | 'validDays' | 'validFrom' | 'validTo' | 'name'>,
    at: Date,
  ): { validFrom: Date; validTo: Date } {
    if (input.validityType === 'days') {
      const days = input.validDays ?? 0;
      return { validFrom: at, validTo: new Date(at.getTime() + days * 86_400_000) };
    }
    if (!input.validFrom || !input.validTo) {
      throw new BizException(
        ErrorCode.COUPON_GRANT_PARAM_INVALID,
        `period 型券必须给定 validFrom / validTo（券名=${input.name ?? '未命名'}）`,
      );
    }
    // ⚠️ 一律走 `bjDateTime`（唯一时区换算实现），不要手拼 `T00:00:00+08:00`
    //    —— 那种写法依赖宿主对带偏移字符串的解析，且与全工程的时间口径不同源。
    //    `hour = 24` 会被进位成「次日 0 点」，正好是「失效日当天含尾」的精确上界。
    return {
      validFrom: bjDateTime(input.validFrom, 0),
      validTo: bjDateTime(input.validTo, 24),
    };
  }

  /**
   * 关联券种定义：校验 存在 / 启用 / 未超发行上限
   *
   * @param willIssue 本次要发的张数（批量时 >1）
   *
   * ⚠️ 限量校验**按本次张数整体判**，不是逐张判：逐张判会出现「发了 40 张才发现
   *    超上限」的半截状态（券已发出、限量却拦下了后半截）。宁可**整体拒绝**。
   */
  private async loadCouponDef(
    couponDefId: number | null | undefined,
    willIssue = 1,
  ): Promise<CouponDef | null> {
    if (!couponDefId) return null;
    const def = await this.dataSource
      .getRepository(CouponDef)
      .findOne({ where: { id: couponDefId } });
    if (!def) {
      throw new BizException(ErrorCode.COUPON_DEF_INVALID, `券种定义不存在（id=${couponDefId}）`);
    }
    if (def.status !== 'active') {
      throw new BizException(ErrorCode.COUPON_DEF_INVALID, '券种定义已停用，不能发放');
    }
    if (def.totalLimit != null && def.issuedCount + willIssue > def.totalLimit) {
      throw new BizException(
        ErrorCode.COUPON_DEF_INVALID,
        `券种发行上限不足（已发 ${def.issuedCount} + 本次 ${willIssue} > 上限 ${def.totalLimit}）`,
      );
    }
    return def;
  }

  /**
   * 事务内写一张券
   *
   * @returns 写入的券；`null` = **因幂等锚命中而跳过**（并发重复提交同批次同用户）
   */
  private async insertCoupon(
    m: EntityManager,
    p: {
      userId: number;
      couponDefId: number | null;
      name: string;
      faceValueFen: number;
      thresholdFen: number;
      validFrom: Date;
      validTo: Date;
      obtainedFrom: CouponObtainedFrom;
      remark: string | null;
      grantBatchNo: string | null;
    },
  ): Promise<UserCoupon | null> {
    const repo = m.getRepository(UserCoupon);
    // 券码碰撞重试，最多 6 次
    for (let i = 0; i < 6; i++) {
      const entity = repo.create({
        userId: p.userId,
        code: this.genCode(),
        couponDefId: p.couponDefId,
        grantBatchNo: p.grantBatchNo,
        name: p.name,
        faceValue: money(p.faceValueFen / 100),
        threshold: money(p.thresholdFen / 100),
        validFrom: p.validFrom,
        validTo: p.validTo,
        status: 'unused',
        obtainedFrom: p.obtainedFrom,
        remark: p.remark,
      });
      try {
        return await repo.save(entity);
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? '';
        if (/Duplicate entry[^\n]*uk_user_coupon_code/.test(msg) && i < 5) {
          continue; // 券码碰撞，重试
        }
        // ⭐ 幂等锚命中：同一批次同一用户已发过（并发下的第二个请求）—— 跳过而非报错
        if (/Duplicate entry[^\n]*uk_user_coupon_batch_user/.test(msg)) {
          return null;
        }
        throw e;
      }
    }
    throw new BizException(ErrorCode.INTERNAL_ERROR, '代金券发放失败（券码连续冲突），请重试');
  }

  /**
   * 发放一张券（核心入口）
   *
   * 流程：解析有效期 →（若关联券种定义）校验 active + 限量 → 写 `ab_user_coupon`
   * （事务内，券码碰撞重试）→（若关联定义）回写 `issued_count`。
   */
  async grant(input: GrantInput): Promise<UserCouponResult> {
    // ⚠️ 「相对现在」一律走 `now()`（服务端唯一时间源）—— 注入态下不会跑出两套时间
    const at = now();
    const thresholdFen = input.thresholdFen ?? 0;
    const obtainedFrom = input.obtainedFrom ?? 'manual';
    const faceValueFen = input.faceValueFen;

    const { validFrom, validTo } = this.resolveValidity(input, at);
    const couponDef = await this.loadCouponDef(input.couponDefId ?? null);
    const name = input.name ?? couponDef?.name ?? '代金券';

    // ⚠️ 插券与回写 `issued_count` 必须在**同一事务**：否则会出现
    //    「券发出去了、发行数没加」（限量随之失效）这种静默不一致。
    const saved = await this.dataSource.transaction(async (m) => {
      const uc = await this.insertCoupon(m, {
        userId: input.userId,
        couponDefId: input.couponDefId ?? null,
        name,
        faceValueFen,
        thresholdFen,
        validFrom,
        validTo,
        obtainedFrom,
        remark: input.remark ?? null,
        // 单人发券不入批次（唯一索引对 NULL 不生效，故同一个人可反复收到单人券）
        grantBatchNo: null,
      });
      if (!uc) {
        throw new BizException(ErrorCode.INTERNAL_ERROR, '代金券发放失败（批次冲突），请重试');
      }
      if (couponDef) {
        await m.getRepository(CouponDef).increment({ id: couponDef.id }, 'issuedCount', 1);
      }
      return uc;
    });

    this.logger.log(
      `发放代金券 code=${saved.code} user=${input.userId} 面额=${faceValueFen}分 来源=${obtainedFrom}`,
    );
    return this.toResult(saved);
  }

  /**
   * 批量发放（2026-10-29）
   *
   * ## 试算与实发走**同一条代码路径**
   * `dryRun: true` 时只差最后「写库」那一步 —— 人群解析、幂等跳过、限量校验
   * **全部照跑**。刻意不用「端上自己估算人数」：那会造出第二套人群算法，
   * 表现为「试算说 73 人、实发 80 人」，而运营已经按下确认了。
   *
   * ## 幂等
   * 批次号由 `idempotencyKey` 派生（纯函数 `deriveBatchNo`）。实发前先查
   * 「这一批已发过谁」并跳过 —— 双击提交 / 两个运营同时点，都不会发出第二张。
   * 真正的最后一道闸是数据库唯一索引 `uk_user_coupon_batch_user`。
   *
   * ## 失败语义
   * 人群参数不合法 / 券种限量不足 → **整批拒绝**（`BizException`），不发半截。
   * 批量一旦部分成功，运营无法判断「谁拿到了」，比整批失败更难收场。
   */
  async grantBatch(input: GrantBatchInput): Promise<CouponGrantBatchResult> {
    const at = now();
    const dryRun = input.dryRun === true;
    const obtainedFrom = input.obtainedFrom ?? 'manual';
    const thresholdFen = input.thresholdFen ?? 0;
    const faceValueFen = input.faceValueFen;

    // 券参数解析（与单人发放同源）
    const { validFrom, validTo } = this.resolveValidity(input, at);

    // ---------------------------------------------------------------- 人群
    const userRepo = this.dataSource.getRepository(User);
    const select = ['id', 'phone', 'status'] as const;
    let candidates: TargetUserRow[] = [];

    if (input.scope === 'all' || input.scope === 'building') {
      const where: Record<string, unknown> = { deletedAt: IsNull() };
      if (input.scope === 'building') where.buildingId = input.buildingId;
      candidates = await userRepo.find({
        where,
        select: [...select],
      });
    } else if (input.scope === 'phones') {
      const phones = [
        ...new Set((input.phones ?? []).map((p) => String(p).trim()).filter(Boolean)),
      ];
      candidates = phones.length
        ? await userRepo.find({
            where: { phone: In(phones), deletedAt: IsNull() },
            select: [...select],
          })
        : [];
    } else {
      const ids = [...new Set((input.userIds ?? []).filter((n) => Number.isInteger(n) && n > 0))];
      candidates = ids.length
        ? await userRepo.find({ where: { id: In(ids), deletedAt: IsNull() }, select: [...select] })
        : [];
    }

    const resolved = resolveTargets(candidates, {
      scope: input.scope,
      buildingId: input.buildingId ?? null,
      phones: input.phones,
      userIds: input.userIds,
      excludeBlacklist: input.excludeBlacklist,
    });
    if (resolved.paramError) {
      throw new BizException(ErrorCode.PARAM_INVALID, resolved.paramError);
    }

    // ---------------------------------------------------------------- 幂等：本批次已发过谁
    const batchNo = deriveBatchNo(input.idempotencyKey ?? null, randomBytes(6).toString('hex'));
    const already = await this.dataSource.getRepository(UserCoupon).find({
      where: { grantBatchNo: batchNo },
      select: ['userId'],
    });
    const alreadySet = new Set(already.map((a) => a.userId));
    const targets = resolved.userIds.filter((id) => !alreadySet.has(id));
    const skippedCount = resolved.userIds.length - targets.length;

    if (targets.length > MAX_BATCH_GRANT) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `单批发放上限 ${MAX_BATCH_GRANT} 张，本次命中 ${targets.length} 张（请缩小人群或分批）`,
      );
    }

    // 券种限量：**按本次张数整体判**（不足即整批拒绝，见 `loadCouponDef` 头注）
    const couponDef = await this.loadCouponDef(input.couponDefId ?? null, targets.length);
    const name = input.name ?? couponDef?.name ?? '代金券';

    // 样例（脱敏手机号）—— 供运营肉眼核对「人群有没有选错」
    const phoneById = new Map<number, string | null>();
    for (const u of candidates) phoneById.set(u.id, u.phone ?? null);
    const samplePhones = targets.slice(0, 5).map((id) => maskPhone(phoneById.get(id) ?? null));

    if (dryRun) {
      return {
        dryRun: true,
        batchNo,
        grantedCount: targets.length,
        skippedCount,
        totalFaceValueFen: targets.length * faceValueFen,
        excludedCount: resolved.excludedCount,
        unmatchedPhones: resolved.unmatchedPhones,
        samplePhones,
        codes: [],
      };
    }

    // ---------------------------------------------------------------- 实发（单事务）
    const codes: string[] = [];
    let granted = 0;
    await this.dataSource.transaction(async (m) => {
      for (const userId of targets) {
        const uc = await this.insertCoupon(m, {
          userId,
          couponDefId: input.couponDefId ?? null,
          name,
          faceValueFen,
          thresholdFen,
          validFrom,
          validTo,
          obtainedFrom,
          remark: input.remark ?? null,
          grantBatchNo: batchNo,
        });
        if (!uc) continue; // 并发下已被同一批次插入 → 幂等跳过（并发表单重复提交）
        granted += 1;
        if (codes.length < 20) codes.push(uc.code);
      }
      if (couponDef && granted > 0) {
        await m.getRepository(CouponDef).increment({ id: couponDef.id }, 'issuedCount', granted);
      }
    });

    this.logger.log(
      `批量发放代金券 batch=${batchNo} 人群=${input.scope} 张数=${granted} ` +
        `跳过=${skippedCount} 排除=${resolved.excludedCount} 面额=${faceValueFen}分`,
    );

    return {
      dryRun: false,
      batchNo,
      grantedCount: granted,
      skippedCount: skippedCount + (targets.length - granted),
      totalFaceValueFen: granted * faceValueFen,
      excludedCount: resolved.excludedCount,
      unmatchedPhones: resolved.unmatchedPhones,
      samplePhones,
      codes,
    };
  }

  /**
   * 回收一张券（2026-10-29 · 批量发券的兜底）
   *
   * ⭐ **只有 `unused`（未使用）可撤**：已核销的券已经被订单用作抵扣，撤掉等于让那笔订单
   *    白拿优惠（订单金额不会回退，券却「复活」）。这与「退券」是两件事 ——
   *    退券（`releaseForOrder`）是**跟着订单走**的还原，回收是**运营主动作废**，
   *    后者绝不能动已经产生经济后果的券。
   *
   * 幂等：已是 `revoked` 时直接返回当前状态（重复点击无害），与 `releaseForOrder` 同口径。
   *
   * ⚠️ 回收原因**不进业务表**：由 `@OperationLog` 的 `request_data` 落操作日志。
   */
  async revokeCoupon(id: number, adminId: number): Promise<UserCouponResult> {
    const repo = this.dataSource.getRepository(UserCoupon);
    const uc = await repo.findOne({ where: { id } });
    if (!uc) {
      throw new BizException(ErrorCode.COUPON_NOT_REVOCABLE, `代金券不存在（id=${id}）`);
    }
    if (uc.status === 'revoked') {
      return this.toResult(uc); // 幂等：已回收
    }
    if (!canRevoke(uc.status)) {
      throw new BizException(
        ErrorCode.COUPON_NOT_REVOCABLE,
        `只有未使用的券可以回收（当前状态=${uc.status}；已核销的券随订单产生了抵扣，不能作废）`,
      );
    }
    uc.status = 'revoked';
    uc.revokedAt = now();
    uc.revokedBy = adminId;
    const saved = await repo.save(uc);
    this.logger.log(`回收代金券 id=${id} code=${saved.code} 操作人=${adminId}`);
    return this.toResult(saved);
  }

  /** 我的券（全部，带可用性判据） */
  async listMy(userId: number): Promise<MyCouponResult[]> {
    // ⚠️ 一律走 `now()`（服务端唯一时间源）—— 与 `grant` / `reserveForOrder` 同源，
    //    避免「建券用 now()、查券用 new Date()」在注入时钟下错位（券刚发出却判「未到生效日」）。
    const cur = now();
    const rows = await this.dataSource.getRepository(UserCoupon).find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((uc) => {
      const base = this.toResult(uc);
      const inWindow = this.inWindow(uc, cur);
      const available = uc.status === 'unused' && inWindow;
      let unavailableReason: string | undefined;
      // ⚠️ `revoked` 必须**显式**给出原因：它天然不满足 `unused` 故不会判为可用，
      //    但若漏掉这一支，用户端会把它显示成「已过期」—— 那是**假的**（券没到期，是被撤的）。
      if (uc.status === 'revoked') unavailableReason = '已回收';
      else if (uc.status === 'used') unavailableReason = '已使用';
      else if (!inWindow) unavailableReason = cur < uc.validFrom ? '未到生效日' : '已过期';
      return { ...base, available, unavailableReason };
    });
  }

  /** 订单可用券（未使用 + 在有效期 + 门槛满足；含实际抵扣额） */
  async listAvailableForOrder(userId: number, totalFen: number): Promise<AvailableCouponResult[]> {
    // ⚠️ 同上：与 `grant` / `reserveForOrder` 同源用 `now()`，避免注入时钟下错位。
    const cur = now();
    const rows = await this.dataSource.getRepository(UserCoupon).find({
      where: { userId, status: 'unused' },
      order: { validTo: 'ASC' },
    });
    return rows
      .filter((uc) => this.inWindow(uc, cur))
      .map((uc) => {
        const base = this.toResult(uc);
        const faceValueFen = toFen(Number(uc.faceValue));
        const thresholdFen = toFen(Number(uc.threshold));
        const applicable = this.discountOf(faceValueFen, thresholdFen, totalFen) > 0;
        const discountFen = this.discountOf(faceValueFen, thresholdFen, totalFen);
        return { ...base, applicable, discountFen };
      });
  }

  /**
   * 下单核销（在订单事务内调用）：校验 + 标记已用，返回抵扣额（分）
   *
   * ⚠️ 调用方须已持有 `EntityManager`（同一事务）—— 券的「标记已用」与订单建表原子提交，
   *    避免「订单成了券却没扣」或反之。
   */
  async reserveForOrder(
    m: EntityManager,
    userId: number,
    code: string,
    orderNo: string,
    totalFen: number,
    now: Date,
  ): Promise<number> {
    const repo = m.getRepository(UserCoupon);
    const uc = await repo.findOne({ where: { code } });
    if (!uc) throw new BizException(ErrorCode.COUPON_NOT_USABLE, '券码不存在');
    if (uc.userId !== userId)
      throw new BizException(ErrorCode.COUPON_NOT_USABLE, '该券不属于当前用户');
    // ⚠️ `revoked` 必须单独给文案：这张券**从没被用过**，报「已使用过」是**假的** ——
    //    用户会以为是自己用掉了（去查订单），而真相是被运营撤回（该去问客服）。
    //    两个方向的排查入口完全不同，合流一句文案等于给错方向。
    if (uc.status === 'revoked')
      throw new BizException(ErrorCode.COUPON_NOT_USABLE, '该券已被回收');
    if (uc.status !== 'unused') throw new BizException(ErrorCode.COUPON_NOT_USABLE, '该券已使用过');
    if (!this.inWindow(uc, now)) {
      throw new BizException(
        ErrorCode.COUPON_NOT_USABLE,
        now.getTime() < uc.validFrom.getTime() ? '该券还未到生效日' : '该券已过期',
      );
    }
    const faceValueFen = toFen(Number(uc.faceValue));
    const thresholdFen = toFen(Number(uc.threshold));
    const discountFen = this.discountOf(faceValueFen, thresholdFen, totalFen);
    if (discountFen <= 0) {
      throw new BizException(
        ErrorCode.COUPON_THRESHOLD_NOT_MET,
        `该券需订单满 ${money(thresholdFen / 100)} 元可用，当前 ${money(totalFen / 100)} 元`,
        undefined,
        { thresholdFen, totalFen },
      );
    }

    await repo.update({ id: uc.id }, { status: 'used', usedAt: now, orderNo });
    this.logger.log(`核销代金券 code=${code} order=${orderNo} 抵扣=${discountFen}分`);
    return discountFen;
  }

  /**
   * 退券（订单取消 / 退款时）：把已核销的券**还原为未使用**
   *
   * ⚠️ 为什么必须有这条路径：券在**下单瞬间**就标记 `used`（与建单同事务，
   *    防「订单成了券没扣」）。若取消时只退余额不退券，用户就**白丢一张券** ——
   *    表现为「我取消了一单，优惠券没了」，且系统里查不到任何异常。
   *
   * 判据：`orderNo` 匹配 **且** 当前是 `used`。两条都不满足时不报错、直接返回 false：
   *    · 本单没用券（正常，绝大多数单如此）
   *    · 券已被别的路径退回（幂等，重复调用无害）
   *
   * ⚠️ 刻意**不做**「过期券不退回」的优化：券是**核销时**判有效期的（那时一定没过期），
   *    取消发生在其后。若因「现在过期了」而不退，等于让用户承担系统时序造成的过期。
   */
  async releaseForOrder(m: EntityManager, orderNo: string): Promise<boolean> {
    const repo = m.getRepository(UserCoupon);
    const res = await repo.update(
      { orderNo, status: 'used' },
      { status: 'unused', usedAt: null, orderNo: null },
    );
    const n = res.affected ?? 0;
    if (n > 0) this.logger.log(`退券 order=${orderNo} 张数=${n}`);
    return n > 0;
  }

  /**
   * 实体 → 券种出参（金额转**分**，时间转 ISO +08:00）
   *
   * ⚠️ 为什么要这层转换而不是直接把实体 JSON 出去：
   *    实体里金额是 DECIMAL 字符串（MySQL driver 会给出 `'5.00'` 甚至 number），
   *    直接下发等于让端上自己 `Number(x)*100` —— 那是第二份金额口径，
   *    迟早出现「后台显示 ¥5.00、下单抵扣 500 分」之外的错法。全工程统一为**整数分**。
   */
  private toDefResult(def: CouponDef): CouponDefResult {
    const fmt = (d: Date | string | null | undefined) =>
      d ? (toBjIso(d instanceof Date ? d : new Date(d)) ?? '') : '';
    return {
      id: def.id,
      name: def.name,
      faceValueFen: toFen(Number(def.faceValue)),
      thresholdFen: toFen(Number(def.threshold)),
      validityType: def.validityType as CouponDefResult['validityType'],
      validDays: def.validDays ?? null,
      validFrom: def.validFrom ?? null,
      validTo: def.validTo ?? null,
      totalLimit: def.totalLimit ?? null,
      issuedCount: def.issuedCount ?? 0,
      status: def.status as CouponDefResult['status'],
      remark: def.remark ?? null,
      createdAt: fmt(def.createdAt),
      updatedAt: fmt(def.updatedAt),
    };
  }

  /** 券种定义列表（后台） */
  async listDefs(): Promise<CouponDefResult[]> {
    const rows = await this.dataSource.getRepository(CouponDef).find({ order: { id: 'DESC' } });
    return rows.map((r) => this.toDefResult(r));
  }

  /** 按手机号反查用户（后台手动发券用） */
  async resolveUserByPhone(phone: string): Promise<number | null> {
    const u = await this.dataSource.getRepository(User).findOne({ where: { phone } });
    return u ? u.id : null;
  }

  /** 发放记录（核券记录，后台） */
  async listGrants(filter: {
    obtainedFrom?: string;
    userId?: number;
  }): Promise<UserCouponResult[]> {
    const repo = this.dataSource.getRepository(UserCoupon);
    const where: { obtainedFrom?: string; userId?: number } = {};
    if (filter.obtainedFrom) where.obtainedFrom = filter.obtainedFrom;
    if (filter.userId) where.userId = filter.userId;
    const rows = await repo.find({ where, order: { createdAt: 'DESC' }, take: 200 });
    return rows.map((r) => this.toResult(r));
  }

  /** 创建券种定义（后台） */
  async createDef(input: {
    name: string;
    faceValueFen: number;
    thresholdFen: number;
    validityType: CouponValidityType;
    validDays?: number | null;
    validFrom?: string | null;
    validTo?: string | null;
    totalLimit?: number | null;
    remark?: string | null;
    status?: string;
  }): Promise<CouponDefResult> {
    const repo = this.dataSource.getRepository(CouponDef);
    const entity = repo.create({
      name: input.name,
      faceValue: money(input.faceValueFen / 100),
      threshold: money((input.thresholdFen ?? 0) / 100),
      validityType: input.validityType,
      validDays: input.validDays ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      totalLimit: input.totalLimit ?? null,
      issuedCount: 0,
      status: input.status ?? 'active',
      remark: input.remark ?? null,
    });
    return this.toDefResult(await repo.save(entity));
  }

  /** 更新券种定义（后台；不可改面额/有效期等已发放影响项，这里仅开放状态/备注/限量） */
  async updateDef(
    id: number,
    patch: { status?: string; remark?: string | null; totalLimit?: number | null },
  ): Promise<CouponDefResult> {
    const repo = this.dataSource.getRepository(CouponDef);
    const def = await repo.findOne({ where: { id } });
    if (!def) throw new BizException(ErrorCode.COUPON_DEF_INVALID, `券种定义不存在（id=${id}）`);
    if (patch.status !== undefined) def.status = patch.status;
    if (patch.remark !== undefined) def.remark = patch.remark;
    if (patch.totalLimit !== undefined) def.totalLimit = patch.totalLimit;
    return this.toDefResult(await repo.save(def));
  }
}
