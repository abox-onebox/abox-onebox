import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../../common/decorators/auth.decorator';
import { OperationLog } from '../../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import {
  AdminDishesQueryDto,
  BatchDishStatusDto,
  CreateDishDto,
  DishIdParamDto,
  UpdateDishDto,
} from '../dto/supplier-admin.dto';
import { DishAdminService } from './dish-admin.service';

/**
 * 后台 · 菜品库（原型 P33「菜品库」页 · **扩展接口，不占 D 编号**）
 *
 * ## 为什么路径是 `/admin/dishes` 而不是塞进 `/admin/suppliers/{id}/dishes`
 *
 * 菜品是**独立资源**：它既可按供应商查，也要能「全平台按档位/关键词挑菜」——
 * 后者正是套餐编排（D2/D3）的操作方式。挂在供应商下会强制运营先选商家再看菜，
 * 与真实工作流相反。故此处并列，供应商维度只作为**筛选条件**（`supplierId`）。
 *
 * ⚠️ 与既有的 `GET /admin/meal/dishes`（M3-2 的只读选择器）**不是同一个东西**：
 *    那个接口的语义是「编排套餐时可挑哪些菜」（只读、按套餐槽位组织）；
 *    本控制器管的是「菜品本身怎么维护」（增删改、供价、上下架）。
 *    两者数据同源（`ab_dish`），但职责不同 —— 合并会让编排页意外拿到写权限。
 *
 * ⚠️ **路由顺序**：`GET filter-options` 与 `POST batch-status` 必须声明在
 *    `GET/PUT :id` **之前**，否则会被参数路由吃掉（同 D8 export 的坑）。
 *
 * ⚠️ **两级白名单**：类级放 `operator`（要看菜品库、要对账供价），
 *    写操作收窄到 `super_admin`/`admin` —— 供价是 C9 结算等式的输入项，
 *    改一个数字就改了供应商应付与平台毛利。
 */
@ApiTags('后台·菜品库')
@ApiBearerAuth()
@Controller('admin/dishes')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class DishAdminController {
  constructor(private readonly dishAdmin: DishAdminService) {}

  @Get()
  @ApiOperation({
    summary: '菜品库列表（扩展）',
    description:
      '按供应商 / 档位 / 上下架 / 菜名筛选；summary 为同过滤条件全量统计（含 avgPriceFen）。' +
      '⚠️ 档位 `main/half/veg/soup/staple` 与套餐槽位 `DishSlot` 是**两套枚举**，见出参 notes。',
  })
  list(@Query() q: AdminDishesQueryDto, @CurrentAdmin('role') role: string) {
    return this.dishAdmin.list(q, role);
  }

  @Post()
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '新增菜品' })
  @ApiOperation({
    summary: '新增菜品（扩展）',
    description:
      '供价按**逐菜协商**（C9）以「分」传入，必须 > 0；' +
      '供应商必须存在（50006）。新增后即可被套餐编排（D2/D3）挑中。',
  })
  create(@Body() dto: CreateDishDto) {
    return this.dishAdmin.create(dto);
  }

  @Post('batch-status')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '批量上下架菜品' })
  @ApiOperation({
    summary: '批量上下架（扩展）',
    description:
      '下架**必填原因**（复盘要能回答「谁因为什么下的」）。' +
      '不做「部分成功」：有任一 id 不存在即整体拒绝（404），避免运营以为全成功了。',
  })
  batchStatus(@Body() dto: BatchDishStatusDto) {
    return this.dishAdmin.batchStatus(dto);
  }

  @Put(':id')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '编辑菜品', targetParam: 'id' })
  @ApiOperation({
    summary: '编辑菜品（扩展）',
    description:
      '⚠️ **不含 `supplierId`** —— 换供应商请新建菜品并下架旧的：' +
      '历史分账流水按 `dish_id` 归属，改主体会让已出的结算单与菜品对不上。',
  })
  update(@Param() p: DishIdParamDto, @Body() dto: UpdateDishDto) {
    return this.dishAdmin.update(p.id, dto);
  }
}
