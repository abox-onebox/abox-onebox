import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { SupplierType } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { money, toFen, toYuan } from '../../common/utils/money';
import { normalizePage, paginate, PageResult } from '../../common/utils/response';
import { BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter, SupplierShare } from '../../database/entities/finance.entity';
import { MealAssignment } from '../../database/entities/meal.entity';
import { Supplier } from '../../database/entities/supplier.entity';
import {
  AdminDistributionCentersQueryDto,
  CreateDistributionCenterDto,
  UpdateDistributionCenterDto,
} from './dto/distribution-center-admin.dto';

/** 分账流水的集散主体类型（`ab_supplier_share.payee_type`） */
const PAYEE_DC = 'distribution_center';

type DcListResult = PageResult<Record<string, unknown>> & {
  summary: Record<string, unknown>;
  statusOptions: Array<Record<string, unknown>>;
  supplierOptions: Array<Record<string, unknown>>;
  groupOptions: Array<Record<string, unknown>>;
  actions: { canManage: boolean };
  notes?: Record<string, string>;
};

/** 单个集散中心的历史应付统计 */
interface ShareStat {
  count: number;
  amountFen: number;
}

/**
 * 后台 · 集散中心配置服务（M3-6 · 《接口规范》§6.4 D29–D32 · M34-05 · C4 表驱动）
 *
 * ## 四条纪律
 *
 * 1. **数量不硬编码（C4）**：默认种子 4 个，增删由表驱动。任何「最多 4 个」的校验、
 *    或前端写死的 4 个格子，都是违背 C4 裁决本身。
 *
 * 2. **费用项默认 ¥0 不是「漏填」（C9 修订）**：集散复用合作供应商场地 → 场地费默认 0；
 *    打包改由平台兼职承担 → 打包费默认 0。科目保留仅为按实际登记与审计留痕。
 *
 * 3. **删除 ≠ 停用，删除有两道前置（D32）**：
 *    · 存在历史应付流水 → 50002：删了历史应付就没有归属
 *    · 仍被套餐分配引用（`ab_meal_assignment.distribution_center_id`）→ 50002：删了履约断链
 *    两者都指向同一出路：改用 `status=0` 停用（保留记录、退出新分配）。
 *
 * 4. **服务楼群筛选在内存做，不下推 SQL**：`service_groups` 是 JSON 数组，
 *    判断「包含某楼群」需要字符串拼接 —— `',' || x || ','` 在 SQLite 是连接、
 *    在 **MySQL 是逻辑或**（除非开 `PIPES_AS_CONCAT`），同一句 SQL 两个驱动两种语义。
 *    集散中心总量只有个位数，内存筛选既正确又不牺牲性能；表规模真要涨上来时，
 *    应改为独立关联表而不是把 JSON 当关系用。
 */
@Injectable()
export class DistributionCenterAdminService {
  private readonly logger = new Logger('DistributionCenterAdminService');

  constructor(
    @InjectRepository(DistributionCenter) private readonly dcRepo: Repository<DistributionCenter>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    @InjectRepository(BuildingGroup) private readonly groupRepo: Repository<BuildingGroup>,
    @InjectRepository(SupplierShare) private readonly shareRepo: Repository<SupplierShare>,
    @InjectRepository(MealAssignment) private readonly assignRepo: Repository<MealAssignment>,
  ) {}

  // ==========================================================================
  // D29 · 集散中心列表
  // ==========================================================================

