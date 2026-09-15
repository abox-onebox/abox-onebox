import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { ErrorCode } from '../constants/error-code';
import { IS_PUBLIC_KEY, JwtPayload } from '../decorators/auth.decorator';
import { BizException } from '../exceptions/biz.exception';

/**
 * 全局 JWT 守卫
 *   默认所有接口都需要登录；用 @Public() 放行（登录、健康检查、支付回调等）
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<TUser = JwtPayload>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new BizException(ErrorCode.UNAUTHORIZED);
    }
    return user;
  }
}
