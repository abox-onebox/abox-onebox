import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

/**
 * 登录主体类型（M3 引入）
 *
 * 一期有两套**完全独立**的账号体系，共用同一个 `Authorization: Bearer` 头与同一个
 * JwtStrategy，靠载荷里的 `typ` 区分：
 *   user  —— 小程序用户（ab_user，含叠加的团长身份），由 `POST /auth/login` 签发
 *   admin —— 后台账号（ab_admin_user，运营 + 供应商），由 `POST /auth/admin-login` 签发
 *
 * ⚠️ **为什么必须显式区分**：两边 `sub` 各自自增，`ab_user.id = 7` 与
 *    `ab_admin_user.id = 7` 会撞号。若不做隔离，后台 token 拿到小程序端点会被
 *    当成「另一个用户 7」，反之亦然 —— 这是越权而非报错，最难发现。
 *    隔离点集中在 `JwtAuthGuard`（见该文件），不依赖各 controller 自觉。
 */
export type SubjectType = 'user' | 'admin';

/** JWT 载荷（登录后签发，见 auth.service.adminLogin / login） */
export interface JwtPayload {
  /** 主体 ID：typ=user → ab_user.id；typ=admin → ab_admin_user.id */
  sub: number;
  /** 主体类型；**缺省视为 'user'**（兼容 M1/M2 已签发的旧 token） */
  typ?: SubjectType;
  /** 是否刷新令牌（typ=admin 的 refreshToken 为 true，不可用于业务端点） */
  rt?: boolean;
  /** 微信 openid（仅 typ=user） */
  openid?: string;
  /** 是否团长（叠加身份，非独立账号；仅 typ=user） */
  isLeader?: boolean;
  /** 所属团长 ID（用于业绩归属；仅 typ=user） */
  teamLeaderId?: number | null;
  /** 后台角色（仅 typ=admin）：super_admin/admin/operator/finance/viewer/supplier */
  role?: string;
  /** 后台账号登录名（仅 typ=admin，用于日志与展示） */
  username?: string;
  /** 供应商账号绑定的 ab_supplier.id（仅 typ=admin 且 role=supplier） */
  supplierId?: number | null;
  /** 签发时间（JWT 标准声明，秒）。用于与吊销标记比对（见 admin-role.ts） */
  iat?: number;
  /** 过期时间（JWT 标准声明，秒） */
  exp?: number;
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

// ---------------------------------------------------------------------------
// 后台（role=admin / supplier）专用
// ---------------------------------------------------------------------------

export const ADMIN_ROLES_KEY = 'abox:adminRoles';

/**
 * 限定后台端点可访问的角色（不写 = 任意已登录后台账号可访问）。
 *
 * ⚠️ 与小程序团长的 `LeaderGuard` 语义不同：这里是**角色白名单**，
 *    且必须先通过 `AdminGuard`（typ=admin）才有 `role` 可比。
 */
export const Roles = (...roles: string[]) => SetMetadata(ADMIN_ROLES_KEY, roles);

/** 取当前登录后台账号（由 AdminGuard 注入 req.admin） */
export const CurrentAdmin = createParamDecorator(
  (field: keyof JwtPayload | undefined, ctx: ExecutionContext): JwtPayload | unknown => {
    const req = ctx.switchToHttp().getRequest<{ admin?: JwtPayload }>();
    const admin = req.admin as JwtPayload;
    return field ? admin?.[field] : admin;
  },
);
