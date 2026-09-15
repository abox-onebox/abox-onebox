import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LeaderStatus } from '@abox/shared-types';

import { TeamLeader } from '../../database/entities/leader.entity';
import { ErrorCode } from '../constants/error-code';
import { JwtPayload } from '../decorators/auth.decorator';
import { BizException } from '../exceptions/biz.exception';

/** 携带团长档案的请求对象（由本守卫注入 `req.leader`） */
export interface LeaderRequest {
  user?: JwtPayload;
  leader?: TeamLeader;
}

/**
 * 团长身份守卫 —— **二次校验**，用于全部 `/leader/*` 端点
 *
 * 依据《接口规范》§1.5「团长身份判定纪律」：
 *   `auth.guard` 解析 JWT 后**必须再查一次 `ab_team_leader`**，确认在职且办公楼匹配，
 *   **禁止仅凭 JWT 内的 `isLeader` 放行** —— 因为 JWT 有效期 7 天，期间团长可能被
 *   停职（后台停用 / 见习 30 天未促单自动取消，C2），只信 token 会放行已失效身份。
 *
 * 两种失败语义分开（端上处理不同）：
 *   · 查无记录         → `10003` 无权限（他从来不是团长）
 *   · 有记录但已停职   → `20003` 团长身份已失效（引导重新申请）
 *
 * 用法：`@UseGuards(LeaderGuard)` + `@CurrentLeader()` 取档案。
 *   ⚠️ 必须与 `@Public()` 互斥 —— 本守卫依赖 `req.user`，跳过 JWT 时无从取值。
 */
@Injectable()
export class LeaderGuard implements CanActivate {
  constructor(@InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<LeaderRequest>();
    const payload = req.user;

    if (!payload?.sub) {
      throw new BizException(ErrorCode.UNAUTHORIZED);
    }

    const leader = await this.leaderRepo.findOne({ where: { userId: payload.sub } });

    if (!leader) {
      throw new BizException(ErrorCode.FORBIDDEN, '仅团长可访问该接口');
    }
    if (leader.status !== LeaderStatus.ACTIVE) {
      throw new BizException(ErrorCode.LEADER_DISQUALIFIED);
    }

    req.leader = leader;
    return true;
  }
}
