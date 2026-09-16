import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * D57 / D58 系统配置 DTO
 *
 * ⚠️ **这里只做「形状校验」，不校验取值范围**。
 *    取值范围（min / max / 枚举 / 长度）随**配置键**变化，写进 DTO 就得为
 *    每个键开一个 DTO 类，或写一长串 `@ValidateIf`。这些规则的唯一真相在
 *    `config.specs.ts` 的 `CONFIG_SPECS`，由 `ConfigService` 统一执行 ——
 *    这样「页面上显示的限制」与「服务端真正执行的限制」不可能漂移。
 */
export class ConfigItemDto {
  @ApiProperty({
    description: '配置键（须在 CONFIG_SPECS 白名单内）',
    example: 'settlement.site_fee',
  })
  @IsString({ message: 'key 必须为字符串' })
  @IsNotEmpty({ message: 'key 不能为空' })
  @MaxLength(64, { message: 'key 过长' })
  key!: string;

  /**
   * 配置值（统一用字符串传递）
   *
   * ⚠️ `percent` 类型的**入参是百分数**（`8` 表示 8%），服务端换算为 `0.0800` 存储。
   *    若让端上传存储原值，运营极易把 8% 填成 `8`（= 800%）—— 那会让佣金算错 100 倍。
   *    换算只在一处（`ConfigService.normalizeForStore`）。端上显示的也是百分数。
   *
   * ⚠️ **允许空串**（如 `service.phone` 需要清空），故不校验 `@IsNotEmpty`。
   */
  @ApiProperty({ description: '配置值（percent 类型传百分数，如 8 表示 8%）', example: '1.50' })
  @IsString({ message: 'value 必须为字符串' })
  @MaxLength(512, { message: 'value 过长（上限 512 字符）' })
  value!: string;
}

/** D58 批量更新入参（**整批原子**：任一项不合法则整批不改） */
export class UpdateConfigsDto {
  @ApiProperty({ type: [ConfigItemDto], description: '待更新的配置项列表' })
  @IsArray({ message: 'items 必须为数组' })
  @ArrayNotEmpty({ message: '没有需要更新的配置项' })
  @ValidateNested({ each: true })
  @Type(() => ConfigItemDto)
  items!: ConfigItemDto[];
}
