import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { AdminUser, OperationRequest } from '../../../database/entities/system.entity';
import { OperationRequestController } from './operation-request.controller';
import { OperationRequestService } from './operation-request.service';

/**
 * 阶段 3 · 高危审批模块
 *
 * ⚠️ `ConfigService` 来自 `@Global()` 的 `AppConfigModule`，故 JwtModule.registerAsync
 *    直接 inject 即可（与 auth.module 同款）；本模块不重复 import ConfigModule。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OperationRequest, AdminUser]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('app.jwtSecret'),
        signOptions: { expiresIn: cfg.get<string>('app.jwtExpiresIn') ?? '7d' },
      }),
    }),
  ],
  controllers: [OperationRequestController],
  providers: [OperationRequestService],
  exports: [OperationRequestService],
})
export class OperationRequestModule {}