  async list(q: AdminDistributionCentersQueryDto, viewerRole: string): Promise<DcListResult> {
    const { page, pageSize, skip } = normalizePage(q);
    const qb = this.dcRepo.createQueryBuilder('c').where('c.deleted_at IS NULL');

    if (q.status !== undefined) qb.andWhere('c.status = :st', { st: q.status });
    if (q.supplierId) qb.andWhere('c.supplier_id = :sid', { sid: q.supplierId });
    if (q.keyword) {
      const kw = `%${q.keyword}%`;
      qb.andWhere(
        '(c.name LIKE :kw OR c.address LIKE :kw OR c.supplier_id IN ' +
          '(SELECT s.id FROM ab_supplier s WHERE s.name LIKE :kw))',
        { kw },
      );
    }

    let all = await qb.clone().orderBy('c.id', 'ASC').getMany();
    // 服务楼群筛选：见文件头纪律 4（跨库语义差异，故在内存做）
    if (q.groupId) {
      const gid = q.groupId;
      all = all.filter((c) => ((c.serviceGroups ?? []) as number[]).includes(gid));
    }

    const total = all.length;
    // 排序与分页同样在内存完成：`all` 已是过滤后的全量，切片不会漏行
    const ordered = [...all].sort((a, b) => b.status - a.status || a.id - b.id);
    const rows = ordered.slice(skip, skip + pageSize);

    const supplierIds = [...new Set(all.map((c) => Number(c.supplierId)))];
    const suppliers = supplierIds.length
      ? await this.supplierRepo.find({ where: { id: In(supplierIds) } })
      : [];
    const supplierMap = new Map(suppliers.map((s) => [Number(s.id), s]));

    const groupIds = [...new Set(all.flatMap((c) => (c.serviceGroups ?? []) as number[]))];
    const groups = groupIds.length
      ? await this.groupRepo.find({ where: { id: In(groupIds) } })
      : [];
    const groupMap = new Map(groups.map((g) => [Number(g.id), g.name]));

    const ids = all.map((c) => Number(c.id));
    const [shareMap, assignMap] = await Promise.all([
      this.shareStatMap(ids),
      this.assignCountMap(ids),
    ]);

    const decorate = (c: DistributionCenter) =>
      this.decorate(c, supplierMap, groupMap, shareMap, assignMap);

    return {
      ...paginate(rows.map(decorate), total, page, pageSize),
      summary: {
        totalCount: all.length,
        activeCount: all.filter((c) => c.status === 1).length,
        suspendedCount: all.filter((c) => c.status === 0).length,
        /** 场地费 / 打包费合计（分）· C9 后默认全 0，非 0 表示按实际登记过 */
        totalRiceFeeFen: all.reduce((a, c) => a + toFen(Number(c.riceFee)), 0),
        totalPackFeeFen: all.reduce((a, c) => a + toFen(Number(c.packFee)), 0),
        /** 已服务楼群去重数（C4：一个集散中心可服务多个楼群） */
        servedGroupCount: new Set(all.flatMap((c) => (c.serviceGroups ?? []) as number[])).size,
      },
      statusOptions: [
        { value: 1, label: '启用' },
        { value: 0, label: '停用' },
      ],
      supplierOptions: suppliers
        .map((s) => ({ value: Number(s.id), label: s.name, type: s.type }))
        .sort((a, b) => a.value - b.value),
      groupOptions: groups
        .map((g) => ({ value: Number(g.id), label: g.name }))
        .sort((a, b) => a.value - b.value),
      actions: { canManage: viewerRole === 'super_admin' || viewerRole === 'admin' },
      notes: {
        c4: '集散中心**表驱动，不硬编码数量**（C4）：默认种子 4 个，可按实际增删。',
        fee: '场地费与打包费 **C9 后默认 ¥0**（复用供应商场地 / 平台兼职打包），非 0 表示按实际登记过。',
        deleteVsDisable:
          '`DELETE` 是软删（仅限从未产生结算、未被分配引用的记录）；' +
          '已有历史结算或仍被套餐分配引用时请改用停用（`PUT` 置 status=0），此时删除会被拒（50002）。',
        groupFilter:
          '`serviceGroups` 是 JSON 数组，按楼群筛选在服务端内存完成（跨库字符串连接语义不同），' +
          '对外行为与 SQL 筛选一致。',
      },
    };
  }

  // ==========================================================================
  // D30 / D31 · 新增 / 编辑
  // ==========================================================================

  async create(dto: CreateDistributionCenterDto) {
    const supplier = await this.assertSupplierCanHost(dto.supplierId);
    const saved = await this.dcRepo.save(
      this.dcRepo.create({
        name: dto.name,
        supplierId: dto.supplierId,
        address: dto.address,
        contactName: dto.contactName ?? null,
        contactPhone: dto.contactPhone ?? null,
        /** C9：默认 0 —— 不是「必须填 0」，而是「不填就是 0」 */
        riceFee: money(toYuan(dto.riceFeeFen ?? 0)),
        packFee: money(toYuan(dto.packFeeFen ?? 0)),
        serviceGroups: dto.serviceGroups ?? null,
        status: dto.status ?? 1,
      }),
    );
    this.logger.log(`新增集散中心 #${saved.id} ${saved.name}（供应商 ${supplier.name}）`);
    return {
      id: Number(saved.id),
      name: saved.name,
      supplierId: Number(saved.supplierId),
      status: saved.status,
    };
  }

