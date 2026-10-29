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

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CouponService } from './coupon.service';
import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import {
  UpsertCouponDefReqDto,
  UpdateCouponDefReqDto,
  GrantCouponReqDto,
  GrantCouponBatchReqDto,
  RevokeCouponReqDto,
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

  // ------------------------------------------------------------ 批量发放 / 回收

  /**
   * 批量发放（2026-10-29）
   *
   * ⭐ **先试算、后实发**：`dryRun: true` 走与实发完全相同的路径（人群解析 / 幂等 /
   *    限量校验都跑），只差最后写库一步。端上把「命中多少人、跳过多少、未匹配哪些号码」
   *    摆出来给运营看，**看完再按确认** —— 批量发券是「一次几十张、发出即承诺」的动作，
   *    没有这一步，金额填错一个零就是几十份既成事实。
   *
   * ⚠️ 幂等：带同一个 `idempotencyKey` 重复提交 = 同一批，已发过的用户自动跳过
   *    （真正的最后一道闸是数据库唯一索引 `uk_user_coupon_batch_user`）。
   */
  @Post('grant-batch')
  @OperationLog({ module: 'coupon', action: '批量发放代金券' })
  @ApiOperation({
    summary: '批量发放（dryRun=true 仅试算；带 idempotencyKey 可重复提交而不重发）',
    description:
      '人群：all / building / phones / userIds。试算与实发同路径，结果含命中数、跳过数、未匹配号码、脱敏样例。',
  })
  grantBatch(@Body() dto: GrantCouponBatchReqDto) {
    return this.couponService.grantBatch({
      scope: dto.scope,
      buildingId: dto.buildingId ?? null,
      phones: dto.phones,
      userIds: dto.userIds,
      couponDefId: dto.couponDefId ?? null,
      name: dto.name,
      faceValueFen: dto.faceValueFen,
      thresholdFen: dto.thresholdFen ?? 0,
      validityType: dto.validityType,
      validDays: dto.validDays ?? null,
      validFrom: dto.validFrom ?? null,
      validTo: dto.validTo ?? null,
      obtainedFrom: dto.obtainedFrom ?? 'manual',
      remark: dto.remark,
      dryRun: dto.dryRun === true,
      idempotencyKey: dto.idempotencyKey ?? null,
      excludeBlacklist: dto.excludeBlacklist !== false,
    });
  }

  /**
   * 回收一张券（批量发券的兜底 · 2026-10-29）
   *
   * ⭐ 只有**未使用**的券可撤（判据纯函数 `canRevoke`）：已核销的券已被订单用作抵扣，
   *    撤掉等于让那笔订单白拿优惠。已回收的券重复点击 → 幂等返回成功。
   */
  @Post('grants/:id/revoke')
  @OperationLog({ module: 'coupon', action: '回收代金券' })
  @ApiOperation({
    summary: '回收代金券（仅未使用的可撤，不可撤销已核销的券）',
    description:
      '回收原因进操作日志（不占业务表列）；券行保留并置 revoked，用户端显示为「已回收」。',
  })
  revoke(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RevokeCouponReqDto,
    @CurrentAdmin('sub') operatorId: number,
  ) {
    return this.couponService.revokeCoupon(id, operatorId);
  }
}
