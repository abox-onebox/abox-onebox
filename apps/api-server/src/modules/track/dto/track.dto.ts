import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * 单条页面停留事件
 *
 * ⚠️ **刻意没有 openid / userId 字段**：全局 ValidationPipe 是
 *    `whitelist + forbidNonWhitelisted` ⇒ 未声明的字段会被**整体拒绝**（400），
 *    而不是「静默剥掉」。也就是说即使有人构造 `{ ..., openid: 'x' }` 的报文，
 *    也进不来 —— fail-closed，比「收下但不用」干净。要做用户级分析时再加字段，
 *    且必须与隐私披露、同意机制一起立项（见 `PageTrack` 实体头注）。
 */
export class PageDurationEventDto {
  @ApiProperty({
    description: '页面路由路径（小程序/H5 页面路径，如 pages/index/index）',
    example: 'pages/index/index',
  })
  @IsString({ message: 'page 需为字符串' })
  @MaxLength(128, { message: 'page 上限 128 字符' })
  @Matches(/^[A-Za-z0-9_\-/]+$/, { message: 'page 只允许路由字符（字母数字 _ - /）' })
  page!: string;

  @ApiPropertyOptional({
    description: '页面 query 序列化（如 buildingId=3；无 query 可省略）',
    example: 'buildingId=3',
  })
  @IsOptional()
  @IsString({ message: 'pageQuery 需为字符串' })
  @MaxLength(256, { message: 'pageQuery 上限 256 字符' })
  pageQuery?: string;

  @ApiProperty({ description: '进入时刻（端上 Date.now() 毫秒）', example: 1729400000000 })
  @Type(() => Number)
  @IsInt({ message: 'enterAt 需为整数毫秒' })
  @Min(0, { message: 'enterAt 不能为负' })
  @Max(4102444800000, { message: 'enterAt 超出合理范围（2100 年前）' })
  enterAt!: number;

  @ApiProperty({ description: '离开时刻（端上 Date.now() 毫秒）', example: 1729400120000 })
  @Type(() => Number)
  @IsInt({ message: 'leaveAt 需为整数毫秒' })
  @Min(0, { message: 'leaveAt 不能为负' })
  @Max(4102444800000, { message: 'leaveAt 超出合理范围（2100 年前）' })
  leaveAt!: number;

  @ApiProperty({ description: '停留毫秒（端上计算；封顶 24h）', example: 120000 })
  @Type(() => Number)
  @IsInt({ message: 'durationMs 需为整数毫秒' })
  @Min(0, { message: 'durationMs 不能为负' })
  @Max(86400000, { message: 'durationMs 上限 24h（防异常值污染统计）' })
  durationMs!: number;
}

/**
 * 批量上报（一次 ≤ 20 条）
 *
 * 批量是为「弱网/离线攒一批再发」设计的：端上队列在页面切换时 flush，
 * 失败保留本地存储，下次切换再试。上限 20 与端上 `MAX_BATCH` 对齐。
 */
export class PageDurationBatchDto {
  @ApiProperty({
    description: '停留事件数组（至少 1 条、至多 20 条）',
    type: [PageDurationEventDto],
  })
  @IsArray({ message: 'events 需为数组' })
  @ArrayMinSize(1, { message: '至少上报 1 条' })
  @ArrayMaxSize(20, { message: '单次最多 20 条' })
  @ValidateNested({ each: true })
  @Type(() => PageDurationEventDto)
  events!: PageDurationEventDto[];
}
