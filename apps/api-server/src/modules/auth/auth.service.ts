import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { TeamLeader } from '../../database/entities/leader.entity';
import { User } from '../../database/entities/user.entity';
import { WX_MINI_PROVIDER, WxMiniProvider } from '../../providers/wx-mini/wx-mini.provider';
import { LoginDto } from './dto/login.dto';

/**
 * 登录服务
 *
 * 关键身份模型（v4.7.8）：**用户与团长共用同一小程序身份**
 *   —— ab_user 是唯一身份；团长只是叠加在 user 上的第二身份（ab_team_leader）。
 *   因此登录只建/查用户，isLeader 作为附加状态返回，前端据此决定是否显示团长 tab。
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @Inject(WX_MINI_PROVIDER) private readonly wxMini: WxMiniProvider,
    private readonly jwt: JwtService,
  ) {}

  /** 微信登录：code → openid → 查/建用户 → 签发 JWT */
  async login(dto: LoginDto) {
    const session = await this.wxMini.code2Session(dto.code);

    let user = await this.userRepo.findOne({ where: { openid: session.openid } });
    let isNewUser = false;

    if (!user) {
      user = await this.userRepo.save(
        this.userRepo.create({
          openid: session.openid,
          unionid: session.unionid ?? null,
          nickname: dto.nickname ?? '微信用户',
          avatarUrl: dto.avatarUrl ?? null,
          status: 1,
        }),
      );
      isNewUser = true;
      this.logger.log(`新用户注册 id=${user.id}（${this.wxMini.isMock ? 'mock' : 'real'} 通道）`);
    } else if (user.status === 2) {
      throw new BizException(ErrorCode.USER_DISABLED);
    }

    const leader = await this.leaderRepo.findOne({ where: { userId: user.id } });
    const isLeader = !!leader && leader.status === 1;

    const token = await this.jwt.signAsync({
      sub: user.id,
      openid: user.openid,
      isLeader,
      teamLeaderId: leader?.id ?? null,
    });

    return {
      token,
      isNewUser,
      isLeader,
      user: {
        id: user.id,
        nickname: user.nickname ?? null,
        avatarUrl: user.avatarUrl ?? null,
        phone: user.phone ?? null,
        buildingId: user.buildingId ?? null,
        teamLeaderId: user.teamLeaderId ?? null,
      },
      leader: leader
        ? {
            id: leader.id,
            level: leader.level,
            commissionRate: leader.commissionRate,
            balance: leader.balance,
          }
        : null,
    };
  }

  /** 当前登录用户资料 */
  async profile(userId: number) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BizException(ErrorCode.USER_NOT_FOUND);

    const leader = await this.leaderRepo.findOne({ where: { userId } });

    return {
      id: user.id,
      nickname: user.nickname ?? null,
      avatarUrl: user.avatarUrl ?? null,
      phone: user.phone ?? null,
      buildingId: user.buildingId ?? null,
      teamLeaderId: user.teamLeaderId ?? null,
      isLeader: !!leader && leader.status === 1,
      leader: leader
        ? {
            id: leader.id,
            level: leader.level,
            commissionRate: leader.commissionRate,
            balance: leader.balance,
            totalOrders: leader.totalOrders,
            totalCommission: leader.totalCommission,
          }
        : null,
    };
  }
}
