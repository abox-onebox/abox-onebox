import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/auth.decorator';
import { TraceabilityTodayQueryDto } from './dto/traceability.dto';
import { TraceabilityService } from './traceability.service';

/**
 * 今日这盒 · 商家溯源（**U5** · 原型 P38 · M5-14）
 *
 * ## 为何是 `@Public()`
 * 《接口规范 v1.0》§1.1 明确「首页、溯源可匿名只读」—— 溯源页是**信任证据页**，
 * 它的说服力恰恰来自「不必登录也能查」。若要求登录，微信审核与首次来客都看不到，
 * 这一页就失去了存在意义。
 *
 * ## 代价与应对
 * `@Public()` 让守卫**直接放行、不注入 `req.user`**（见 `jwt-auth.guard.ts`），
 * 于是服务端不知道调用者是谁，无法从身份推楼群 —— 故 `buildingId` 必须显式传入，
 * 且服务端**不做**「回落到任一楼群」的猜测（猜错就是把 A 楼的出品方给 B 楼看）。
 *
 * ## 出参红线
 * 见 `TraceabilityService.supplierView()` 与 `TraceabilityQualification` 头注：
 * 不下发供应商状态、备选名单、联系方式、供价、分账比例（C8）。
 */
@ApiTags('今日这盒·溯源')
@Controller('traceability')
export class TraceabilityController {
  constructor(private readonly traceability: TraceabilityService) {}

  @Public()
  @Get('today')
  @ApiOperation({
    summary: 'U5 今日这盒 · 商家溯源（免登录只读）',
    description:
      '出参给出本餐**实际出品方**（逐菜一行，含该供应商已核验的资质与三个外卖平台的跳转入口）' +
      '与集散中心。\n\n' +
      '`buildingId` 必传 —— 免登录下服务端无从推楼群。\n\n' +
      '**未开团不报错**：回 `dishes: []` + 说明文案，端上走空态（信任页不该弹红）。\n\n' +
      '⚠️ 外卖链接的 `url` 为 `null` 表示**该平台未入驻**，是合法状态：三条入口**恒返回**，' +
      '端上置灰而不隐藏 ——「缺京东」这件事必须看得见，否则运营不知道要去谈哪家。\n\n' +
      '⚠️ **能跳转 ≠ 是合作伙伴**：本接口绝不下发「哪些是备选商家」（C8）。',
  })
  today(@Query() q: TraceabilityTodayQueryDto) {
    return this.traceability.today(q.buildingId, q.mealDate);
  }
}
