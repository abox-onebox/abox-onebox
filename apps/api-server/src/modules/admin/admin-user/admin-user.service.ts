import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { KvService } from '../../../common/cache/kv.service';
import { ROLE_LABEL, adminRevokeKey, menusOf } from '../../../common/constants/admin-role';
import { ErrorCode } from '../../../common/constants/error-code';
import { BizException } from '../../../common/exceptions/biz.exception';
import { hashPassword } from '../../../common/utils/password';
import { normalizePage, paginate } from '../../../common/utils/response';
import { Supplier } from '../../../database/entities/supplier.entity';
import { AdminUser } from '../../../database/entities/system.entity';
import { AdminAccountQueryDto, CreateAdminUserDto, UpdateAdminUserDto } from '../dto/admin.dto';

/** 账号对外视图（**永不包含 passwordHash**） */
export interface AdminAccountItem {
  id: number;
  username: string;
  name: string;
  role: string;
  roleLabel: string;
  supplierId: number | null;
  supplierName: string | null;
  phone: string | null;
  status: number;
  statusText: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  /** 该角色可见的菜单 key（账号管理页直接预览权限，省得靠记） */
  menus: string[];
}

/**
 * 后台账号服务 · D51 列表 / D52 新增 / D53 编辑停用
 *
 * 三条**防自锁**规则（都返回 20010 ADMIN_ACCOUNT_PROTECTED）：
 *   ① 不能停用自己            —— 否则当场把自己关在门外
 *   ② 不能降级自己            —— 同上（角色改掉后连账号管理菜单都消失）
 *   ③ 不能停用 / 降级**最后一个启用的 super_admin** —— 否则没有任何人能再管账号，
 *      只能改数据库救场。①②③ 都在服务端判定，不依赖前端把按钮置灰。
 *
 * 另：**改角色或停用后写 KV 吊销标记**，`AdminGuard` 据此让旧令牌立即失效
 *    （否则最长有 12 小时的特权滞留窗口，见 admin-role.ts 注释）。
 */
@Injectable()
export class AdminUserService {
  private readonly logger = new Logger('AdminUserService');

  constructor(
    @InjectRepository(AdminUser) private readonly adminRepo: Repository<AdminUser>,
    @InjectRepository(Supplier) private readonly supplierRepo: Repository<Supplier>,
    private readonly kv: KvService,
  ) {}

  /** D51 账号列表 */
  async list(q: AdminAccountQueryDto) {
    const { page, pageSize, skip } = normalizePage(q);

    const qb = this.adminRepo.createQueryBuilder('a').orderBy('a.id', 'ASC');
    if (q.role) qb.andWhere('a.role = :role', { role: q.role });
    if (q.status) qb.andWhere('a.status = :status', { status: q.status });
    if (q.keyword) {
      qb.andWhere('(a.username LIKE :kw OR a.realName LIKE :kw OR a.phone LIKE :kw)', {
        kw: `%${q.keyword}%`,
      });
    }

    const [rows, total] = await qb.skip(skip).take(pageSize).getManyAndCount();
    const names = await this.supplierNames(rows.map((r) => r.supplierId));

    return paginate(
      rows.map((r) => this.toItem(r, names)),
      total,
      page,
      pageSize,
    );
  }

