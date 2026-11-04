import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CouponModule } from '../coupon/coupon.module';
import { WecomKbController } from './wecom-kb.controller';
import { WecomKbService } from './wecom-kb.service';
import { WecomCryptoService } from './wecom-crypto.service';
import { WecomTokenService } from './wecom-token.service';
import { OpProxyService } from './op-proxy.service';
import { WecomBindingService } from './wecom-binding.service';
import { WecomSvcTokenService } from './wecom-svc-token.service';
import { NameResolverService } from './name-resolver.service';
import { WecomChatService } from './wecom-chat.service';
import { WecomBindingAdminController } from './wecom-binding.admin.controller';
import { WecomOpsAdminController } from './wecom-ops.admin.controller';
import { WecomSimulateController } from './wecom-simulate.admin.controller';
import { LaunchDraftAdminController } from './launch-draft.admin.controller';
import { AiInsightAdminController } from './ai-insight.admin.controller';
import { RecallCampaignAdminController } from './recall-campaign.admin.controller';
import { WecomBinding } from './wecom-binding.entity';
import { AiInsightService } from './ai-insight.service';
import { RecallCampaignService } from './recall-campaign.service';
import { AiInsight } from '../../database/entities';

/**
 * 企业微信对话机器人（KB 助手移动化 · 路线 B）
 *
 * 依赖：无跨模块依赖，独立成模块。注册进 AppModule 即生效。
 * 凭据（WECOM_*）缺失时模块照常加载，仅 WXBizMsgCrypt 自检 warn、收发消息在具体调用时报错——
 * 不阻塞启动（与「生产禁 mock」等硬闸解耦，因为这是功能模块不是安全模型开关）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([WecomBinding, AiInsight]), CouponModule],
  controllers: [
    WecomKbController,
    WecomBindingAdminController,
    WecomOpsAdminController,
    WecomSimulateController,
    // 开团草稿后台页（#1 批 4）：路径是 `admin/meal/*`，但复用本模块的 WecomChatService —— 见该文件头注
    LaunchDraftAdminController,
    // AI 台账（ab_ai_insight）：15 个 AI 节点的产出可回看/可标记
    AiInsightAdminController,
    // 复购 / 流失主动唤醒闭环（#C）：复用 CouponService 批量发券 + 负责人企微知会
    RecallCampaignAdminController,
  ],
  providers: [
    WecomKbService,
    WecomCryptoService,
    WecomTokenService,
    OpProxyService,
    WecomBindingService,
    WecomSvcTokenService,
    NameResolverService,
    WecomChatService,
    // AI 产出留档（ab_ai_insight）：WecomChatService 写、后台台账页读
    AiInsightService,
    // 复购 / 流失主动唤醒（#C）
    RecallCampaignService,
  ],
  exports: [WecomBindingService],
})
export class WecomKbModule {}
