import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { BuildingService } from './building.service';

/**
 * Building 控制器 —— **用户端**只读（`GET /building`）
 *
 * 端点契约：《接口规范 v1.0》§6.3（楼宇域）+ 本批新增的 U 系列「自助选楼」。
 * 后台写侧在 `BuildingAdminController`（`admin/buildings` D13–D15），**不在这里**。
 *
 * ## ⚠️ 鉴权：走**全局** `JwtAuthGuard`（`CommonModule` 的 `APP_GUARD`）
 *
 * 与 `UserController`（`/me/*）、`MealController`（`/home/*`）同一形态 ——
 * 本控制器**不自己挂** `@UseGuards(JwtAuthGuard)`，挂了反而会与全局守卫
 * 形成两套判定。`/building` 是登录后才能看的（未绑楼的人正是要登录后才来选）。
 *
 * ## ⚠️ 路径不要改成 `/buildings`
 *
 * `admin/buildings` 是后台端点，两者靠**前缀**在 `JwtAuthGuard` 里做主体隔离。
 * C 端叫 `/building`（单数）是与 `building.module.ts` 头注一致的历史约定，
 * 改动会让前端与契约同时失配。
 */
@ApiTags('办公楼')
@ApiBearerAuth()
@Controller('building')
export class BuildingController {
  constructor(private readonly building: BuildingService) {}

  /**
   * 用户端可选办公楼列表（**仅营业中**）
   *
   * ⭐ 这是「自助绑定办公楼」链路的第 1 支（第 2 支是 `PUT /me/building`）。
   *    在此之前，用户 `building_id` 只能通过团长邀请链接写入 ——
   *    没有链接的人（同事扫码进来测试、老用户换楼）**永远卡在首页的空态上**。
   */
  @Get()
  @ApiOperation({
    summary: 'U-B1 可选办公楼列表（仅营业中 · 含该楼在职团长）',
    description:
      '只返回 `status = 1`（营业中）且未删除的楼 —— 待开通 / 已暂停的楼没有开团资格，' +
      '让用户选它等于给一个必然下不了单的选项。\n\n' +
      '`leaderName` 为 `null` 表示该楼暂无在职团长：此时即便完成绑定，`/home/daily` ' +
      '仍会返回 30005 未开团 —— 端上应如实提示，而不是等用户下单时才发现。',
  })
  list() {
    return this.building.listSelectable();
  }
}
