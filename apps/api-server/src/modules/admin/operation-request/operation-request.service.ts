import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { AdminUser, OperationRequest } from '../../../database/entities/system.entity';
import type { JwtPayload } from '../../../common/decorators/auth.decorator';
import { CreateOperationRequestDto, OperationRequestQueryDto } from './dto/operation-request.dto';

/**
 * 阶段 3 · 高危审批申请单服务
 *
 * ## 执行机制（两步）
 * 1. approve 仅把状态置 `approved`（不执行）。
 * 2. execute 才**复用原目标接口**：容器内向 `http://localhost:PORT/PREFIX/admin/...`
 *    自调用，带一枚为审批人 mint 的短效 admin 令牌 + 从申请单回填的 `X-KB-*` 头
 *    （base64 编码，复用 B3 审计）。
 *    ⇒ 原控制器的 `@Roles`、`@OperationLog` 拦截器全部命中，业务零重复、审计不丢。
 *
 * ## op → 端点映射（服务端权威，前端不可改）
 */
const OP_ENDPOINTS: Record<string, { method: 'POST' | 'PUT'; path: string }> = {
  create_dish: { method: 'POST', path: '/admin/dishes' },
  batch_dish_status: { method: 'POST', path: '/admin/dishes/batch-status' },
  edit_dish: { method: 'PUT', path: '/admin/dishes/:id' },
  change_leader: { method: 'PUT', path: '/admin/leaders/:id' },
  appoint_leader: { method: 'POST', path: '/admin/leaders' },
  leader_audit: { method: 'POST', path: '/admin/leaders/:id/audit' },
  send_message: { method: 'POST', path: '/admin/messages/orchestrate' },
  manual_adjust: { method: 'POST', path: '/admin/orders/manual-adjust' },
  force_refund: { method: 'POST', path: '/admin/orders/:orderNo/force-refund' },
};

const OP_LABELS: Record<string, string> = {
  create_dish: '上架新菜品',
  batch_dish_status: '批量上下架菜品',
  edit_dish: '编辑菜品',
  change_leader: '变更团长（等级/楼/层）',
  appoint_leader: '任命/转交团长',
  leader_audit: '团长资质补录（停职/恢复/补签）',
  send_message: '群发运营通知',
  manual_adjust: '手动改单（改份数/改取餐楼）',
  force_refund: '强制退款（原路退 + 反向结算）',
};

@Injectable()
export class OperationRequestService {
  constructor(
    @InjectRepository(OperationRequest)
    private readonly repo: Repository<OperationRequest>,
    @InjectRepository(AdminUser)
    private readonly adminRepo: Repository<AdminUser>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateOperationRequestDto, actor: JwtPayload): Promise<OperationRequest> {
    if (!OP_ENDPOINTS[dto.opCode]) throw new BadRequestException('op_code 不在可审批范围');
    const entity = this.repo.create({
      opCode: dto.opCode,
      opLabel: OP_LABELS[dto.opCode] ?? dto.opCode,
      risk: 'admin',
      params: dto.params,
      status: 'pending',
      submitterKb: dto.submitterKb ?? null,
      submitterAdminId: actor?.sub ?? null,
      submitterNl: dto.submitterNl ?? null,
      submitterOpBlock: dto.submitterOpBlock ?? null,
    });
    return this.repo.save(entity);
  }

  async list(query: OperationRequestQueryDto, actor: JwtPayload): Promise<OperationRequest[]> {
    const qb = this.repo.createQueryBuilder('r');
    // operator 只能看自己提交的（最小权限；admin 看全部）
    if (actor?.role === 'operator') {
      qb.where('r.submitter_admin_id = :me', { me: actor.sub });
    }
    if (query.status) qb.andWhere('r.status = :s', { s: query.status });
    if (query.opCode) qb.andWhere('r.op_code = :o', { o: query.opCode });
    qb.orderBy('r.id', 'DESC');
    return qb.getMany();
  }

  async detail(id: number, actor: JwtPayload): Promise<OperationRequest> {
    const r = await this.repo.findOne({ where: { id } });
    if (!r) throw new NotFoundException('申请单不存在');
    if (actor?.role === 'operator' && r.submitterAdminId !== actor.sub) {
      throw new ForbiddenException('仅能查看自己提交的单');
    }
    return r;
  }

