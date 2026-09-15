import { ApiProperty } from '@nestjs/swagger';

/** 统一响应体 —— 全站接口返回格式（见《接口规范 v1.0》） */
export class ApiResponseDto<T = unknown> {
  @ApiProperty({ description: '0 表示成功，非 0 见错误码表', example: 0 })
  code!: number;

  @ApiProperty({ description: '提示文案', example: 'ok' })
  message!: string;

  @ApiProperty({ description: '业务数据，失败时为 null', nullable: true })
  data!: T | null;

  @ApiProperty({ description: '服务器时间戳（毫秒）', example: 1789000000000 })
  ts!: number;
}

export function ok<T>(data: T, message = 'ok'): ApiResponseDto<T> {
  return { code: 0, message, data, ts: Date.now() };
}

export function fail(code: number, message: string): ApiResponseDto<null> {
  return { code, message, data: null, ts: Date.now() };
}

/** 分页响应体 */
export class PageResultDto<T = unknown> {
  @ApiProperty({ description: '当前页数据' })
  list!: T[];

  @ApiProperty({ description: '总条数' })
  total!: number;

  @ApiProperty({ description: '页码，从 1 开始' })
  page!: number;

  @ApiProperty({ description: '每页条数' })
  pageSize!: number;
}
