import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { money, toFen, toYuan } from '../../common/utils/money';
import { normalizePage, paginate, PageResult } from '../../common/utils/response';
import { BuildingGroup } from '../../database/entities/building.entity';
import { DistributionCenter, SupplierShare } from '../../database/entities/finance.entity';
import { MealAssignment } from '../../database/entities/meal.entity';
import {
  AdminDistributionCentersQueryDto,
  CreateDistributionCenterDto,
  UpdateDistributionCenterDto,
} from './dto/distribution-center-admin.dto';

/** 分账流水的集散主体类型（`ab_supplier_share.payee_type`）—— **仅用于识别历史应付行** */
const PAYEE_DC = 'distribution_center';

type DcListResult = PageResult<Record<string, unknown>> & {
  summary: Record<string, unknown>;
  statusOptions: Array<Record<string, unknown>>;
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
 * 后台 · 集散中心（= **ABox 自有加工 / 出餐场所**）配置服务
 * （M3-6 · 《接口规范》§6.4 D29–D32 · M34-05 · C4 表驱动 · 自营口径 M4-0）
 *
 * ## 五条纪律
 *
 * 1. **数量不硬编码（C4）**：默认种子 4 个，增删由表驱动。任何「最多 4 个」的校验、
 *    或前端写死的 4 个格子，都是违背 C4 裁决本身。
 *
 * 2. ⭐ **本表就是 ABox 自己的加工场所，不归属任何合作供应商**（M4-0 自营口径）：
 *    `supplier_id` 已停用（列保留为历史字段）—— 故 D29 **不再有「按供应商筛选」与
 *    `supplierOptions`**，D30/D31 **不再收 `supplierId`**，原先的
 *    `SUPPLIER_TYPE_CONFLICT`(50008) 三处闸门前提出自于此，一并删除。
 *    ⚠️ 这不是「少了一个筛选条件」，而是「**一个自营下不成立的关系被摘掉了**」：
 *    留着它，运营会以为还能把场所挂到某家供应商名下。
 *
 * 3. **费用项默认 ¥0 的含义是「未登记」，不是「免费」**（C9 + 自营口径）：
 *    场地摊销 / 打包人工 / 配送费都是 ABox **自身履约成本**，**不出付款单**，
 *    但没登记时经营毛利会被**系统性高估**（D47–D50 看板须显式提示）。
 *    科目保留仅为按实际登记与审计留痕。
 *
 * 4. **删除 ≠ 停用，删除有两道前置（D32）**：
 *    · 存在历史应付流水 → 50002：删了历史应付就没有归属
 *    · 仍被套餐分配引用（`ab_meal_assignment.distribution_center_id`）→ 50002：删了履约断链
 *    两者都指向同一出路：改用 `status=0` 停用（保留记录、退出新分配）。
 *
 * 5. **服务楼群筛选在内存做，不下推 SQL**：`service_groups` 是 JSON 数组，
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
    if (q.keyword) {
      const kw = `%${q.keyword}%`;
      // ⚠️ 关键词**只搜场所自身**（名 / 地址）。自营前这里还联了「关联供应商名」——
      //    那是「按场地找供应商」的入口，而场所已不归属供应商，该入口无从谈起。
      qb.andWhere('(c.name LIKE :kw OR c.address LIKE :kw)', { kw });
    }

    let all = await qb.clone().orderBy('c.id', 'ASC').getMany();
    // 服务楼群筛选：见文件头纪律 5（跨库语义差异，故在内存做）
    if (q.groupId) {
      const gid = q.groupId;
      all = all.filter((c) => ((c.serviceGroups ?? []) as number[]).includes(gid));
    }

    const total = all.length;
    // 排序与分页同样在内存完成：`all` 已是过滤后的全量，切片不会漏行
    const ordered = [...all].sort((a, b) => b.status - a.status || a.id - b.id);
    const rows = ordered.slice(skip, skip + pageSize);

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

    const decorate = (c: DistributionCenter) => this.decorate(c, groupMap, shareMap, assignMap);

    return {
      ...paginate(rows.map(decorate), total, page, pageSize),
      summary: {
        totalCount: all.length,
        activeCount: all.filter((c) => c.status === 1).length,
        suspendedCount: all.filter((c) => c.status === 0).length,
        /** 场地摊销 / 打包人工合计（分）· 默认全 0 = **未登记**，非 0 才表示按实际登记过 */
        totalRiceFeeFen: all.reduce((a, c) => a + toFen(Number(c.riceFee)), 0),
        totalPackFeeFen: all.reduce((a, c) => a + toFen(Number(c.packFee)), 0),
        /** 已服务楼群去重数（C4：一个场所可服务多个楼群） */
        servedGroupCount: new Set(all.flatMap((c) => (c.serviceGroups ?? []) as number[])).size,
      },
      statusOptions: [
        { value: 1, label: '启用' },
        { value: 0, label: '停用' },
      ],
      groupOptions: groups
        .map((g) => ({ value: Number(g.id), label: g.name }))
        .sort((a, b) => a.value - b.value),
      actions: { canManage: viewerRole === 'super_admin' || viewerRole === 'admin' },
      notes: {
        semantics:
          '⚠️ 本表 = **ABox 自有加工 / 出餐场所**（半成品在此热加工后打包配送），' +
          '**不归属任何合作供应商**。自营前的「关联供应商」字段已停用，列表不再展示、' +
          '新增/编辑不再收取 —— 若仍需按供应商找场地，那是自营前的关系，不再成立。',
        c4: '数量**表驱动，不硬编码**（C4）：默认种子 4 个，可按实际增删。',
        fee:
          '场地摊销与打包人工**默认 ¥0 的含义是「未登记」而非「免费」** —— ' +
          '它们是 ABox 自身履约成本、不出付款单，但未登记时经营毛利会被系统性高估' +
          '（见 P35 看板提示）。',
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
    const saved = await this.dcRepo.save(
      this.dcRepo.create({
        name: dto.name,
        /** 历史字段：新场所**不再归属任何供应商**（自营下场所属 ABox 自己） */
        supplierId: null,
        address: dto.address,
        contactName: dto.contactName ?? null,
        contactPhone: dto.contactPhone ?? null,
        /** 默认 0 —— 不是「必须填 0」，而是「不填就是未登记」 */
        riceFee: money(toYuan(dto.riceFeeFen ?? 0)),
        packFee: money(toYuan(dto.packFeeFen ?? 0)),
        serviceGroups: dto.serviceGroups ?? null,
        status: dto.status ?? 1,
      }),
    );
    this.logger.log(`新增加工场所 #${saved.id} ${saved.name}`);
    return {
      id: Number(saved.id),
      name: saved.name,
      status: saved.status,
    };
  }

  /** D31 编辑（含结算参数） */
  async update(id: number, dto: UpdateDistributionCenterDto) {
    const dc = await this.assertDc(id);

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
   * ⚠️ **本方法已随自营口径删除**（M4-0）。原逻辑：与 D27 夹逼，保证
   * 「集散中心 ↔ 供应商类型」这对关系不自相矛盾。自营下场所属 ABox 自有、
   * 供应商也不再有类型，这对关系整体不存在 → 校验点与 50008 号位一并停用。
   */

  private decorate(
    c: DistributionCenter,
    groupMap: Map<number, string>,
    shareMap: Map<number, ShareStat>,
    assignMap: Map<number, number>,
  ) {
    const id = Number(c.id);
    const groups = (c.serviceGroups ?? []) as number[];
    const riceFeeFen = toFen(Number(c.riceFee));
    const packFeeFen = toFen(Number(c.packFee));
    const share = shareMap.get(id) ?? { count: 0, amountFen: 0 };
    const assignCount = assignMap.get(id) ?? 0;

    return {
      id,
      name: c.name,
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
