import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, ObjectLiteral, Repository } from 'typeorm';

import {
  LICENSE_EXPIRING_DAYS,
  LICENSE_STATE_LABEL,
  LicenseState,
  SUPPLIER_AUDIT_STATUS_LABEL,
  SUPPLIER_STATUS_LABEL,
  SUPPLIER_TYPE_LABEL,
  SUPPLIER_TYPE_OPTIONS,
  SupplierAuditStatus,
  SupplierStatus,
  SupplierType,
  TAKEOUT_PLATFORM_LABEL,
  TakeoutPlatform,
} from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { maskPhone } from '../../common/utils/crypto';
import { toFen } from '../../common/utils/money';
import { normalizePage, paginate, PageResult } from '../../common/utils/response';
import { addDays, monthRangeOf, toBjIso, todayBj } from '../../common/utils/time';
import { DistributionCenter, SupplierShare } from '../../database/entities/finance.entity';
import { AdminUser, OperationLog } from '../../database/entities/system.entity';
import { Dish, Supplier } from '../../database/entities/supplier.entity';
import {
  AdminSuppliersQueryDto,
  AuditSupplierDto,
  CreateSupplierDto,
  PAYEE_TYPE_LABEL,
  PayeeType,
  SetSettleAccountDto,
  SetSupplierTypeDto,
  SetTakeoutLinksDto,
  UpdateSupplierDto,
} from './dto/supplier-admin.dto';

/** 分账流水的主体类型（`ab_supplier_share.payee_type`） */
const PAYEE_SUPPLIER = 'supplier';

type SupplierActions = { canManage: boolean };

type SupplierListResult = PageResult<Record<string, unknown>> & {
  summary: Record<string, unknown>;
  typeOptions: Array<Record<string, unknown>>;
  auditStatusOptions: Array<Record<string, unknown>>;
  statusOptions: Array<Record<string, unknown>>;
  categoryOptions: Array<Record<string, unknown>>;
  payeeTypeOptions: Array<Record<string, unknown>>;
  actions: SupplierActions;
  notes?: Record<string, string>;
};

/**
 * 后台 · 供应商管理服务（M3-6 · 《接口规范》§6.4 D23–D28 · 原型 P33）
 *
 * ## 四条贯穿本文件的纪律
 *
 * 1. **资质审核状态与经营状态正交**：`audit_status` 回答「有没有合规资格」，
 *    `status` 回答「平台要不要继续合作」。D26 **驳回不自动停用** ——
 *    审核是事实判定，停用是经营决策，替运营拍板会让「为什么它突然消失了」无从追查。
 *    两者的交集只体现在派生字段 `canServe` 上（三者全满足才可出餐）。
 *
 * 2. **证照有效期是合规闸门，不是展示字段**：123 号令要求平台核验入网商户证照，
 *    证照过期即不得出餐。故 `license_expire_at` 参与三件事：
 *    · D26 审核通过时**已在过去 → 直接 50001**（不给「带病通过」留后门）
 *    · D25 编辑时若把有效期改成过去 → **同步下架其关联菜品**（原型 P33 的联动行为）
 *    · D23 列表算出 `licenseState` 供筛选与告警（**派生值不落库**，避免双真相）
 *
 * 3. **类型不是标签，是履约能力声明**：`distribute` / `both` 才能被集散中心引用。
 *    D27 若把**已被集散中心引用**的供应商改成 `dish`，就会造出
 *    「集散中心指向一家不出餐也不集散的供应商」——故 50008 fail-closed。
 *
 * 4. **列表脱敏、详情才给真值**：列表页的 `contactPhoneMasked` 是防「顺手爬走全平台
 *    商家电话」；银行账号在 D28 响应里也只回 `bankAccountMasked`（运营刚填过也不回原文）。
 */
@Injectable()
export class SupplierAdminService {
  private readonly logger = new Logger('SupplierAdminService');

