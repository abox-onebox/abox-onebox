import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiCsController } from './ai-cs.controller';
import { AiCsService } from './ai-cs.service';
import { SysConfig } from '../../database/entities/system.entity';

/**
 * C 端智能客服（D · #44）
 *
 * 轻模块：仅依赖 `ab_config`（读 124 号令公示配置）与纯函数 `common/utils/ai-cs`。
 * 不接 LLM、不写库、不跨业务模块依赖，独立成模块，注册进 AppModule 即生效。
 */
@Module({
  imports: [TypeOrmModule.forFeature([SysConfig])],
  controllers: [AiCsController],
  providers: [AiCsService],
  exports: [AiCsService],
})
export class AiCsModule {}