  /** D31 编辑（含关联供应商与结算参数） */
  async update(id: number, dto: UpdateDistributionCenterDto) {
    const dc = await this.assertDc(id);

    if (dto.supplierId !== undefined && dto.supplierId !== Number(dc.supplierId)) {
      // 改挂主体时同样要求新主体「能承担集散」，否则集散中心会挂在纯出餐商家名下
      await this.assertSupplierCanHost(dto.supplierId);
      dc.supplierId = dto.supplierId;
    }
    if (dto.name !== undefined) dc.name = dto.name;
    if (dto.address !== undefined) dc.address = dto.address;
    if (dto.contactName !== undefined) dc.contactName = dto.contactName;
    if (dto.contactPhone !== undefined) dc.contactPhone = dto.contactPhone;
    if (dto.riceFeeFen !== undefined) dc.riceFee = money(toYuan(dto.riceFeeFen));
    if (dto.packFeeFen !== undefined) dc.packFee = money(toYuan(dto.packFeeFen));
    // ⚠️ serviceGroups 是**整体替换**语义（传什么就是什么，传空数组=清空）
    if (dto.serviceGroups !== undefined) dc.serviceGroups = dto.serviceGroups;
    if (dto.status !== undefined) dc.status = dto.status;

    dc.version += 1;
    await this.dcRepo.save(dc);
    return {
      id: Number(dc.id),
      name: dc.name,
      supplierId: Number(dc.supplierId),
      riceFeeFen: toFen(Number(dc.riceFee)),
      packFeeFen: toFen(Number(dc.packFee)),
      serviceGroups: (dc.serviceGroups ?? []) as number[],
      status: dc.status,
    };
  }

  // ==========================================================================
  // D32 · 删除（软删 · 两道前置）
  // ==========================================================================

  /**
   * D32 删除（软删）
   *
   * ⚠️ 刻意与 D31 的 `status=0` 分开两件事：
   *    · `PUT status=0` = **停用**：保留记录、退出新分配、随时可恢复 → 日常用这个
   *    · `DELETE` = **软删**：写 `deleted_at`，从此不在任何列表出现 → 仅用于「建错了」
   *    正因为两者容易混，接口在不满足条件时明确回带「请改用停用」的出路，而不是只说「不行」。
   */
  async remove(id: number) {
    const dc = await this.assertDc(id);

    const shareStat = (await this.shareStatMap([id])).get(id) ?? { count: 0, amountFen: 0 };
    if (shareStat.count > 0) {
      throw new BizException(
        ErrorCode.DISTRIBUTION_CENTER_LOCKED,
        `该集散中心已有 ${shareStat.count} 条历史应付流水，删除会使历史结算失去归属 —— ` +
          '请改用「停用」（PUT 置 status=0）：记录保留、不再参与新分配',
      );
    }

    const assignCount = await this.assignRepo.count({ where: { distributionCenterId: id } });
    if (assignCount > 0) {
      throw new BizException(
        ErrorCode.DISTRIBUTION_CENTER_LOCKED,
        `该集散中心仍被 ${assignCount} 条套餐分配引用，删除会让履约断链 —— ` +
          '请改用「停用」（PUT 置 status=0），或先解绑对应分配',
      );
    }

    dc.deletedAt = new Date();
    dc.status = 0;
    dc.version += 1;
    await this.dcRepo.save(dc);
    return { id: Number(dc.id), deleted: true, status: dc.status };
  }

  // ==========================================================================
  // 私有
  // ==========================================================================

  private async assertDc(id: number): Promise<DistributionCenter> {
    const dc = await this.dcRepo.findOne({ where: { id } });
    if (!dc || dc.deletedAt) throw new BizException(ErrorCode.DISTRIBUTION_CENTER_NOT_FOUND);
    return dc;
  }