  constructor(
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(Dish) private readonly dishRepo: Repository<Dish>,
    @InjectRepository(DistributionCenter) private readonly dcRepo: Repository<DistributionCenter>,
    @InjectRepository(SupplierShare) private readonly shareRepo: Repository<SupplierShare>,
    @InjectRepository(AdminUser) private readonly adminRepo: Repository<AdminUser>,
    @InjectRepository(OperationLog) private readonly opLogRepo: Repository<OperationLog>,
  ) {}

  // ==========================================================================
  // D23 · 供应商名录 / 详情
  // ==========================================================================

  /**
   * D23 名录
   *
   * `summary` 按**同一过滤条件的全量**统计（与 D8/D19 同一约定）：
   * 端上翻页时 KPI 卡不跟着跳，否则运营会把「本页 20 条里有 3 家过期」
   * 误读成「全平台只有 3 家过期」。
   */
  async list(q: AdminSuppliersQueryDto, viewerRole: string): Promise<SupplierListResult> {
    const actions: SupplierActions = {
      // 「改档案 / 定类型 / 审资质 / 改账户」都是高风险动作：
      // 类级白名单含 operator（要看名录），这些动作收窄到 super_admin / admin。
      canManage: viewerRole === 'super_admin' || viewerRole === 'admin',
    };

    const { page, pageSize, skip } = normalizePage(q);
    const qb = this.buildQuery(q);
    const all = await qb.clone().orderBy('s.id', 'ASC').getMany();
    const [rows, total] = await qb
      .clone()
      .orderBy('s.status', 'DESC')
      .addOrderBy('s.id', 'ASC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    const ids = all.map((s) => Number(s.id));
    const [dishMap, dcMap, shareMap, auditNameMap] = await Promise.all([
      this.countGroup('d', 'd.supplier_id', this.dishRepo, ids),
      this.countGroup('c', 'c.supplier_id', this.dcRepo, ids),
      this.monthShareMap(ids),
      this.adminNameMap(all.map((s) => Number(s.auditedBy ?? 0)).filter(Boolean)),
    ]);

    const decorate = (s: Supplier) => this.decorate(s, dishMap, dcMap, shareMap, auditNameMap);

    return {
      ...paginate(rows.map(decorate), total, page, pageSize),
      summary: this.summarize(all, dcMap),
      typeOptions: SUPPLIER_TYPE_OPTIONS,
      auditStatusOptions: Object.values(SupplierAuditStatus).map((v) => ({
        value: v,
        label: SUPPLIER_AUDIT_STATUS_LABEL[v],
      })),
      statusOptions: [SupplierStatus.ACTIVE, SupplierStatus.SUSPENDED].map((v) => ({
        value: v,
        label: SUPPLIER_STATUS_LABEL[v],
      })),
      categoryOptions: [...new Set(all.map((s) => s.category).filter((c): c is string => !!c))]
        .sort()
        .map((c) => ({ value: c, label: c })),
      payeeTypeOptions: (Object.keys(PAYEE_TYPE_LABEL) as PayeeType[]).map((v) => ({
        value: v,
        label: PAYEE_TYPE_LABEL[v],
      })),
      actions,
      notes: {
        takeoutLinks:
          '外卖平台跳转链接按供应商维度配置（美团/淘宝/京东），见 P33「外卖平台店铺链接配置」。' +
          '⚠️ 能跳转 ≠ 是合作伙伴 —— C8 约束下平台永不下发「哪些是备选商家」。',
        licenseState:
          'licenseState 为**派生值**（由 licenseExpireAt 与北京时间当天实时算出），不落库；' +
          'expiring 阈值 30 天。已过期会让关联菜品被联动下架，建议筛选 expired 优先处理。',
      },
    };
  }

  /** D23 附属 · 详情（档案 + 关联集散中心 + 菜品 + 近 30 条分账 + 操作日志） */
  async detail(id: number) {
    const s = await this.assertSupplier(id);
    const [dishes, dcList, shares, logs, shareMap, dcMap] = await Promise.all([
      this.dishRepo.find({ where: { supplierId: id }, order: { id: 'ASC' } }),
      this.dcRepo.find({ where: { supplierId: id }, order: { id: 'ASC' } }),
      this.shareRepo.find({
        where: { payeeType: PAYEE_SUPPLIER, payeeId: id },
        order: { id: 'DESC' },
        take: 30,
      }),
      this.opLogRepo.find({ where: { targetId: String(id) }, order: { id: 'DESC' }, take: 20 }),
      this.monthShareMap([id]),
      this.countGroup('c', 'c.supplier_id', this.dcRepo, [id]),
    ]);

    return {
      supplier: this.decorate(s, new Map([[id, dishes.length]]), dcMap, shareMap, new Map()),
      /** ⚠️ 详情页才回真实手机号（列表页脱敏）*/
      contactPhone: s.contactPhone,
      contactPhoneMasked: maskPhone(s.contactPhone),
      bank: {
        payeeType: s.payeeType,
        payeeTypeLabel: (PAYEE_TYPE_LABEL as Record<string, string>)[s.payeeType] ?? s.payeeType,
        bankName: s.bankName ?? null,
        bankAccountMasked: this.maskAccount(s.bankAccount),
        /** 银行账号原文**任何后台接口都不回**，付款登记时由财务线下核对 */
        invoiceTitle: s.invoiceTitle ?? null,
      },
      dishes: dishes.map((d) => this.decorateDish(d)),
      distributionCenters: dcList.map((c) => ({
        id: c.id,
        name: c.name,
        address: c.address,
        status: c.status,
        statusLabel: c.status === 1 ? '启用' : '停用',
      })),
      recentShares: shares.map((r) => ({
        id: r.id,
        shareNo: r.shareNo,
        shareDate: r.shareDate,
        mealDate: r.mealDate,
        dishId: r.dishId ?? null,
        quantity: r.quantity,
        unitPriceFen: toFen(Number(r.unitPrice)),
        amountFen: toFen(Number(r.amount)),
        type: r.type,
        status: r.status,
      })),
      operationLogs: logs.map((l) => ({
        id: l.id,
        module: l.module,
        action: l.action,
        adminUserId: l.adminUserId ?? null,
        createdAt: toBjIso(l.createdAt),
      })),
      takeout: this.takeoutLinksOut(s),
    };
  }

  // ==========================================================================
  // D24 / D25 · 新增 / 编辑
  // ==========================================================================

  /** D24 新增供应商（新建即 `audit_status=pending` + `status=1`，等待 D26 审核） */
  async create(dto: CreateSupplierDto) {
    const saved = await this.supplierRepo.save(
      this.supplierRepo.create({
        name: dto.name,
        type: dto.type,
        contactName: dto.contactName,
        contactPhone: dto.contactPhone,
        category: dto.category ?? null,
        businessLicense: dto.businessLicense ?? null,
        foodLicense: dto.foodLicense ?? null,
        licenseExpireAt: dto.licenseExpireAt ?? null,
        address: dto.address ?? null,
        capacityPerDay: dto.capacityPerDay ?? null,
        payeeType: dto.payeeType ?? 'corporate',
        /** 新建一律待审 —— 资质未核验前不得出餐（50001 的前置） */
        auditStatus: SupplierAuditStatus.PENDING,
        status: SupplierStatus.ACTIVE,
      }),
    );
    this.logger.log(`新增供应商 #${saved.id} ${saved.name}`);
    return {
      id: Number(saved.id),
      name: saved.name,
      type: saved.type,
      auditStatus: saved.auditStatus,
      status: saved.status,
    };
  }

  /**
   * D25 编辑供应商
   *
   * ⚠️ 两个隐式副作用，都在出参里显式回报（不做「偷偷改了却不说」）：
   *   · `type` 被改成 `dish` 却仍被集散中心引用 → 50008（见文件头纪律 3）
   *   · `licenseExpireAt` 被改成过去 → **同步下架其关联菜品**，回报 `unpublishedDishCount`
   */
  async update(id: number, dto: UpdateSupplierDto) {
    const s = await this.assertSupplier(id);

    if (dto.type !== undefined && dto.type !== s.type) {
      await this.assertTypeChangeAllowed(id, dto.type);
      s.type = dto.type;
    }

    if (dto.name !== undefined) s.name = dto.name;
    if (dto.contactName !== undefined) s.contactName = dto.contactName;
    if (dto.contactPhone !== undefined) s.contactPhone = dto.contactPhone;
    if (dto.category !== undefined) s.category = dto.category;
    if (dto.businessLicense !== undefined) s.businessLicense = dto.businessLicense;
    if (dto.foodLicense !== undefined) s.foodLicense = dto.foodLicense;
    if (dto.address !== undefined) s.address = dto.address;
    if (dto.capacityPerDay !== undefined) s.capacityPerDay = dto.capacityPerDay;
    if (dto.payeeType !== undefined) s.payeeType = dto.payeeType;
    if (dto.status !== undefined) s.status = dto.status;

    let unpublishedDishCount = 0;
    if (dto.licenseExpireAt !== undefined) {
      s.licenseExpireAt = dto.licenseExpireAt;
      // 证照落成过期 → 关联菜品同步下架（原型 P33 的合规联动 · 123 号令）
      if (this.licenseStateOf(dto.licenseExpireAt) === LicenseState.EXPIRED) {
        const r = await this.dishRepo.update({ supplierId: id, status: 1 }, { status: 0 });
        unpublishedDishCount = r.affected ?? 0;
      }
    }

    s.version += 1;
    await this.supplierRepo.save(s);
    return {
      id: Number(s.id),
      type: s.type,
      status: s.status,
      licenseExpireAt: s.licenseExpireAt ?? null,
      licenseState: this.licenseStateOf(s.licenseExpireAt),
      /** 联动下架了几道菜 —— 不回报的话，运营会以为菜品是自己消失的 */
      unpublishedDishCount,
      canServe: this.canServe(s),
    };
  }

  // ==========================================================================
  // D26 · 资质审核
  // ==========================================================================

  /**
   * D26 资质审核
   *
   * `approved` 的前置：**库中或本次入参能给出一个未过期的证照有效期**，否则 50001。
   * 这是有意为之的严格：C11 允许银行账户「后置收集」，但**证照有效期不能后置** ——
   * 没有它，123 号令要求的「证照过期不得出餐」无从判定，平台就是明知故犯。
   */
  async audit(id: number, dto: AuditSupplierDto, adminUserId: number) {
    const s = await this.assertSupplier(id);
    const expire = dto.licenseExpireAt ?? s.licenseExpireAt ?? null;

    if (dto.result === 'approved') {
      if (!expire) {
        throw new BizException(
          ErrorCode.SUPPLIER_NOT_QUALIFIED,
          '通过资质审核前必须登记食品经营许可证有效期（不接受「后置补」）',
        );
      }
      if (this.licenseStateOf(expire) === LicenseState.EXPIRED) {
        throw new BizException(
          ErrorCode.SUPPLIER_NOT_QUALIFIED,
          `食品经营许可证已于 ${expire} 过期，不能通过审核`,
        );
      }
      s.auditStatus = SupplierAuditStatus.APPROVED;
    } else {
      if (!dto.remark || dto.remark.trim().length < 2) {
        throw new BizException(ErrorCode.PARAM_INVALID, '驳回资质必须填写审核意见（≥2 字）');
      }
      s.auditStatus = SupplierAuditStatus.REJECTED;
    }

    s.licenseExpireAt = expire;
    s.auditRemark = dto.remark ?? null;
    s.auditedAt = new Date();
    s.auditedBy = adminUserId;
    s.version += 1;
    await this.supplierRepo.save(s);

    return {
      id: Number(s.id),
      auditStatus: s.auditStatus,
      auditStatusLabel: SUPPLIER_AUDIT_STATUS_LABEL[s.auditStatus as SupplierAuditStatus],
      licenseExpireAt: s.licenseExpireAt,
      licenseState: this.licenseStateOf(s.licenseExpireAt),
      /** 审核**不影响**合作状态（纪律 1）——显式回带，免得端上自己猜 */
      status: s.status,
      canServe: this.canServe(s),
    };
  }

  // ==========================================================================
  // D27 · 设置类型
  // ==========================================================================

  async setType(id: number, dto: SetSupplierTypeDto) {
    const s = await this.assertSupplier(id);
    if (dto.type === s.type) {
      // 目标态重复操作不是幂等成功：运营点两次「保存」与「确实改了」要能区分
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `该供应商已经是「${SUPPLIER_TYPE_LABEL[dto.type as SupplierType]}」`,
      );
    }
    await this.assertTypeChangeAllowed(id, dto.type);
    s.type = dto.type;
    s.version += 1;
    await this.supplierRepo.save(s);
    return {
      id: Number(s.id),
      type: s.type,
      typeLabel: SUPPLIER_TYPE_LABEL[s.type as SupplierType],
    };
  }

