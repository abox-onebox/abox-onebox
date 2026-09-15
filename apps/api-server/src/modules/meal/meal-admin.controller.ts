import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  CopyAssignmentsDto,
  CreateAssignmentDto,
  CreateSetMealTemplateDto,
  DishOptionQueryDto,
  MealMatrixQueryDto,
  PublishAssignmentDto,
  SetMealTemplateQueryDto,
  UpdateAssignmentDto,
} from './dto/meal-admin.dto';
import { MealAdminService } from './meal-admin.service';

/**
 * 后台 · 套餐编排（《接口规范 v1.0》§6.1 D1–D7 · 原型 P27–P29）
 *
 * 路径统一挂在 `admin/meal/*` —— `JwtAuthGuard` 的 `ADMIN_SCOPE` 只认 `/admin` 与
 * `/supplier` 前缀，控制器路径写错一个字母，鉴权就会**静默失效**（变成用户端可访问）。
 *
 * ⚠️ `@Roles('super_admin','admin','operator')`：套餐编排是**运营**的日常动作，
 *    财务与只读观察者不该有写权限。前端菜单已把 `/meal/*` 摘出 finance / viewer，
 *    这里是**服务端兜底** —— 前端过滤是体验，不是安全边界。
 */
@ApiTags('后台·套餐编排')
@ApiBearerAuth()
@Controller('admin/meal')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class MealAdminController {
  constructor(private readonly mealAdmin: MealAdminService) {}

  // ------------------------------------------------------------ D1 矩阵

  @Get('matrix')
  @ApiOperation({
    summary: 'D1 日期 × 楼群二维矩阵（完整网格，含空格子）',
    description:
      '返回 dates × groups 的**全量**网格：无分配的格子 assignmentId=null。' +
      'emptyBuildings = 楼群内停用 / 待分配的办公楼，UI 以禁用复选框呈现。',
  })
  matrix(@Query() q: MealMatrixQueryDto) {
    return this.mealAdmin.matrix(q);
  }

  // ------------------------------------------------------------ D2–D5 分配

  @Post('assignments')
  @OperationLog({ module: 'meal', action: '创建套餐分配' })
  @ApiOperation({
    summary: 'D2 创建套餐分配（建出来是 pending，需 D4 上架）',
    description: '同一「出餐日 × 楼群」唯一；重复 → 30011。',
  })
  createAssignment(@Body() dto: CreateAssignmentDto) {
    return this.mealAdmin.createAssignment(dto);
  }

  @Post('assignments/copy')
  @OperationLog({ module: 'meal', action: '批量复制套餐分配' })
  @ApiOperation({
    summary: 'D5 批量复制（某日 → 若干目标日期）',
    description:
      '**不覆盖**已存在的分配（跳过并在 skipped[] 说明）；复制出的分配一律为 pending；已截单的目标日跳过。',
  })
  copyAssignments(@Body() dto: CopyAssignmentsDto) {
    return this.mealAdmin.copyAssignments(dto);
  }

  @Put('assignments/:id')
  @OperationLog({ module: 'meal', action: '编辑套餐分配' })
  @ApiOperation({
    summary: 'D3 编辑分配（只改套餐与集散中心）',
    description: '已截单的分配不可修改 → 30003。改出餐日 / 楼群请删旧建新。',
  })
  updateAssignment(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateAssignmentDto) {
    return this.mealAdmin.updateAssignment(id, dto);
  }

  @Post('assignments/:id/publish')
  @OperationLog({ module: 'meal', action: '上架/下架套餐分配' })
  @ApiOperation({
    summary: 'D4 上架 / 下架',
    description:
      'publish：pending → active（用户端此刻才 canOrder=true）；unpublish：active → pending。' +
      '重复同向操作**幂等**返回当前状态。已过截单时刻不许上架 → 30013；下架不设闸门（紧急安全阀）。',
  })
  publishAssignment(@Param('id', ParseIntPipe) id: number, @Body() dto: PublishAssignmentDto) {
    return this.mealAdmin.publishAssignment(id, dto.action);
  }

  // ------------------------------------------------------------ D6–D7 模板库

  @Get('dishes')
  @ApiOperation({
    summary: '菜品选择器（D7 编排页候选菜品 · 只读）',
    description:
      '只返回上架菜品。菜品**管理**属供应商模块（D23–D32），此处仅供编排页挑选，' +
      '因此刻意不放在 admin/supplier/* —— 编排页不该依赖尚未落地的模块。',
  })
  dishOptions(@Query() q: DishOptionQueryDto) {
    return this.mealAdmin.dishOptions(q.keyword);
  }

  @Get('distribution-centers')
  @ApiOperation({
    summary: '集散中心选择器（D2/D3 前置数据源 · 只读）',
    description:
      '集散中心为**可选**字段：C9 口径下集散复用合作供应商场地、场地费默认 ¥0，' +
      '因此「不选」是合法状态，前端须允许清空。',
  })
  distributionCenterOptions() {
    return this.mealAdmin.distributionCenterOptions();
  }

  @Get('templates')
  @ApiOperation({
    summary: 'D6 套餐模板库（含菜品明细与在用次数）',
    description: 'usedCount = 被多少个未取消的分配引用，模板库里最有用的一列。',
  })
  listTemplates(@Query() q: SetMealTemplateQueryDto) {
    return this.mealAdmin.listTemplates(q);
  }

  @Post('templates')
  @OperationLog({ module: 'meal', action: '新建套餐模板' })
  @ApiOperation({
    summary: 'D7 存为模板',
    description:
      '入参**不含** supplierId / costPrice：供应商由菜品反查、成本由菜品供价求和，避免手填口径漂移。',
  })
  createTemplate(@Body() dto: CreateSetMealTemplateDto, @CurrentAdmin('sub') operatorId: number) {
    return this.mealAdmin.createTemplate(dto, operatorId);
  }
}