  async approve(id: number, actor: JwtPayload): Promise<OperationRequest> {
    return this.repo.manager.transaction(async (m) => {
      const r = await m.findOne(OperationRequest, {
        where: { id },
      });
      if (!r) throw new NotFoundException('申请单不存在');
      if (r.status !== 'pending') {
        throw new BadRequestException(`仅 pending 可审批（当前 ${r.status}）`);
      }
      r.status = 'approved';
      r.approverId = actor.sub;
      r.approvedAt = new Date();
      return m.save(r);
    });
  }

  async reject(id: number, reason: string, actor: JwtPayload): Promise<OperationRequest> {
    return this.repo.manager.transaction(async (m) => {
      const r = await m.findOne(OperationRequest, {
        where: { id },
      });
      if (!r) throw new NotFoundException('申请单不存在');
      if (r.status !== 'pending') {
        throw new BadRequestException(`仅 pending 可驳回（当前 ${r.status}）`);
      }
      r.status = 'rejected';
      r.rejectReason = reason;
      r.approverId = actor.sub;
      r.approvedAt = new Date();
      return m.save(r);
    });
  }

  /**
   * 执行已审批的申请：复用原目标接口（容器内 HTTP 自调用）。
   * 失败时不改状态（保留 approved 供重试），但把错误回执写入 snapshot。
   */
  async execute(id: number, actor: JwtPayload): Promise<OperationRequest> {
    const r = await this.repo.findOne({ where: { id } });
    if (!r) throw new NotFoundException('申请单不存在');
    if (r.status !== 'approved') {
      throw new BadRequestException(`仅 approved 可执行（当前 ${r.status}）`);
    }
    const ep = OP_ENDPOINTS[r.opCode];
    if (!ep) throw new BadRequestException('未知 op 端点');

    const admin = await this.adminRepo.findOne({ where: { id: actor.sub } });
    if (!admin) throw new NotFoundException('审批人账号不存在');

    // 为审批人 mint 一枚短效 admin 令牌（供内部调用原目标接口走真实鉴权）
    const token = await this.jwt.signAsync(
      {
        sub: admin.id,
        typ: 'admin' as const,
        role: admin.role,
        username: admin.username,
        supplierId: admin.supplierId ?? null,
      },
      { expiresIn: '5m' },
    );

    const port = this.config.get<number>('app.port') ?? 3000;
    const prefix = this.config.get<string>('app.apiPrefix') ?? '/api/v1';
    const params = (r.params ?? {}) as Record<string, unknown>;
    // 路径参数（:id / :orderNo 等）从 params 回填 URL，并从 body 剔除（避免重复传）
    const pathKeys: string[] = [];
    const url = `http://localhost:${port}${prefix}${ep.path}`.replace(
      /:([a-zA-Z_][a-zA-Z0-9_]*)/g,
      (_m, key: string) => {
        pathKeys.push(key);
        return encodeURIComponent(String((params as Record<string, unknown>)[key] ?? ''));
      },
    );
    const body: Record<string, unknown> = { ...params };
    for (const k of pathKeys) delete body[k]; // 路径参数不进 body

    // B3 三字段从申请单回填，base64(UTF-8) 编码（fetch 头不允许非 Latin1）
    const b64 = (s?: string | null): string => (s ? Buffer.from(s, 'utf8').toString('base64') : '');
    const opBlock = (r.submitterOpBlock ?? {
      op: r.opCode,
      params: r.params,
    }) as Record<string, unknown>;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-KB-Operator': b64(r.submitterKb ?? admin.realName ?? admin.username),
      'X-KB-NL': b64(r.submitterNl ?? `阶段3审批执行：${r.opLabel}`),
      'X-KB-OpBlock': b64(JSON.stringify({ ...opBlock, requestId: r.id })),
    };

    let resp: Response;
    let text: string;
    try {
      resp = await fetch(url, {
        method: ep.method,
        headers,
        body: JSON.stringify(body),
      });
      text = await resp.text();
    } catch (e) {
      throw new BadRequestException(`执行内部调用失败：${(e as Error).message}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 1000) };
    }

    if (!resp.ok) {
      r.snapshot = { ok: false, status: resp.status, body: json };
      await this.repo.save(r);
      throw new BadRequestException(`执行失败(${resp.status})：${text.slice(0, 500)}`);
    }

    r.status = 'executed';
    r.executedAt = new Date();
    r.snapshot = { ok: true, status: resp.status, body: json, requestId: r.id };
    return this.repo.save(r);
  }
}