  // ==========================================================================
  // D28 · 对公结算账户
  // ==========================================================================

  /**
   * D28 对公结算账户
   *
   * ⚠️ `payeeType=corporate` 时开户行与账号必填（**服务层**校验，不是 DTO 硬顶）：
   *    C11 允许账户信息后置收集，但既然选了「对公」，就该有对公账户 ——
   *    否则结算单生成了却无处可付，日结（T+1 02:00）会在付款环节卡住。
   */
  async setSettleAccount(id: number, dto: SetSettleAccountDto) {
    const s = await this.assertSupplier(id);

    if (dto.payeeType === 'corporate' && (!dto.bankName || !dto.bankAccount)) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        '对公转账必须填写开户行与银行账号（对私/现金可不填）',
      );
    }

    s.payeeType = dto.payeeType;
    s.bankName = dto.bankName ?? null;
    s.bankAccount = dto.bankAccount ?? null;
    s.invoiceTitle = dto.invoiceTitle ?? null;
    s.version += 1;
    await this.supplierRepo.save(s);

    return {
      id: Number(s.id),
      payeeType: s.payeeType,
      payeeTypeLabel: (PAYEE_TYPE_LABEL as Record<string, string>)[dto.payeeType] ?? dto.payeeType,
      bankName: s.bankName,
      /** 回带即脱敏：运营刚填过也不该在响应里拿到完整账号（防日志/截图泄露）*/
      bankAccountMasked: this.maskAccount(s.bankAccount),
      invoiceTitle: s.invoiceTitle,
    };
  }

  // ==========================================================================
  // 扩展 · 外卖平台店铺链接（原型 P33「外卖平台店铺链接配置」）
  // ==========================================================================

  async setTakeoutLinks(id: number, dto: SetTakeoutLinksDto) {
    const s = await this.assertSupplier(id);
    const current = (s.takeoutLinks ?? {}) as Record<
      string,
      { url: string | null; shopId?: string | null }
    >;

    const next: Record<string, { url: string | null; shopId?: string | null }> = { ...current };
    for (const p of Object.values(TakeoutPlatform)) {
      const item = dto[p];
      if (item === undefined) continue; // 未传 = 保持原值（只想改一家不必回传另外两家）
      if (item.url === null || item.url === '') {
        delete next[p]; // 显式传空 = 清空该平台（「未入驻」是合法状态）
      } else {
        next[p] = { url: item.url ?? null, shopId: item.shopId ?? null };
      }
    }
    // ⚠️ `__recommended.url` 里存的是**平台 key**（meituan/taobao/jd），不是链接 ——
    //    这一格复用了 { url, shopId } 的形状，命名有误导性，但避免为它单开一层结构。
    if (dto.recommended !== undefined) {
      next.__recommended = { url: dto.recommended, shopId: null };
    }
    // 悬空推荐必须清掉：刚把「推荐平台」的链接删掉（未入驻），却还挂着「推荐它」，
    // 比没有推荐更糟 —— 用户在端上会看到一个点了没反应的入口。
    const recommendKey = next.__recommended?.url;
    if (recommendKey && !next[recommendKey]?.url) {
      delete next.__recommended;
    }

    s.takeoutLinks = Object.keys(next).length ? next : null;
    s.version += 1;
    await this.supplierRepo.save(s);
    return this.takeoutLinksOut(s);
  }

  // ==========================================================================
  // 私有 · 查询构造
  // ==========================================================================

  private buildQuery(q: AdminSuppliersQueryDto) {
    const qb = this.supplierRepo.createQueryBuilder('s').where('s.deleted_at IS NULL');

    if (q.type) qb.andWhere('s.type = :type', { type: q.type });
    if (q.status !== undefined) qb.andWhere('s.status = :status', { status: q.status });
    if (q.auditStatus) qb.andWhere('s.audit_status = :as', { as: q.auditStatus });
    if (q.category) qb.andWhere('s.category = :cat', { cat: q.category });

    if (q.licenseState) {
      const today = todayBj();
      const limit = addDays(today, LICENSE_EXPIRING_DAYS);
      switch (q.licenseState) {
        case LicenseState.EXPIRED:
          qb.andWhere('s.license_expire_at IS NOT NULL AND s.license_expire_at < :today', {
            today,
          });
          break;
        case LicenseState.EXPIRING:
          qb.andWhere('s.license_expire_at >= :today AND s.license_expire_at <= :limit', {
            today,
            limit,
          });
          break;
        case LicenseState.NORMAL:
          qb.andWhere('s.license_expire_at > :limit', { limit });
          break;
        default:
          // unknown：未登记（历史行 / 后置收集）
          qb.andWhere('s.license_expire_at IS NULL');
      }
    }

    if (q.keyword) {
      const kw = `%${q.keyword}%`;
      // 关键词同时命中「供应商自身字段」与「它名下集散中心的名字」——
      // 运营记得住「集散中心 3（国贸 D/远洋）」，不一定记得住它挂在谁名下。
      qb.andWhere(
        new Brackets((w) => {
          w.where('s.name LIKE :kw', { kw })
            .orWhere('s.contact_name LIKE :kw', { kw })
            .orWhere('s.contact_phone LIKE :kw', { kw })
            .orWhere(
              's.id IN (SELECT c.supplier_id FROM ab_distribution_center c WHERE c.name LIKE :kw)',
              { kw },
            );
        }),
      );
    }

    return qb;
  }

  private summarize(all: Supplier[], dcMap: Map<number, number>) {
    const count = (fn: (s: Supplier) => boolean) => all.filter(fn).length;
    const state = (s: Supplier) => this.licenseStateOf(s.licenseExpireAt);

    return {
      totalCount: all.length,
      activeCount: count((s) => s.status === SupplierStatus.ACTIVE),
      suspendedCount: count((s) => s.status === SupplierStatus.SUSPENDED),
      dishCount: count((s) => s.type === SupplierType.DISH),
      distributeCount: count((s) => s.type === SupplierType.DISTRIBUTE),
      bothCount: count((s) => s.type === SupplierType.BOTH),
      /** P33 KPI「集散中心数」——所有供应商名下的集散中心合计（M34-05 同源） */
      dcTotalCount: all.reduce((a, s) => a + (dcMap.get(Number(s.id)) ?? 0), 0),
      auditPendingCount: count((s) => s.auditStatus === SupplierAuditStatus.PENDING),
      auditApprovedCount: count((s) => s.auditStatus === SupplierAuditStatus.APPROVED),
      auditRejectedCount: count((s) => s.auditStatus === SupplierAuditStatus.REJECTED),
      /** P33 KPI「资质 30 天内到期」*/
      expiringCount: count((s) => state(s) === LicenseState.EXPIRING),
      /** P33 KPI「已过期」（会让关联菜品被联动下架）*/
      expiredCount: count((s) => state(s) === LicenseState.EXPIRED),
      canServeCount: count((s) => this.canServe(s)),
    };
  }

  private decorate(
    s: Supplier,
    dishMap: Map<number, number>,
    dcMap: Map<number, number>,
    shareMap: Map<number, number>,
    auditNameMap: Map<number, string>,
  ) {
    const licenseState = this.licenseStateOf(s.licenseExpireAt);
    const id = Number(s.id);
    return {
      id,
      name: s.name,
      type: s.type,
      typeLabel: SUPPLIER_TYPE_LABEL[s.type as SupplierType] ?? s.type,
      contactName: s.contactName,
      /** 列表一律脱敏（详情才给真号）*/
      contactPhoneMasked: maskPhone(s.contactPhone),
      category: s.category ?? null,
      auditStatus: s.auditStatus,
      auditStatusLabel:
        SUPPLIER_AUDIT_STATUS_LABEL[s.auditStatus as SupplierAuditStatus] ?? s.auditStatus,
      auditRemark: s.auditRemark ?? null,
      auditedAt: toBjIso(s.auditedAt),
      auditedBy: s.auditedBy ?? null,
      auditedByName: s.auditedBy ? (auditNameMap.get(Number(s.auditedBy)) ?? null) : null,
      licenseExpireAt: s.licenseExpireAt ?? null,
      licenseState,
      licenseStateLabel: LICENSE_STATE_LABEL[licenseState],
      licenseDaysLeft: this.daysLeft(s.licenseExpireAt),
      status: s.status,
      statusLabel: SUPPLIER_STATUS_LABEL[s.status] ?? String(s.status),
      dishCount: dishMap.get(id) ?? 0,
      dcCount: dcMap.get(id) ?? 0,
      /** 本月应付（含反向冲销负行）· 与 M35 结算单同口径 */
      monthShareFen: shareMap.get(id) ?? 0,
      takeoutPlatforms: Object.keys(s.takeoutLinks ?? {}).filter((k) => !k.startsWith('__')),
      canServe: this.canServe(s),
      capacityPerDay: s.capacityPerDay ?? null,
    };
  }

  private decorateDish(d: Dish) {
    return {
      id: Number(d.id),
      supplierId: Number(d.supplierId),
      name: d.name,
      category: d.category ?? null,
      costPriceFen: toFen(Number(d.costPrice)),
      saleCount: d.saleCount,
      rating: Number(d.rating),
      status: d.status,
      statusLabel: d.status === 1 ? '上架' : '下架',
      description: d.description ?? null,
      imageUrl: d.imageUrl ?? null,
    };
  }

  // ==========================================================================
  // 私有 · 业务判定
  // ==========================================================================

  private async assertSupplier(id: number): Promise<Supplier> {
    const s = await this.supplierRepo.findOne({ where: { id } });
    if (!s || s.deletedAt) throw new BizException(ErrorCode.SUPPLIER_NOT_FOUND);
    return s;
  }

  /**
   * 改类型前的履约一致性检查
   *
   * 已被集散中心引用的供应商不能被降级为纯 `dish`：
   * `ab_distribution_center.supplier_id` 指向的必须是**能承担集散**的主体，
   * 否则会出现「集散中心挂在只出餐的商家名下」这种自相矛盾的主数据。
   */
  private async assertTypeChangeAllowed(supplierId: number, nextType: string): Promise<void> {
    if (nextType !== SupplierType.DISH) return;
    const dcCount = await this.dcRepo.count({ where: { supplierId } });
    if (dcCount > 0) {
      throw new BizException(
        ErrorCode.SUPPLIER_TYPE_CONFLICT,
        `该供应商名下仍有 ${dcCount} 个集散中心，不能改为「${SUPPLIER_TYPE_LABEL[SupplierType.DISH]}」——` +
          '请先把集散中心改挂到其他主体，或改为集散型/混合型',
      );
    }
  }

  /** 能否出餐：三项全满足（S2 出餐前置校验的同一判据）*/
  private canServe(s: Supplier): boolean {
    return (
      s.status === SupplierStatus.ACTIVE &&
      s.auditStatus === SupplierAuditStatus.APPROVED &&
      this.licenseStateOf(s.licenseExpireAt) !== LicenseState.EXPIRED
    );
  }

  /**
   * 证照有效期 → 档位（**派生值，不落库**）
   * 未登记 ≠ 过期：历史行允许为空（后置收集），但审核通过时会强制要求登记。
   */
  private licenseStateOf(expire?: string | null): LicenseState {
    if (!expire) return LicenseState.UNKNOWN;
    const today = todayBj();
    if (expire < today) return LicenseState.EXPIRED;
    if (expire <= addDays(today, LICENSE_EXPIRING_DAYS)) return LicenseState.EXPIRING;
    return LicenseState.NORMAL;
  }

  /** 距到期天数（已过期返回负值；未登记返回 null）—— 端上直接显示，不自己算 */
  private daysLeft(expire?: string | null): number | null {
    if (!expire) return null;
    const [y1, m1, d1] = todayBj().split('-').map(Number);
    const [y2, m2, d2] = expire.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  }

  private maskAccount(account?: string | null): string | null {
    if (!account) return null;
    return `**** **** **** ${account.slice(-4)}`;
  }

  private takeoutLinksOut(s: Supplier) {
    const raw = (s.takeoutLinks ?? {}) as Record<
      string,
      { url: string | null; shopId?: string | null }
    >;
    // ⚠️ 三个平台**一律返回**（未配置的 configured=false）——
    //    前端要显示灰色「未入驻」而不是整行消失；筛掉未配置项会让「缺京东」这件事看不见。
    const links = Object.values(TakeoutPlatform).map((p) => ({
      platform: p,
      platformLabel: TAKEOUT_PLATFORM_LABEL[p],
      url: raw[p]?.url ?? null,
      shopId: raw[p]?.shopId ?? null,
      configured: !!raw[p]?.url,
    }));
    return {
      links,
      recommended: (raw.__recommended?.url as string | undefined) ?? null,
      configuredCount: links.filter((l) => l.configured).length,
    };
  }

  // ==========================================================================
  // 私有 · 聚合（N+1 防呆）
  // ==========================================================================

  /** 按外键分组计数：一次 group by 取代逐行 count */
  private async countGroup<T extends ObjectLiteral>(
    alias: string,
    column: string,
    repo: Repository<T>,
    ids: number[],
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!ids.length) return map;
    const rows = await repo
      .createQueryBuilder(alias)
      .select(column, 'fk')
      .addSelect('COUNT(*)', 'cnt')
      .where(`${column} IN (:...ids)`, { ids })
      .andWhere(`${alias}.deleted_at IS NULL`)
      .groupBy(column)
      .getRawMany<{ fk: number | string; cnt: number | string }>();
    for (const r of rows) map.set(Number(r.fk), Number(r.cnt));
    return map;
  }

  /**
   * 本月应付合计（分）
   *
   * ⚠️ 用 `SUM(amount)` **不剔反向冲销负行** —— 与 M35 结算单同一口径：
   *    本月发生两笔退款冲销，应付就该少两笔。若这里只加正向，
   *    运营看到的「本月供应」会比结算单高，届时对不上账。
   */
  private async monthShareMap(ids: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!ids.length) return map;
    const { from, to } = monthRangeOf(todayBj());
    const rows = await this.shareRepo
      .createQueryBuilder('s')
      .select('s.payee_id', 'payeeId')
      .addSelect('SUM(s.amount)', 'amount')
      .where('s.payee_type = :t', { t: PAYEE_SUPPLIER })
      .andWhere('s.payee_id IN (:...ids)', { ids })
      .andWhere('s.meal_date BETWEEN :from AND :to', { from, to })
      .groupBy('s.payee_id')
      .getRawMany<{ payeeId: number | string; amount: string | number }>();
    for (const r of rows) map.set(Number(r.payeeId), toFen(Number(r.amount)));
    return map;
  }

  private async adminNameMap(ids: number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (!ids.length) return map;
    const rows = await this.adminRepo.find({ where: { id: In(ids) } });
    for (const a of rows) map.set(Number(a.id), a.realName ?? a.username);
    return map;
  }
}
