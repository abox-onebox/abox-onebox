import { PAGE_DEFAULT } from '@abox/shared-types';

/** 分页入参（Query，来自 URL 字符串） */
export interface PageInput {
  page?: unknown;
  pageSize?: unknown;
}

export interface PageResult<T> {
  list: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/**
 * 分页参数归一化（《接口规范》§1.3）
 *   page 缺省 1；pageSize 缺省 20，**上限 100**（超出按 100 处理）
 *   ⚠️ 非法值不报错，回落默认值 —— Query 参数宽松解析，避免端上因脏参数拿不到列表。
 */
export function normalizePage(input: PageInput = {}): {
  page: number;
  pageSize: number;
  skip: number;
} {
  const rawPage = Number(input.page);
  const rawSize = Number(input.pageSize);

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : PAGE_DEFAULT.page;
  const size =
    Number.isFinite(rawSize) && rawSize >= 1
      ? Math.min(Math.floor(rawSize), PAGE_DEFAULT.maxPageSize)
      : PAGE_DEFAULT.pageSize;

  return { page, pageSize: size, skip: (page - 1) * size };
}

/** 组装分页响应（含 hasMore） */
export function paginate<T>(
  list: T[],
  total: number,
  page: number,
  pageSize: number,
): PageResult<T> {
  return { list, page, pageSize, total, hasMore: page * pageSize < total };
}
