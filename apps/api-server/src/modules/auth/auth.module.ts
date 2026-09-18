import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { AdminUser } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/** 鉴权模块 · 见《接口规范 v1.0》§二（A1–A5）与《目录结构 v2.0》 */
@Module({
  imports: [
    /** ⚠️ M5-10 补 `Building`：A2 资料要出 `buildingName`（P8 个人中心） */
    TypeOrmModule.forFeature([User, TeamLeader, AdminUser, Building]),
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('app.jwtSecret'),
        signOptions: { expiresIn: cfg.get<string>('app.jwtExpiresIn') ?? '7d' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
