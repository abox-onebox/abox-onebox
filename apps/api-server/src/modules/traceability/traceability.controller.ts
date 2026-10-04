import { Controller, Get, Param, Query } from '@nestjs/common';
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
      '出参给出本餐**实际出品方**（逐菜一行，含该供应商已核验的资质）与集散中心。\n\n' +
      '`buildingId` 必传 —— 免登录下服务端无从推楼群。\n\n' +
      '**未开团不报错**：回 `dishes: []` + 说明文案，端上走空态（信任页不该弹红）。\n\n' +
      '⚠️⭐ **本接口不下发任何第三方平台信息**（名称 / 链接 / 推荐标记）：' +
      '《微信小程序平台运营规范》**5.10 互推行为**禁止为他人 APP/小程序推荐、推广或提供' +
      '跳转便利（处理 = **下架**）。原 `takeoutLinks` / `recommended` 两字段已于 2026-10-04 移除。' +
      '后台 `ab_supplier.takeout_links` 与其配置页**保留**（后台网页不受小程序审核约束），' +
      '但**面向小程序的出参永不读取**它。\n\n' +
      '⚠️ **能展示资质 ≠ 是合作伙伴**：本接口绝不下发「哪些是备选商家」（C8）。',
  })
  today(@Query() q: TraceabilityTodayQueryDto) {
    return this.traceability.today(q.buildingId, q.mealDate);
  }

  @Public()
  @Get('suppliers')
  @ApiOperation({
    summary: '供应商资质墙 · 列表（免登录只读）',
    description:
      '**2026-10-03 新增**：取代原「跳转外卖平台看店铺」的信任路径。\n\n' +
      '出参分两组：`serving` = 正在供应（合作中 ∧ 资质已通过 ∧ 证照未过期，' +
      '判据与 S1 出餐前置 `canServe` 同一处实现）；`inactive` = 暂未供应，' +
      '**只给名字与品类、不带资质**（把过期证照摆上资质墙比不摆更糟）。\n\n' +
      '⚠️ C8 红线不变：不下发合作状态、联系方式、供价、分账、审核意见。\n\n' +
      '⚠️ 本接口**不含任何第三方平台**的名称 / 标识 / 链接 / 跳转入口 —— ' +
      '《运营规范》5.10（互推，下架）· 5.20（利用剪切板诱导跳转 APP）' +
      '· 5.15.4 / 5.16（滥用剪切板，封禁至封号）均不允许。',
  })
  supplierList() {
    return this.traceability.supplierList();
  }

  @Public()
  @Get('suppliers/:id')
  @ApiOperation({
    summary: '供应商资质墙 · 详情（免登录只读）',
    description:
      '逐条给出该出品方的证照（名称 / 编号 / 有效期）与在册菜品名。\n\n' +
      '⚠️ **不在供时 `entries` 为空数组，原因写在 `note` 里** —— ' +
      '既不能把过期证照摆出来（用户会当成仍然有效），也不能让用户对着空白页发愣。\n\n' +
      '`id` 非法时 400（`PARAM_INVALID`），不存在时 404（`NOT_FOUND`）。',
  })
  supplierDetail(@Param('id') id: string) {
    return this.traceability.supplierDetail(Number(id));
  }
}
