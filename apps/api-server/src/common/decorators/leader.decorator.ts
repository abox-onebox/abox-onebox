import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { TeamLeader } from '../../database/entities/leader.entity';
import { LeaderRequest } from '../guards/leader.guard';

/**
 * 取当前登录团长的档案（`ab_team_leader` 记录）
 *
 * 前置：控制器/方法需已挂 `@UseGuards(LeaderGuard)` —— 档案由该守卫查库后注入。
 * 支持取字段：`@CurrentLeader('id')` —— 少写一行 `leader.id`。
 *
 * ⚠️ 与 `@CurrentUser()` 的区别：`@CurrentUser()` 取 **JWT 载荷**（含可能过期的
 *    `isLeader`）；`@CurrentLeader()` 取 **库中实时档案**（已由守卫校验在职）。
 *    `/leader/*` 端点一律用后者。
 */
export const CurrentLeader = createParamDecorator(
  (field: keyof TeamLeader | undefined, ctx: ExecutionContext): TeamLeader | unknown => {
    const req = ctx.switchToHttp().getRequest<LeaderRequest>();
    const leader = req.leader as TeamLeader;
    return field ? leader?.[field] : leader;
  },
);
