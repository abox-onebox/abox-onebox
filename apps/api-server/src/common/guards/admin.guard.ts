import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { KvService } from '../cache/kv.service';
import { ADMIN_ROLES_KEY, JwtPayload } from '../decorators/auth.decorator';
import { adminRevokeKey } from '../constants/admin-role';
import { ErrorCode } from '../constants/error-code';
import { BizException } from '../exceptions/biz.exception';

/**
 * 后台守卫（运营 + 供应商共用）
 *
 * 前提：全局 `JwtAuthGuard` 已跑过（`/admin/*`、`/supplier/*` 只放行 `typ='admin'`），
 * 因此这里只补三件事：
 *   1. 断言主体确为后台账号 → 把载荷挂到 `req.admin`，供 `@CurrentAdmin()` 取用
 *   2. **令牌吊销校验** —— 改角色 / 停用账号后旧令牌立即失效（见 admin-role.ts）
 *   3. 校验 `@Roles(...)` 白名单（不写注解 = 任意后台角色可访问）
 *
 * ⚠️ **供应商隔离靠 `@Roles('supplier')` + 服务层 supplierId，不靠路径**：
 *    供应商账号（role=supplier）能进 `/admin/*` 会直接拿到全平台数据，
 *    所以运营端点必须显式声明 `@Roles('super_admin','admin','operator', …)`；
 *    供应商端点声明 `@Roles('supplier')` 并在 service 内用 `supplierId` 收窄数据范围。
 *    `@Roles()` 空注解的运营端点 = 默认对所有后台角色开放，这是**有意**的（如 A5 profile）。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly kv: KvService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      user?: JwtPayload;
      admin?: JwtPayload;
    }>();

    const payload = req.user;
    if (!payload || payload.typ !== 'admin') {
      throw new BizException(ErrorCode.FORBIDDEN, '该接口仅限后台账号访问');
    }

    // 吊销校验：令牌签发时间早于最后一次「改角色 / 停用」→ 立即失效
    const revokedAt = Number((await this.kv.get(adminRevokeKey(payload.sub))) ?? 0);
    if (revokedAt > 0 && (payload.iat ?? 0) * 1000 < revokedAt) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '账号权限已变更，请重新登录');
    }

    req.admin = payload;

    const roles = this.reflector.getAllAndOverride<string[]>(ADMIN_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (roles && roles.length > 0 && !roles.includes(payload.role ?? '')) {
      throw new BizException(ErrorCode.FORBIDDEN);
    }

    return true;
  }
}
