import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

/** JWT 载荷（登录后签发，见 auth.service.ts） */
export interface JwtPayload {
  /** 用户 ID（ab_user.id） */
  sub: number;
  /** 微信 openid */
  openid: string;
  /** 是否团长（叠加身份，非独立账号） */
  isLeader: boolean;
  /** 所属团长 ID（用于业绩归属） */
  teamLeaderId?: number | null;
}

export const IS_PUBLIC_KEY = 'abox:isPublic';

/** 标记接口为公开（跳过全局 JWT 守卫） */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** 取当前登录用户（由 JwtStrategy 注入 req.user） */
export const CurrentUser = createParamDecorator(
  (field: keyof JwtPayload | undefined, ctx: ExecutionContext): JwtPayload | unknown => {
    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const user = req.user as JwtPayload;
    return field ? user?.[field] : user;
  },
);
