/** 统一响应结构（见《接口规范 v1.0》§2） */
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
  traceId?: string;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 分页默认值 */
export const PAGE_DEFAULT = { page: 1, pageSize: 20, maxPageSize: 100 } as const;
