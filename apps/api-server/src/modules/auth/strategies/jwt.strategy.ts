import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { JwtPayload } from '../../../common/decorators/auth.decorator';

/**
 * JWT 校验策略
 * 全局 JwtAuthGuard 依赖本策略；载荷结构见 common/decorators/auth.decorator.ts
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('app.jwtSecret'),
    });
  }

  /** 校验通过后挂到 req.user */
  validate(payload: JwtPayload): JwtPayload {
    return payload;
  }
}
