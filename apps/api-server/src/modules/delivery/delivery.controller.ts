import { Body, Controller, Get, Param, ParseIntPipe, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { DeliveryService } from './delivery.service';
import { DeliveryListQueryDto, DeliveryPatchDto } from './dto/delivery.dto';

/**
 * 运营后台 · 配送单（M5-1 · D61 查看 / D62 人工修正）
 *
 * ## 为什么需要它（挂账 #61）
 * `DeliveryService.generateByDate()` 对已存在的 `(meal_date, building_group_id)` 行
 * **跳过不覆盖** —— 理由正当（司机 / 车牌是人工录入的，跑批抹掉就找不回来），
 * 但代价是 `total_quantity` **也被一起冻住**：截单跑晚、或补跑改过份数之后，
 * 表里的份数与实际要送的份数会**长期不一致且没有任何页面能改** ——
 * 这个口子此前只存在 DBA 手里。本控制器把它收回到运营后台。
 *
 * ## 两级白名单
 * · 类级**含** `operator` —— 配送单是运营的日常作业（要打电话叫车、要填司机车牌），
 *   不能看就不能干活。
 * · **不含** `viewer` —— 只读观察者仅看板；配送单涉及运力与司机电话，
 *   与 D47–D50（看板刻意含 viewer）正好相反。
 * · **不含** `finance` —— 菜单矩阵里财务没有这一页。若 API 放行而菜单没有，
 *   会变成「能调但进不去」的诡异状态（与 P39「加工场所打包」同一纪律）。
 *
 * ## 与配送单生成的关系
 * 生成（跑批 `delivery-generate`）与修正**不是同一件事**，也**不是同一个口**：
 * 跑批走 `ScheduleService.run()`，修正走本控制器。两者共用
 * `DeliveryService.aggregateOrderQuantity()` 一份份数口径 —— 不另写第二套，
 * 杜绝「生成的份数」与「页面上显示的应送份数」不一致而**两边都不报错**。
 *
 * ## 为什么只有 GET 与 PUT
 * · 不提供 `POST`（配送单由跑批生成，不手工建 —— 手工建单会绕过
 *   截单定格的份数口径，造出一张与订单脱钩的单）。
 * · 不提供 `DELETE`（删单一会让当日配送链缺一个楼群且**无任何痕迹**；
 *   份数改成 0 才是「这个楼群今天不送」的正确表达）。
 */
@ApiTags('后台·配送单')
@ApiBearerAuth()
@Controller('admin/deliveries')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get()
  @ApiOperation({
    summary: '配送单列表（D61）',
    description:
      '按 `date`（出餐日，缺省取**最近一个有配送单的出餐日**）列出各楼群的配送单，' +
      '并给出「配送单份数 vs 按订单算出的份数」的差异。\n\n' +
      '`quantityMismatch=true` 只表示**份数与订单不符**，不等同「被人改过」——' +
      '成因有两种（人工修正 / 截单后订单侧退款取消），系统不假装能区分，' +
      '排查入口见出参 `note` 与 `ab_operation_log`（`module=delivery`）。\n\n' +
      '`hasManualInput=true` 则是**可靠**标记：司机 / 电话 / 车牌 / 备注四列' +
      '跑批从不写，有值即说明有人手工填过。\n\n' +
      '每行附 `version`（乐观锁）—— 提交 D62 时**原样回传**。\n\n' +
      '没有任何配送单时返回 `date=null` + `reason`（HTTP 200）：' +
      '「还没有单」是正常状态，不是错误。',
  })
  list(@Query() q: DeliveryListQueryDto) {
    return this.delivery.listByDate(q);
  }

  @Put(':id')
  @OperationLog({ module: 'delivery', action: '修正配送单', targetParam: 'id' })
  @ApiOperation({
    summary: '配送单人工修正（D62）',
    description:
      '只允许改 **份数 / 司机 / 司机电话 / 车牌 / 备注** —— **不含配送状态**' +
      '（履约流转属独立批次，混进「改数字」会让审计分不清「改数」与「推进履约」）。\n\n' +
      '`version` 与 `reason` **均为必填**：\n' +
      '· `version` 是乐观锁 —— 两个运营先后改同一张单时，后写者若用旧快照' +
      '会把前者的修改一起覆盖回去，且**双方都不报错**，直到装错货；\n' +
      '· `reason` 是审计要求 —— 份数「5 → 3」必须能回答为什么。' +
      '它**不写进 `remark`**（那是给配送员看的备注），而是随请求体进操作日志。\n\n' +
      '提交了但与现值相同的字段进 `unchanged[]` 且**不写库**（不产生假变更记录）；' +
      '若全部相同则连 `version` 都不推进。\n\n' +
      '`version` 不匹配 → `30016`，出参 `data.current` 带当前值与版本，' +
      '端上刷新后重提即可；目标 id 不存在 → `30017`。',
  })
  patch(@Param('id', ParseIntPipe) id: number, @Body() dto: DeliveryPatchDto) {
    return this.delivery.patch(id, dto);
  }
}
