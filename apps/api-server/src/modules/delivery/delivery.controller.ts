import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { IdempotentInterceptor } from '../../common/interceptors/idempotent.interceptor';
import { DeliveryService } from './delivery.service';
import {
  DeliveryListQueryDto,
  DeliveryPatchDto,
  DeliveryStatusAdvanceDto,
} from './dto/delivery.dto';

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
 * ## 为什么只有 GET / PUT / PATCH
 * · 不提供 `POST`（配送单由跑批生成，不手工建 —— 手工建单会绕过
 *   截单定格的份数口径，造出一张与订单脱钩的单）。
 * · 不提供 `DELETE`（删单一会让当日配送链缺一个楼群且**无任何痕迹**；
 *   份数改成 0 才是「这个楼群今天不送」的正确表达）。
 * · ⭐ **改数字（PUT `:id`）与推进履约（PATCH `:id/status`）刻意分成两个动作**
 *   —— M5-1 刻意把 `status` 挡在 D62 之外，M5-8 才补上 D63。合成一个端点会让
 *   「份数 5→3 顺便把状态也推了」变成一条记录两件事，审计上分不清责任。
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

  // ---------------------------------------------------------- D63 状态推进

  @Patch(':id/status')
  @UseInterceptors(IdempotentInterceptor)
  @Idempotent({ scope: 'delivery-status', required: false })
  @OperationLog({ module: 'delivery', action: '推进配送状态', targetParam: 'id' })
  @ApiOperation({
    summary: 'D63 配送单状态推进（履约流转 · 联动订单状态机 T8 / T9）',
    description:
      '配送单是 `pending → called → en_route → arrived` 的**单向**履约流，只能向前推进，' +
      '**且一次只能一步**（回退 / 跳级 / 原地 → `30018`，出参 `allowed` 给出**唯一**可推进到的状态）。\n\n' +
      '⚠️ 「一次只能一步」不是为了多收几次点击，而是因为**每一步各自联动订单**：' +
      '跳级（如 `pending → arrived`）会让 T8 被跳过、只跑 T9，而 T9 的条件更新是' +
      '`delivering → delivered` —— 订单此刻还在 `cooked`，条件不命中 ⇒ **一单都不会动，' +
      '且不报任何错**（正是本批要收口的 #79 的形状）。要补记已发生的过程，请逐步补按。\n\n' +
      '⭐ **推进配送状态会联动订单状态**（这正是此前后端缺失的一环）：\n' +
      '· `called`（已叫车）→ **订单不动**（货还在加工场所，订单要到「配送中」才该动）；\n' +
      '· `en_route`（货拉拉发出）→ 该楼群订单 `cooked → delivering`（状态机 T8）；\n' +
      '· `arrived`（送达楼下）→ 该楼群订单 `delivering → delivered` 并写 `actual_at`（状态机 T9）。\n' +
      '订单「送达」之后，T10 团长一键分发 / T11 14:00 自动确认兜底**才可达** —— ' +
      '而佣金正是在那两处产生。此前订单会永远停在 `cut_off`，且**不报任何错**。\n\n' +
      '`version` 乐观锁与 D62 同机制同错误码（`30016`，附 `current`）。\n' +
      '`note` 可选（如「堵车晚点 20 分钟」），写入操作日志。\n\n' +
      '⚠️ **订单联动是「尽力而为 + 如实报告」而非「要么全成要么全败」**：物理上不会因为' +
      '系统里订单状态不对就不发车，故能推的推、推不动的如实计进 `orderTransition.remaining`' +
      '（哪个状态还有几单）并给一句可照着排查的 `note` —— **不静默跳过**。\n\n' +
      '⚠️ T9 的「取餐通知（团长）」一期走**微信群人工发**（场景 `leader_delivery` 的渠道' +
      '就是微信群，订阅消息渠道属二期）—— 本接口**不假装已推送**，出参 `note` 明确写出。',
  })
  advanceStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeliveryStatusAdvanceDto,
    @CurrentAdmin('sub') operatorId: number,
  ) {
    return this.delivery.advanceStatus(id, dto, operatorId);
  }
}
