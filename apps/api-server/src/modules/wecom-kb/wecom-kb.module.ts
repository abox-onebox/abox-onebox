import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WecomKbController } from './wecom-kb.controller';
import { WecomKbService } from './wecom-kb.service';
import { WecomCryptoService } from './wecom-crypto.service';
import { WecomTokenService } from './wecom-token.service';
import { OpProxyService } from './op-proxy.service';
import { WecomBindingService } from './wecom-binding.service';
import { WecomBindingAdminController } from './wecom-binding.admin.controller';
import { WecomBinding } from './wecom-binding.entity';

/**
 * 企业微信对话机器人（KB 助手移动化 · 路线 B）
 *
 * 依赖：无跨模块依赖，独立成模块。注册进 AppModule 即生效。
 * 凭据（WECOM_*）缺失时模块照常加载，仅 WXBizMsgCrypt 自检 warn、收发消息在具体调用时报错——
 * 不阻塞启动（与「生产禁 mock」等硬闸解耦，因为这是功能模块不是安全模型开关）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([WecomBinding])],
  controllers: [WecomKbController, WecomBindingAdminController],
  providers: [WecomKbService, WecomCryptoService, WecomTokenService, OpProxyService, WecomBindingService],
  exports: [WecomBindingService],
})
export class WecomKbModule {}
