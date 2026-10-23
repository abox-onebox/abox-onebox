import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CouponService } from './coupon.service';
import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import {
  UpsertCouponDefReqDto,
  UpdateCouponDefReqDto,
  GrantCouponReqDto,
  GrantQueryDto,
} from './dto/coupon.dto';

/**
 * 后台 · 代金券管理（《接口规范》§6.7 · 独立券系统）
 *
 * 路径统一挂在 `admin/coupon/*` —— `AdminGuard` 全局兜底鉴权（见 `admin.module.ts` 头注：
 * 路径写错前缀会让鉴权静默失效）。
 *
 * 端点：券种定义 CRUD（D 系新增）+ 手动发券（客服补偿）+ 核券记录。
 */
@ApiTags('后台·代金券')
@ApiBearerAuth()
@Controller('admin/coupon')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class CouponAdminController {
  constructor(private readonly couponService: CouponService) {}

  // ------------------------------------------------------------ 券种定义

  @Get('defs')
  @ApiOperation({ summary: '券种定义列表' })
  defs() {
    return this.couponService.listDefs();
  }

  @Post('defs')
  @OperationLog({ module: 'coupon', action: '创建券种定义' })
  @ApiOperation({ summary: '创建券种定义' })
  createDef(@Body() dto: UpsertCouponDefReqDto) {
    return this.couponService.createDef(dto);
  }

  @Put('defs/:id')
  @OperationLog({ module: 'coupon', action: '更新券种定义' })
  @ApiOperation({
    summary: '更新券种定义（仅状态 / 备注 / 限量；面额、有效期不可改）',
    description: '面额、有效期不可改，避免影响已发放券的核销口径。',
  })
  updateDef(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCouponDefReqDto) {
    return this.couponService.updateDef(id, {
      status: dto.status,
      remark: dto.remark,
      totalLimit: dto.totalLimit,
    });
  }

  // ------------------------------------------------------------ 发券 / 记录

  @Post('grant')
  @OperationLog({ module: 'coupon', action: '手动发券' })
  @ApiOperation({
    summary: '手动发放（客服补偿 / 指定用户）',
    description: 'userId 与 userPhone 二选一；可关联券种定义（回写 issuedCount / 限量校验）。',
  })
  async grant(@Body() dto: GrantCouponReqDto) {
    let userId: number | null = dto.userId ?? null;
    if (!userId && !dto.userPhone) {
      // 「两个都没给」= 参数不合法（运营改输入即可）
      throw new BizException(ErrorCode.PARAM_INVALID, '请提供 userId 或 userPhone');
    }
    if (!userId && dto.userPhone) {
      userId = await this.couponService.resolveUserByPhone(dto.userPhone);
      if (!userId) {
        // 「给了手机号但查无此人」= 号码错了（与上面刻意分开：动作是核对号码，不是补参数）
        throw new BizException(ErrorCode.USER_NOT_FOUND, `手机号 ${dto.userPhone} 未绑定任何用户`);
      }
    }
    // 上面两条分支已保证「到这里必然是 number」，但 TS 收不窄 `number | null`，显式取值
    const resolvedUserId: number = userId as number;
    return this.couponService.grant({
      userId: resolvedUserId,
      couponDefId: dto.couponDefId ?? null,
      name: dto.name,
      faceValueFen: dto.faceValueFen,
      thresholdFen: dto.thresholdFen ?? 0,
      validityType: dto.validityType,
      validDays: dto.validDays ?? null,
      validFrom: dto.validFrom ?? null,
      validTo: dto.validTo ?? null,
      obtainedFrom: dto.obtainedFrom ?? 'manual',
      remark: dto.remark ?? null,
    });
  }

  @Get('grants')
  @ApiOperation({ summary: '发放记录（核券记录）' })
  grants(@Query() q: GrantQueryDto) {
    return this.couponService.listGrants({
      obtainedFrom: q.obtainedFrom,
      userId: q.userId,
    });
  }
}
