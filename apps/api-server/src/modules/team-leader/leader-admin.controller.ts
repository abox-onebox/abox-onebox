import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  AdminLeadersQueryDto,
  AppointLeaderDto,
  AuditLeaderDto,
  LeaderIdParamDto,
  UpdateLeaderDto,
} from './dto/leader-admin.dto';
import { LeaderAdminService } from './leader-admin.service';

/**
 * 后台 · 团长管理（《接口规范 v1.0》§6.3 D19–D22 · 原型 P32 / 模块 M33-03~05）
 *
 * 路径 `admin/leaders/*` —— 前缀 `admin/` 是 `JwtAuthGuard` 的**主体隔离**依据，
 * 与 C 端 `/leader/*`（团长自己看自己的）在鉴权层就分开了：两者名字像，权限天差地别。
 *
 * ⚠️ **路由顺序**：`GET filter-options` 必须声明在 `GET :id` **之前**，
 *    否则 `/admin/leaders/filter-options` 会被 `:id` 当成 id（同 D8 export 的坑）。
 *
 * ⚠️ **两级白名单**（与 M3-4 退款审批同一设计）：
 *    类级放 `operator` —— 运营要能看名录、跟进团长、做资质补录；
 *    D20/D21/D22 **方法级收窄到 `super_admin`/`admin`** ——
 *    任命/转交决定了**谁拿哪个楼的佣金**，改等级直接决定**费率**，都是钱的事；
 *    让运营「看得见但点不了」，好过让他在不知情的情况下改了别人的费率。
 *    `finance` / `viewer` / `supplier` 一律 10003（财务不进团长域，见 admin-role.ts 菜单矩阵）。
 */
@ApiTags('后台·团长管理')
@ApiBearerAuth()
@Controller('admin/leaders')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class LeaderAdminController {
  constructor(private readonly leaderAdmin: LeaderAdminService) {}

  // ------------------------------------------------------------ D19 名录

  @Get()
  @ApiOperation({
    summary: 'D19 团长名录 / 申请流水',
    description:
      'view=roster（默认）团长名册：等级 / 所属办公楼 / 月单 / 推荐数 / 余额 / 冻结；' +
      'view=applications 近 N 天申请流水（C3 申请即生效，本页仅为观察流水，无待审核）。' +
      'summary 按同一过滤条件的全量统计，不受分页影响；手机号一律脱敏。' +
      '⚠️ 申请流水不返回微信号 —— 数据模型未采集该字段，仅回 openid 后 6 位与微信昵称。',
  })
  list(@Query() q: AdminLeadersQueryDto, @CurrentAdmin('role') role: string) {
    return this.leaderAdmin.list(q, role);
  }

  @Get('filter-options')
  @ApiOperation({
    summary: 'D19 附属 · 筛选器下拉（楼群 / 办公楼 / 等级 / 状态）',
    description:
      '自带选择器而非复用 D13/D16：后者属 M3-6 办公楼模块尚未落地，' +
      '团长名录不该反向依赖未实现的能力（同 M3-2/M3-3 的处理）。',
  })
  filterOptions() {
    return this.leaderAdmin.filterOptions();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'D19 附属 · 团长详情（档案 + 裂变链 + 佣金流水 + 操作日志）',
    description:
      '含上行邀请人 / 下行被推荐人（C2 晋级审计的原始依据）与近 20 条佣金流水（含反向冲销负行）。' +
      '操作日志按「团长 id 与用户 id」双键查 —— D20 任命日志的 targetId 是被任命用户 id。',
  })
  detail(@Param() p: LeaderIdParamDto) {
    return this.leaderAdmin.detail(p.id);
  }

  // ------------------------------------------------------------ D20 任命 / 转交

  @Post()
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'leader', action: '任命或转交团长', targetParam: 'userId' })
  @ApiOperation({
    summary: 'D20 任命 / 转交团长',
    description:
      '被任命者必须是已注册用户（团长是叠加身份，无用户即无微信身份 → 20011）。' +
      '目标办公楼已有在职团长时必须显式传 transferFromLeaderId，否则 20012 并回带 occupiedBy；' +
      '确认后现任被**停职**（保留历史佣金/推荐关系），不是删除。' +
      '⚠️ 本接口日志的 targetId = 被任命用户 id（请求体里没有团长 id）。',
  })
  appoint(@Body() dto: AppointLeaderDto) {
    return this.leaderAdmin.appoint(dto);
  }

  // ------------------------------------------------------------ D21 常规变更

  @Put(':id')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'leader', action: '变更团长档案', targetParam: 'id' })
  @ApiOperation({
    summary: 'D21 变更团长（等级 / 所属办公楼 / 楼层）',
    description:
      '改等级会**同步写 commission_rate**（等级是标签、费率才是钱）。' +
      '改所属办公楼时目标楼已被占 → 20012（一栋楼不能有两个在职团长）。' +
      '⚠️ **刻意不收 status** —— 停用/复职属例外处理，只走 D22，避免双入口。',
  })
  update(@Param() p: LeaderIdParamDto, @Body() dto: UpdateLeaderDto) {
    return this.leaderAdmin.update(p.id, dto);
  }

  // ------------------------------------------------------------ D22 资质补录

  @Post(':id/audit')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'leader', action: '团长资质补录/例外处理', targetParam: 'id' })
  @ApiOperation({
    summary: 'D22 资质补录 / 例外处理（协议补签 · 违规停用 · 恢复在职 · 备注）',
    description:
      '⚠️ C3 口径：团长**申请即生效、无前置审核** —— 本接口不是审核入口，' +
      '只做事后留痕与纠偏，界面文案须与 P32「提交申请即生效（无审核）」一致。' +
      'suspend 置停职并清用户归属团长；restore 恢复在职且**不重置等级**（纠错 ≠ 重新入行）；' +
      'sign_agreement 写 agreed_at/agree_version；note 仅留痕。' +
      '对已处于目标态的档案重复操作 → 20013（不是幂等成功）。',
  })
  audit(@Param() p: LeaderIdParamDto, @Body() dto: AuditLeaderDto) {
    return this.leaderAdmin.audit(p.id, dto);
  }
}
