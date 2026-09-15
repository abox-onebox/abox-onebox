import { ApiProperty } from '@nestjs/swagger';

/**
 * 统一响应体 —— 全站接口返回格式
 * 权威来源：《ABox一盒接口规范v1.0.md》§1.2
 *
 * ⚠️ 字段名为 `requestId` / `timestamp`（非早期的 `ts`）——
 *    端上按 §1.2 契约取值，故此处与文档严格对齐。
 */
export class ApiResponseDto<T = unknown> {
  @ApiProperty({ description: '0 表示成功，非 0 见错误码表 §九', example: 0 })
  code!: number;

  @ApiProperty({ description: '提示文案（可直接 toast）', example: 'ok' })
  message!: string;

  @ApiProperty({ description: '业务数据，失败时为 null', nullable: true })
  data!: T | null;

  @ApiProperty({
    description: '请求链路 ID，随日志与 APM 串联',
    example: 'req_1757850000000_a1b2c3',
  })
  requestId!: string;

  @ApiProperty({ description: '服务器时间戳（毫秒）', example: 1789000000000 })
  timestamp!: number;
}

export function ok<T>(data: T, requestId = '', message = 'ok'): ApiResponseDto<T> {
  return { code: 0, message, data, requestId, timestamp: Date.now() };
}

export function fail(code: number, message: string, requestId = ''): ApiResponseDto<null> {
  return { code, message, data: null, requestId, timestamp: Date.now() };
}

/** 分页响应体（§1.3） */
export class PageResultDto<T = unknown> {
  @ApiProperty({ description: '当前页数据' })
  list!: T[];

  @ApiProperty({ description: '页码，从 1 开始' })
  page!: number;

  @ApiProperty({ description: '每页条数，上限 100' })
  pageSize!: number;

  @ApiProperty({ description: '总条数' })
  total!: number;

  @ApiProperty({ description: '是否还有下一页' })
  hasMore!: boolean;
}
