import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/auth.decorator';
import { PageDurationBatchDto } from './dto/track.dto';
import { TrackService } from './track.service';

/**
 * U15 · 页面停留时长上报（**匿名 · 免登录**）
 *
 * ## 为什么免登录（`@Public()`）
 * ① 匿名口径下本端点**不需要身份**：服务端不从 token 取 openid，DTO 也不收；
 * ② 未登录/登录前的页面行为恰恰是最该被看到的（用户在哪儿流失的）；
 * ③ 带上 token 反而制造「拿着 token 打一个不认身份的端点」的错配。
 *
 * ## 安全边界（为什么免鉴权是安全的）
 * - **只写不读**：本端点没有任何查询能力，最坏情况是写入垃圾行；
 * - 写入面被 DTO 卡死：`whitelist + forbidNonWhitelisted` ⇒ 只收
 *   `{ events: [{ page, pageQuery?, enterAt, leaveAt, durationMs }] }`，
 *   `durationMs` 上限 24h、`page` 限长 128 且只允许路由字符；
 * - 全局限流中间件对 `*` 路由生效（`AppModule.configure()`），IP 维度有闸；
 * - `route:audit` 门禁：本路径不在 `/admin`、不在 `/supplier`、不含
 *   mock/debug/seed/test 等词 ⇒ 不触发 R7/R10 等任何 FAIL 规则。
 *
 * ⚠️ **刻意不写 `ab_operation_log`**：那是后台操作者审计表；埋点行本身就是
 *    用户行为的留痕（同 U20 评价的约定）。
 */
@ApiTags('埋点')
@Controller('track')
export class TrackController {
  constructor(private readonly trackService: TrackService) {}

  @Post('page-duration')
  @Public()
  @ApiOperation({
    summary: 'U15 上报页面停留时长（匿名批量）',
    description:
      '端上在页面 onHide/切页时批量上报（≤ 20 条/次）。字段：page 路由、' +
      'pageQuery 页面 query（可选）、enterAt/leaveAt 端上毫秒时刻、durationMs 停留毫秒。' +
      '匿名口径：不采集、不接收任何身份字段。',
  })
  record(@Body() dto: PageDurationBatchDto) {
    return this.trackService.recordBatch(dto.events);
  }
}
