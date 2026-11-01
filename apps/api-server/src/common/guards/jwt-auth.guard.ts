import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { ErrorCode } from '../constants/error-code';
import { IS_PUBLIC_KEY, JwtPayload, SubjectType } from '../decorators/auth.decorator';
import { BizException } from '../exceptions/biz.exception';

/**
 * 全局 JWT 守卫
 *   默认所有接口都需要登录；用 @Public() 放行（登录、健康检查、支付回调等）
 *
 * ⚠️ **双主体隔离（M3 引入）** —— 本守卫是唯一的隔离点，理由见 auth.decorator.ts：
 *    · `/admin/*`、`/supplier/*` → 只接受 `typ='admin'` 的 token
 *    · 其余全部端点（小程序 U/L 系列） → 只接受 `typ!=='admin'` 的 token
 *
 *    为什么不写成常量集合/装饰器：**漏写即越权**。此处按路径前缀判定，
 *    `/supplier/*` 与 `/admin/*` 任一新控制器自动被覆盖，不需要任何人记得加注解。
 *    （代价：路径样式变了要同步改 `ADMIN_SCOPE`，已在 e2e 中双向断言。）
 *
 *    另外 `rt=true` 的刷新令牌**不可用于业务端点**，只能走 `/auth/refresh`。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  /** 后台作用域路径：`/api/v1/admin/…` 或 `/api/v1/supplier/…` */
  private static readonly ADMIN_SCOPE = /^\/(?:api\/v\d+\/)?(?:admin|supplier)(?:\/|$)/;

  /**
   * **主体无关**端点：两种 token 都收，由 controller 按 `typ` 分流。
   * `/auth/profile`（A5）与 `/auth/logout`（A4）在《接口规范》里本就是
   * 「小程序返回 user；后台返回 account」的双主体契约，故不做单边拦截。
   */
  private static readonly EITHER_SCOPE = /^\/(?:api\/v\d+\/)?auth\/(?:profile|logout)(?:\/|$)/;

  constructor(private readonly reflector: Reflector) {
    super();
  }

  /** 该请求属于哪套账号体系（仅按路径判定，不看 token） */
  private scopeOf(url: string): SubjectType {
    const path = url.split('?')[0];
    return JwtAuthGuard.ADMIN_SCOPE.test(path) ? 'admin' : 'user';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const passed = await (super.canActivate(context) as Promise<boolean>);
    if (!passed) return false;

    const req = context.switchToHttp().getRequest<{
      user?: JwtPayload;
      originalUrl?: string;
      url?: string;
    }>();

    const payload = req.user;
    // typ 缺省 = 'user'：M1/M2 签发的旧 token 只可能是用户 token
    const typ: SubjectType = payload?.typ ?? 'user';
    const url = req.originalUrl ?? req.url ?? '';

    // 刷新令牌只能换新令牌，不能当访问令牌用
    if (payload?.rt) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '刷新令牌不能用于业务接口');
    }

    // 双主体端点：不按路径判归属（controller 内按 typ 分流）
    if (JwtAuthGuard.EITHER_SCOPE.test(url.split('?')[0])) return true;

    const scope = this.scopeOf(url);

    if (scope === 'admin' && typ !== 'admin') {
      throw new BizException(ErrorCode.FORBIDDEN, '该接口仅限后台账号访问');
    }
    if (scope === 'user' && typ === 'admin') {
      throw new BizException(ErrorCode.UNAUTHORIZED, '后台账号请使用后台接口');
    }

    return true;
  }

  handleRequest<TUser = JwtPayload>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new BizException(ErrorCode.UNAUTHORIZED);
    }
    return user;
  }
}
