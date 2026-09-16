import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/auth.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PackingTasksQueryDto } from './dto/supplier.dto';
import { SupplierService } from './supplier.service';

/**
 * 运营后台 · 加工场所打包任务（M4-0 新增 · 承接原供应商端 S3）
 *
 * ## 为什么在这里而不是供应商端
 *   原 `GET /supplier/packing-tasks` 的可见性判据是「本主体名下有没有启用中的集散中心」
 *   （原型 P21/P22 的集散型 / 混合型）。自营口径下：
 *     ① 加工场所**属 ABox 自有**（`ab_distribution_center.supplier_id` 已停用），
 *        「挂在某供应商名下」这个关系不成立 → 判据失效，供应商端永远返回 `visible=false`；
 *     ② 更根本的是**语义不该给供应商** —— 打包闸门必须看到**所有**供应商的到位情况，
 *        一次查询天然包含他方的到货明细（违反 I1：不泄露他方经营数据）。
 *   故整条路由迁到运营后台，供应商端 S3 下线（`GET /supplier/packing-tasks` → 10004）。
 *
 * ## 与 S3 是**同一个执行口**
 *   服务实现仍只有 `SupplierService.packingTasks()` 一份（生产计划派生 + 闸门 + 路线派生），
 *   本控制器只是换了一个主体与路径 —— 不另写第二套口径，杜绝「两边算得不一样」。
 *
 * ## 两级白名单
 *   类级含 `operator`（打包是运营的日常作业，必须能看）；
 *   **不含 `viewer`** —— 只读观察者仅看板（与 D47–D50 刻意含 viewer 正好相反）；
 *   也不含 `finance` —— 菜单矩阵里财务没有这一页（若 API 放行而菜单没有，
 *   会变成「能调但进不去」的诡异状态）。
 *
 * ## 纯读
 *   `GET` 不标 `@OperationLog`（与 S1/S9 同一纪律：列表类接口打日志会把日志表刷爆）。
 */
@ApiTags('后台·加工场所打包')
@ApiBearerAuth()
@Controller('admin/packing-tasks')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class PackingAdminController {
  constructor(private readonly supplier: SupplierService) {}

  @Get()
  @ApiOperation({
    summary: '加工场所打包任务（原 S3 · P39）',
    description:
      '按 `date`（出餐日，缺省取**全局**最近一个有生产计划的出餐日）返回**全部启用中的加工场所**' +
      '的打包任务：逐场所列出「应到菜品 × 供应商」的到位情况、`ready` 闸门与 `blockers`、' +
      '路线派生（R 编号 / 站点链 / 各楼群份数）。\n\n' +
      '⚠️ 本页信息**跨供应商**（闸门要看到所有人），故只在运营后台开放；' +
      '供应商端原 `GET /supplier/packing-tasks` 已随自营口径下线。\n\n' +
      '`visible=false` + `reason`（HTTP 200）表示**当前没有任何启用中的加工场所** ——' +
      '「没有这项任务」是正常状态，不是错误。\n\n' +
      '`ready` = 该场所当日**所有**菜品均已确认送达，才允许开包；' +
      '未到齐时 `blockers` 列出欠的供应商与菜品。\n\n' +
      '`routes` 是路线派生（R 编号 / 站点链 / 各楼群份数），' +
      '**不返回距离与单段时长** —— 无地图数据，原型上的 km/分钟是演示值。',
  })
  packingTasks(@Query() q: PackingTasksQueryDto) {
    return this.supplier.packingTasks(q);
  }
}
