import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomBytes } from 'crypto';

import { CouponDef, UserCoupon } from '../../database/entities/coupon.entity';
import { User } from '../../database/entities/user.entity';
import {
  AvailableCouponResult,
  CouponDefResult,
  CouponObtainedFrom,
  CouponValidityType,
  MyCouponResult,
  UserCouponResult,
} from '@abox/shared-types';
import { toFen, money } from '../../common/utils/money';
import { bjDateTime, now, toBjIso } from '../../common/utils/time';
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
      createdAt:
        toBjIso(uc.createdAt instanceof Date ? uc.createdAt : new Date(uc.createdAt)) ?? '',
    };
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

    // 有效期解析
    let validFrom: Date;
    let validTo: Date;
    if (input.validityType === 'days') {
      const days = input.validDays ?? 0;
      validFrom = at;
      validTo = new Date(at.getTime() + days * 86_400_000);
    } else {
      if (!input.validFrom || !input.validTo) {
        throw new BizException(
          ErrorCode.COUPON_GRANT_PARAM_INVALID,
          `period 型券必须给定 validFrom / validTo（券名=${input.name ?? '未命名'}）`,
        );
      }
      // ⚠️ 一律走 `bjDateTime`（唯一时区换算实现），不要手拼 `T00:00:00+08:00`
      //    —— 那种写法依赖宿主对带偏移字符串的解析，且与全工程的时间口径不同源。
      //    `hour = 24` 会被进位成「次日 0 点」，正好是「失效日当天含尾」的精确上界。
      validFrom = bjDateTime(input.validFrom, 0);
      validTo = bjDateTime(input.validTo, 24);
    }

    // 关联券种定义：校验 + 取默认值 + 限量
    let couponDef: CouponDef | null = null;
    if (input.couponDefId) {
      couponDef = await this.dataSource.getRepository(CouponDef).findOne({
        where: { id: input.couponDefId },
      });
      if (!couponDef) {
        throw new BizException(
          ErrorCode.COUPON_DEF_INVALID,
          `券种定义不存在（id=${input.couponDefId}）`,
        );
      }
      if (couponDef.status !== 'active') {
        throw new BizException(ErrorCode.COUPON_DEF_INVALID, '券种定义已停用，不能发放');
      }
      if (couponDef.totalLimit != null && couponDef.issuedCount >= couponDef.totalLimit) {
        throw new BizException(
          ErrorCode.COUPON_DEF_INVALID,
          `券种已达发行上限（${couponDef.issuedCount}/${couponDef.totalLimit}）`,
        );
      }
    }

    const name = input.name ?? couponDef?.name ?? '代金券';
    const faceValueFen = input.faceValueFen;

    const repo = this.dataSource.getRepository(UserCoupon);

    // 写券（券码碰撞重试，最多 6 次）
    let saved: UserCoupon | null = null;
    for (let i = 0; i < 6; i++) {
      const entity = repo.create({
        userId: input.userId,
        code: this.genCode(),
        couponDefId: input.couponDefId ?? null,
        name,
        faceValue: money(faceValueFen / 100),
        threshold: money(thresholdFen / 100),
        validFrom,
        validTo,
        status: 'unused',
        obtainedFrom,
        remark: input.remark ?? null,
      });
      try {
        saved = await repo.save(entity);
        break;
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? '';
        if (/Duplicate entry[^\n]*uk_user_coupon_code/.test(msg) && i < 5) {
          continue; // 券码碰撞，重试
        }
        throw e;
      }
    }
    if (!saved) {
      throw new BizException(ErrorCode.INTERNAL_ERROR, '代金券发放失败（券码连续冲突），请重试');
    }

    // 回写 issuedCount（关联定义时）
    if (couponDef) {
      await this.dataSource
        .getRepository(CouponDef)
        .increment({ id: couponDef.id }, 'issuedCount', 1);
    }

    this.logger.log(
      `发放代金券 code=${saved.code} user=${input.userId} 面额=${faceValueFen}分 来源=${obtainedFrom}`,
    );
    return this.toResult(saved);
  }

  /** 我的券（全部，带可用性判据） */
  async listMy(userId: number): Promise<MyCouponResult[]> {
    const now = new Date();
    const rows = await this.dataSource.getRepository(UserCoupon).find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((uc) => {
      const base = this.toResult(uc);
      const inWindow = this.inWindow(uc, now);
      const available = uc.status === 'unused' && inWindow;
      let unavailableReason: string | undefined;
      if (uc.status === 'used') unavailableReason = '已使用';
      else if (!inWindow) unavailableReason = now < uc.validFrom ? '未到生效日' : '已过期';
      return { ...base, available, unavailableReason };
    });
  }

  /** 订单可用券（未使用 + 在有效期 + 门槛满足；含实际抵扣额） */
  async listAvailableForOrder(userId: number, totalFen: number): Promise<AvailableCouponResult[]> {
    const now = new Date();
    const rows = await this.dataSource.getRepository(UserCoupon).find({
      where: { userId, status: 'unused' },
      order: { validTo: 'ASC' },
    });
    return rows
      .filter((uc) => this.inWindow(uc, now))
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