  /**
   * 关联供应商必须是**能承担集散**的类型（`distribute` / `both`）
   *
   * 与 D27 是同一件事的两个方向：纯出餐型供应商若名下已有集散中心，不允许降级成 `dish`。
   * 两处夹逼，保证「集散中心 ↔ 供应商类型」这对关系不会自相矛盾。
   */
  private async assertSupplierCanHost(supplierId: number): Promise<Supplier> {
    const s = await this.supplierRepo.findOne({ where: { id: supplierId } });
    if (!s || s.deletedAt) throw new BizException(ErrorCode.SUPPLIER_NOT_FOUND);
    if (s.type !== SupplierType.DISTRIBUTE && s.type !== SupplierType.BOTH) {
      throw new BizException(
        ErrorCode.SUPPLIER_TYPE_CONFLICT,
        `供应商「${s.name}」当前为出餐型，不能挂载集散中心 —— 请先用 D27 设为集散型或混合型`,
      );
    }
    return s;
  }

  private decorate(
    c: DistributionCenter,
    supplierMap: Map<number, Supplier>,
    groupMap: Map<number, string>,
    shareMap: Map<number, ShareStat>,
    assignMap: Map<number, number>,
  ) {
    const id = Number(c.id);
    const supplierId = Number(c.supplierId);
    const groups = (c.serviceGroups ?? []) as number[];
    const riceFeeFen = toFen(Number(c.riceFee));
    const packFeeFen = toFen(Number(c.packFee));
    const share = shareMap.get(id) ?? { count: 0, amountFen: 0 };
    const assignCount = assignMap.get(id) ?? 0;

    return {
      id,
      name: c.name,
      supplierId,
      supplierName: supplierMap.get(supplierId)?.name ?? null,
      supplierType: supplierMap.get(supplierId)?.type ?? null,
      address: c.address,
      contactName: c.contactName ?? null,
      contactPhone: c.contactPhone ?? null,
      riceFeeFen,
      riceFeeYuan: toYuan(riceFeeFen).toFixed(2),
      packFeeFen,
      packFeeYuan: toYuan(packFeeFen).toFixed(2),
      serviceGroups: groups,
      serviceGroupNames: groups.map((g) => groupMap.get(g) ?? `#${g}`),
      serviceGroupCount: groups.length,
      status: c.status,
      statusLabel: c.status === 1 ? '启用' : '停用',
      /** 历史应付**笔数**（决定能否删除）*/
      shareCount: share.count,
      /** 历史应付**金额**（分）—— 与笔数是两件事，别共用同一个值 */
      shareAmountFen: share.amountFen,
      assignCount,
      /** 能否安全删除（两道前置都为空）——端上据此禁用「删除」按钮 */
      canDelete: share.count === 0 && assignCount === 0,
    };
  }

  /** 历史应付统计（笔数 + 金额），一次 group by 取回 */
  private async shareStatMap(ids: number[]): Promise<Map<number, ShareStat>> {
    const map = new Map<number, ShareStat>();
    if (!ids.length) return map;
    const rows = await this.shareRepo
      .createQueryBuilder('s')
      .select('s.payee_id', 'payeeId')
      .addSelect('COUNT(*)', 'cnt')
      .addSelect('SUM(s.amount)', 'amount')
      .where('s.payee_type = :t', { t: PAYEE_DC })
      .andWhere('s.payee_id IN (:...ids)', { ids })
      .groupBy('s.payee_id')
      .getRawMany<{ payeeId: number | string; cnt: number | string; amount: string | number }>();
    for (const r of rows) {
      map.set(Number(r.payeeId), { count: Number(r.cnt), amountFen: toFen(Number(r.amount)) });
    }
    return map;
  }

  /** 被套餐分配引用的条数（D32 的前置判据，列表先透出便于运营预判） */
  private async assignCountMap(ids: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!ids.length) return map;
    const rows = await this.assignRepo
      .createQueryBuilder('a')
      .select('a.distribution_center_id', 'dcId')
      .addSelect('COUNT(*)', 'cnt')
      .where('a.distribution_center_id IN (:...ids)', { ids })
      .groupBy('a.distribution_center_id')
      .getRawMany<{ dcId: number | string; cnt: number | string }>();
    for (const r of rows) map.set(Number(r.dcId), Number(r.cnt));
    return map;
  }
}
