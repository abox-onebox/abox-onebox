import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * 后台 · 套餐编排入参（《接口规范 v1.0》§6.1 D1–D7）
 *
 * 日期一律 `YYYY-MM-DD`（= 出餐日 T），语义与 U1 的 `mealDate` 完全一致 ——
 * 后台看到的「9 月 16 日」与用户端看到的「明日套餐」必须是同一天。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MSG = '日期需为 YYYY-MM-DD';

/** 单次矩阵查询的最大跨度（天）—— 防止「查一年」把 5 个楼群 × 365 天的网格一次吐出 */
export const MATRIX_MAX_DAYS = 31;

/** 单次批量复制的最大目标日期数 */
export const COPY_MAX_DATES = 14;

/** 一饭四菜 + 主食，8 项已是宽松上限 */
export const TEMPLATE_MAX_ITEMS = 8;

/** D1 矩阵查询 */
export class MealMatrixQueryDto {
  @ApiPropertyOptional({ description: '起始出餐日 YYYY-MM-DD，缺省=今日', example: '2026-09-15' })
  @IsOptional()
  @Matches(DATE_RE, { message: DATE_MSG })
  startDate?: string;

  @ApiPropertyOptional({
    description: `结束出餐日 YYYY-MM-DD，缺省=起始日 + 6 天；跨度上限 ${MATRIX_MAX_DAYS} 天`,
    example: '2026-09-21',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: DATE_MSG })
  endDate?: string;
}

/** D2 创建套餐分配 */
export class CreateAssignmentDto {
  @ApiProperty({ description: '出餐日 YYYY-MM-DD', example: '2026-09-16' })
  @Matches(DATE_RE, { message: DATE_MSG })
  mealDate!: string;

  @ApiProperty({ description: '楼群 ID（ab_building_group.id）', example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  buildingGroupId!: number;

  @ApiProperty({ description: '套餐模板 ID（ab_set_meal.id）', example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  setMealId!: number;

  @ApiPropertyOptional({ description: '集散中心 ID（ab_distribution_center.id）', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  distributionCenterId?: number;
}

/** D3 编辑套餐分配（**改不了日期与楼群** —— 那是「另一条分配」，请删旧建新） */
export class UpdateAssignmentDto {
  @ApiPropertyOptional({ description: '换套餐模板', example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  setMealId?: number;

  @ApiPropertyOptional({ description: '换集散中心', example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  distributionCenterId?: number;
}

/** D4 上架 / 下架 */
export class PublishAssignmentDto {
  @ApiProperty({ description: 'publish 上架（用户端可下单）/ unpublish 下架', example: 'publish' })
  @IsIn(['publish', 'unpublish'], { message: "action 需为 'publish' 或 'unpublish'" })
  action!: 'publish' | 'unpublish';
}

/** D5 批量复制（某日出餐安排 → 若干目标日期） */
export class CopyAssignmentsDto {
  @ApiProperty({ description: '源出餐日 YYYY-MM-DD', example: '2026-09-16' })
  @Matches(DATE_RE, { message: DATE_MSG })
  fromDate!: string;

  @ApiProperty({
    description: `目标出餐日列表（1–${COPY_MAX_DATES} 个），已存在分配的日期会被跳过而非覆盖`,
    example: ['2026-09-17', '2026-09-18'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'targetDates 不能为空' })
  @ArrayMaxSize(COPY_MAX_DATES, { message: `一次最多复制到 ${COPY_MAX_DATES} 天` })
  @Matches(DATE_RE, { each: true, message: `targetDates 每项需为 YYYY-MM-DD` })
  targetDates!: string[];

  @ApiPropertyOptional({
    description: '限定复制的楼群（缺省=源日的全部楼群）',
    example: [1, 2],
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  buildingGroupIds?: number[];
}

/** D6 套餐模板库查询 */
export class SetMealTemplateQueryDto {
  @ApiPropertyOptional({ description: '按套餐名模糊匹配' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ description: '状态：1 启用 / 0 停用' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;

  @ApiPropertyOptional({ description: '页码，默认 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数，默认 20，上限 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/** D7 模板菜品项（档位 1 主荤 / 2 半荤 / 3 素菜 / 4 汤 / 5 主食） */
export class SetMealItemInputDto {
  @ApiProperty({ description: '菜品 ID（ab_dish.id）', example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  dishId!: number;

  @ApiProperty({ description: '档位：1 主荤 / 2 半荤 / 3 素菜 / 4 汤 / 5 主食', example: 1 })
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3, 4, 5], { message: 'slot 需为 1–5' })
  slot!: number;
}

/**
 * D7 存为模板
 *
 * ⚠️ **入参不含 `supplierId` / `costPrice`**：供应商由菜品自身反查
 *    （`ab_dish.supplier_id`），成本价由菜品供价求和 —— 让运营手填这两个字段，
 *    迟早会填出「套餐记着 A 家的菜、却算着 B 家的钱」，结算时才发现对不上。
 */
export class CreateSetMealTemplateDto {
  @ApiProperty({ description: '套餐名', example: '红烧肉套餐' })
  @IsString()
  @IsNotEmpty({ message: '套餐名不能为空' })
  @MaxLength(64)
  name!: string;

  @ApiPropertyOptional({
    description: '售价（元）；缺省取系统配置的售价（C1 默认 ¥25.80）',
    example: 25.8,
  })
  @IsOptional()
  @Type(() => Number)
  @Min(0.01)
  @Max(9999)
  price?: number;

  @ApiPropertyOptional({ description: '一句话介绍', example: '招牌红烧肉 · 一饭四菜' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  oneLiner?: string;

  @ApiPropertyOptional({ description: '详情描述' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @ApiPropertyOptional({ description: '封面图 URL' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  coverUrl?: string;

  @ApiPropertyOptional({
    description: `菜品项（1–${TEMPLATE_MAX_ITEMS} 项）；用 sourceSetMealId 另存时可不传`,
    type: [SetMealItemInputDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TEMPLATE_MAX_ITEMS, { message: `最多 ${TEMPLATE_MAX_ITEMS} 项` })
  @ValidateNested({ each: true })
  @Type(() => SetMealItemInputDto)
  items?: SetMealItemInputDto[];

  @ApiPropertyOptional({ description: '以此为蓝本另存（复制其菜品明细），与 items 二选一' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sourceSetMealId?: number;
}

/**
 * 菜品选择器查询（D7 编排页的候选菜品）
 *
 * 只做**只读挑选**：菜品的管理属供应商模块（D23–D32）。
 */
export class DishOptionQueryDto {
  @ApiPropertyOptional({ description: '按菜品名模糊匹配' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  keyword?: string;
}
