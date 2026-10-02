import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

/**
 * 用户端 · 自助绑定办公楼 DTO（`PUT /me/building`）
 *
 * ⚠️ **只声明 `buildingId` 一个字段**：全局 `ValidationPipe` 开了
 *   `forbidNonWhitelisted`，多传 `teamLeaderId` 会被直接拒（10001）而不是静默忽略 ——
 *   这正是想要的：「跟哪个团长」由服务端按楼重算，端上不得指定
 *   （否则就绕过了「换楼即重算归属」这条规则，见 `UserService.bindBuilding`）。
 */
export class BindBuildingDto {
  @ApiProperty({ description: '办公楼 id（取自 `GET /building` 的列表）' })
  @Type(() => Number)
  @IsInt({ message: '办公楼 id 需为整数' })
  @Min(1)
  buildingId!: number;
}
