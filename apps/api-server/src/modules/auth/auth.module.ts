import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Building } from '../../database/entities/building.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { AdminUser } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { TeamLeaderModule } from '../team-leader/team-leader.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

/** 鉴权模块 · 见《接口规范 v1.0》§二（A1–A5）与《目录结构 v2.0》 */
@Module({
  imports: [
    /** ⚠️ M5-10 补 `Building`：A2 资料要出 `buildingName`（P8 个人中心） */
    TypeOrmModule.forFeature([User, TeamLeader, AdminUser, Building]),
    /**
     * ⭐ M5-11 补 `TeamLeaderModule`：登录链路要落**邀请关系**（`LeaderInviteService`），
     *    这是「扫码进来的人归谁」那条路径唯一的写点（缺陷 #92）。
     *    ⚠️ 方向是 Auth → TeamLeader，**单向**：`TeamLeaderModule` 只 import `MessageModule`，
     *    不成环（环会让 Nest 在启动时报 `Nest cannot create the module instance`）。
     *    ⚠️ `LeaderLookupService` **不在这里 import** —— 它注册在 `@Global` 的
     *    `CommonModule` 并已 exports，全局可直接注入。
     */
    TeamLeaderModule,
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
