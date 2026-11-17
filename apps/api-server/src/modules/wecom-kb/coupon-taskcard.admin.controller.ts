import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { CouponTaskcardService } from './coupon-taskcard.service';
import type { CouponStrategyCard } from '../../common/utils/coupon-taskcard';

/** 单张策略卡的确认决策 */
export class CouponCardDecisionDto {
  @ApiProperty({
    description: '策略类型（四类之一）',
    enum: ['newCustomer', 'sleepWake', 'buildingTarget', 'repurchase'],
  })
  @IsString()
  @IsIn(['newCustomer', 'sleepWake', 'buildingTarget', 'repurchase'])
  kind!: string;

  @ApiProperty({ description: 'approve=确认出执行清单 / skip=跳过', enum: ['approve', 'skip'] })
  @IsIn(['approve', 'skip'])
  decision!: 'approve' | 'skip';

  @ApiPropertyOptional({
    description:
      'generate 返回的原卡（approve 时必填；服务端实时复核后沿用其预算文案/理由，金额以实时券种为准）',
  })
  @IsOptional()
  @IsObject()
  card?: Record<string, unknown>;
}

export class ConfirmCouponCardsDto {
  @ApiProperty({ type: [CouponCardDecisionDto], description: '逐卡决策列表' })
  @IsArray()
  @ArrayNotEmpty()
  decisions!: CouponCardDecisionDto[];

  @ApiPropertyOptional({ description: '操作人（后台账号名；优先取 JWT）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorName?: string;
}

/**
 * 后台 · 发券策略卡（AI 编排节点 H · 安全版）
 *
 * ## 闭环
 * 结构化策略卡（只读生成）→ 运营逐卡确认 → 出「可执行发券清单」+ 记台账 →
 * 人拿清单去后台「批量发券」页自己确认执行。
 *
 * ## 安全版硬边界（祝总 2026-11-17 拍板）
 * 本控制器**没有真发券动作**：不调 grantBatch / createDef / grant，不建券种、不写业务表。
 * 系统只吐清单 + 记台账；真发券入口仍只有券管理页那一处，不新增第三个发券入口。
 *
 * ## 权限口径（与 G / M 一致）
 * - generate 只读，operator 可看策略卡（类级 @Roles 含 operator）。
 * - confirm 是人工闸、且只出清单不真发，方法级 @Roles 仍收紧到 super_admin/admin。
 */
@Controller('admin/coupon-taskcard')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class CouponTaskcardAdminController {
  constructor(private readonly svc: CouponTaskcardService) {}

  /** 生成（只读，零副作用）：实时取数 → AI 策略卡草稿 */
  @Post('generate')
  @ApiOperation({
    summary: 'H 生成发券策略卡（只读，不写库、不发券；operator 可看）',
    description:
      '基于近30天留存/楼栋/现有券种，AI 出四类发券策略卡（面额门槛以实时券种为准）。' +
      '脚本缺失/超时降级（degraded=true），绝不 500。',
  })
  generate() {
    return this.svc.generate();
  }

  /** 逐卡确认（人工闸，仅负责人）：实时复核 → 出执行清单 + 记台账，不真发券 */
  @Post('confirm')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'coupon', action: 'H 发券策略卡逐卡确认（只出清单不真发）' })
  @ApiOperation({
    summary: 'H 逐卡确认发券策略卡（人工闸，仅负责人；不真发券）',
    description:
      '实时复核券种是否仍 active / 楼是否仍在名单，通过后产出「scope+券种#id+面额门槛+试算人群」' +
      '执行清单并记台账。系统绝不发券、绝不建券种；真发券由人拿清单去券管理页确认。同 kind 同日幂等。',
  })
  confirm(@Body() dto: ConfirmCouponCardsDto, @CurrentAdmin() admin: JwtPayload | undefined) {
    return this.svc.confirm({
      decisions: dto.decisions.map((d) => ({
        kind: d.kind,
        decision: d.decision,
        // DTO 宽松接收；service 的 revalidateCouponCard 会逐字段复核，非法卡被挡
        card: d.card as CouponStrategyCard | undefined,
      })),
      actorId: admin?.sub ?? null,
      actorName: admin?.username ?? dto.actorName ?? null,
    });
  }
}
