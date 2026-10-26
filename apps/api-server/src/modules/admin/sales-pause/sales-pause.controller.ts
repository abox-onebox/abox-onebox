import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../../common/decorators/auth.decorator';
import type { JwtPayload } from '../../../common/decorators/auth.decorator';
import { OperationLog } from '../../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { CreateSalesPauseDto } from './dto/sales-pause.dto';
import { SalesPauseService } from './sales-pause.service';

/**
 * W1 · 全局一键停售（ADR-N1N2W1 · 2026-10-26）
 *
 * 三个端点：
 *   · `GET    /admin/sales-pause`          列表（含历史，带 `resumedAt`）
 *   · `POST   /admin/sales-pause`          创建停售区间
 *   · `POST   /admin/sales-pause/:id/resume` 恢复（打 `resumedAt` / `resumedBy`）
 *
 * ## 权限
 * 类级放开到 `operator`（一线客服需要**看到**当前是不是在停售，这是回答用户
 * 「为什么订不了」的第一手依据）；两个写端点方法级收窄到 `super_admin`/`admin`
 * （停售会直接切断全站收入，属高危动作，不给 operator）。
 *
 * ## ⭐ 为什么写端点都带 `@OperationLog`
 *
 * 停售 = **全站收入归零**的开关。谁在什么时候停了哪几天、谁又提前恢复了 ——
 * 这是事后唯一能回答「昨天下午为什么一单都没有」的地方。两个写端点都留痕，
 * `GET` 不标（全局拦截器的既有约定：只标写操作，否则列表接口会刷爆日志表）。
 *
 * ## ⚠️ 停售**不影响**存量订单与套餐编排
 *
 * 本模块只写 `ab_sales_pause` 这一行数据，**不做**批量取消 / 退款 / 冻结状态机
 * （spec §7.6 第 5 条：存量订单的状态与佣金不受影响）。
 *
 * ## ⚠️ 出参形态：裸数组
 *
 * `GET` 直接返回 `SalesPauseRow[]`，**不套** `{ list: [...] }`。
 * 与 `modules/admin/operation-request` 的 `fetchOperationRequests` 同形 ——
 * 本表不分页，套信封只会让调用方多一层 `res.list` 且**编译期看不出来**
 * （`http.get<T>` 只解包业务信封，不解包自定义信封）。
 */
@ApiTags('border-全局停售')
@ApiBearerAuth()
@Controller('admin/sales-pause')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class SalesPauseController {
  constructor(private readonly svc: SalesPauseService) {}

  @Get()
  @ApiOperation({
    summary: '停售区间列表（含历史）',
    description:
      '`resumedAt` 为 null 表示**仍生效**；非 null 为已恢复的历史记录。\n\n' +
      '⚠️ 出参是**裸数组**（不套 `{ list }`），与 `/admin/operation-requests` 同形。',
  })
  list() {
    return this.svc.list();
  }

  @Post()
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'system', action: '创建全局停售区间' })
  @ApiOperation({
    summary: '创建停售区间（立刻生效）',
    description:
      '区间两端**含首尾**，`mealDateFrom === mealDateTo` 表示只停一天。' +
      '写入后用户端**立刻**不可下单（直查，无缓存）。',
  })
  create(@Body() dto: CreateSalesPauseDto, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.create(dto, actor);
  }

  @Post(':id/resume')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'system', action: '恢复全局停售', targetParam: 'id' })
  @ApiOperation({ summary: '恢复指定停售区间（打 resumedAt，不删行）' })
  resume(@Param('id', ParseIntPipe) id: number, @CurrentAdmin() actor: JwtPayload) {
    return this.svc.resume(id, actor);
  }
}
