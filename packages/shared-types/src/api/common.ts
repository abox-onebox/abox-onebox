/** 统一响应结构（见《接口规范 v1.0》§1.2） */
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
  /** 请求链路 ID（端上出问题时可直接提供） */
  requestId: string;
  /** 服务器时间戳（毫秒） */
  timestamp: number;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

/** 分页响应（见《接口规范 v1.0》§1.3） */
export interface PageResult<T> {
  list: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/** 分页默认值（§1.3：pageSize 上限 100，超出按 100 处理） */
export const PAGE_DEFAULT = { page: 1, pageSize: 20, maxPageSize: 100 } as const;

/** 请求头约定（§1.7） */
export const HEADER = {
  AUTHORIZATION: 'Authorization',
  CONTENT_TYPE: 'Content-Type',
  IDEMPOTENCY_KEY: 'Idempotency-Key',
  REQUEST_ID: 'X-Request-Id',
  CLIENT: 'X-Client',
} as const;