  /** D52 新增账号 */
  async create(dto: CreateAdminUserDto): Promise<AdminAccountItem> {
    const username = dto.username.trim();

    const exists = await this.adminRepo.findOne({ where: { username } });
    if (exists) throw new BizException(ErrorCode.ADMIN_USERNAME_TAKEN);

    if (dto.role === 'supplier' && !dto.supplierId) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        'role=supplier 时必须指定 supplierId（否则该账号登录后看不到任何数据）',
      );
    }
    if (dto.supplierId) await this.assertSupplier(dto.supplierId);

    const saved = await this.adminRepo.save(
      this.adminRepo.create({
        username,
        passwordHash: hashPassword(dto.password),
        realName: dto.realName ?? null,
        role: dto.role,
        supplierId: dto.role === 'supplier' ? (dto.supplierId ?? null) : null,
        phone: dto.phone ?? null,
        status: 1,
      }),
    );

    this.logger.log(`新增后台账号 #${saved.id} ${username} role=${dto.role}`);
    return this.toItem(saved, await this.supplierNames([saved.supplierId]));
  }

  /** D53 编辑 / 停用 */
  async update(id: number, dto: UpdateAdminUserDto, operatorId: number): Promise<AdminAccountItem> {
    const target = await this.adminRepo.findOne({ where: { id } });
    if (!target) throw new BizException(ErrorCode.NOT_FOUND, '账号不存在');

    const willDemote = !!dto.role && dto.role !== target.role;
    const willDisable = dto.status === 2 && target.status === 1;
    const roleChanged = willDemote || willDisable;

    // ① / ② 不能停用或降级自己
    if (id === operatorId && (willDemote || willDisable)) {
      throw new BizException(
        ErrorCode.ADMIN_ACCOUNT_PROTECTED,
        '不能停用或降级当前登录的账号（否则将立即失去后台访问权）',
      );
    }

    // ③ 必须保留至少一个启用的超级管理员
    const losesSuper =
      target.role === 'super_admin' &&
      target.status === 1 &&
      ((!!dto.role && dto.role !== 'super_admin') || willDisable);
    if (losesSuper && (await this.countActiveSuperAdmins()) <= 1) {
      throw new BizException(
        ErrorCode.ADMIN_ACCOUNT_PROTECTED,
        '不能停用或降级最后一个启用的超级管理员（否则将无人可管理账号）',
      );
    }

    if (dto.supplierId) await this.assertSupplier(dto.supplierId);

    const nextRole = dto.role ?? target.role;
    if (nextRole === 'supplier' && !(dto.supplierId ?? target.supplierId)) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'role=supplier 时必须保留 supplierId');
    }

    const patch: Partial<AdminUser> = {};
    if (dto.realName !== undefined) patch.realName = dto.realName;
    if (dto.role !== undefined) patch.role = dto.role;
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.supplierId !== undefined) patch.supplierId = dto.supplierId;
    // 角色从 supplier 换走后清掉绑定，避免残留脏关联
    if (dto.role !== undefined && dto.role !== 'supplier') patch.supplierId = null;

    await this.adminRepo.save({ ...target, ...patch });
    const fresh = await this.adminRepo.findOne({ where: { id } });
    if (!fresh) throw new BizException(ErrorCode.NOT_FOUND, '账号不存在');

    if (roleChanged) {
      // 旧令牌立即作废
      await this.kv.set(adminRevokeKey(id), String(Date.now()));
      this.logger.warn(`账号 #${id} 权限已变更（操作人 #${operatorId}），旧令牌已吊销`);
    }

    return this.toItem(fresh, await this.supplierNames([fresh.supplierId]));
  }

  // ------------------------------------------------------------------ 内部

  private async countActiveSuperAdmins(): Promise<number> {
    return this.adminRepo.count({ where: { role: 'super_admin', status: 1 } });
  }

  private async assertSupplier(supplierId: number): Promise<void> {
    const s = await this.supplierRepo.findOne({ where: { id: supplierId } });
    if (!s) throw new BizException(ErrorCode.PARAM_INVALID, '指定的供应商不存在');
  }

  /** 批量取供应商名（避免 N+1） */
  private async supplierNames(ids: Array<number | null | undefined>): Promise<Map<number, string>> {
    const uniq = [...new Set(ids.filter((v): v is number => typeof v === 'number' && v > 0))];
    if (uniq.length === 0) return new Map();
    const rows = await this.supplierRepo.find({ where: uniq.map((id) => ({ id })) });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private toItem(a: AdminUser, names: Map<number, string>): AdminAccountItem {
    return {
      id: a.id,
      username: a.username,
      name: a.realName ?? a.username,
      role: a.role,
      roleLabel: ROLE_LABEL[a.role] ?? a.role,
      supplierId: a.supplierId ?? null,
      supplierName: a.supplierId ? (names.get(a.supplierId) ?? null) : null,
      phone: a.phone ?? null,
      status: a.status,
      statusText: a.status === 1 ? '启用' : '停用',
      lastLoginAt: a.lastLoginAt ?? null,
      createdAt: a.createdAt,
      menus: menusOf(a.role),
    };
  }
}
