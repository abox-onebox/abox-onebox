/** 端点目录的类型定义（生成产物 `op-catalog.generated.ts` 依赖它） */

export type CatalogMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ParamIn = 'path' | 'body' | 'query';

export interface CatalogParam {
  /** 参数名；`*` 表示「内联对象 / DTO 未解析出字段」，此时按自由参数处理 */
  name: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | string;
  in: ParamIn;
  /** 取自 ApiProperty.description / @IsIn / @IsEnum，用于问用户时给提示 */
  hint?: string;
}

export interface CatalogEntry {
  method: CatalogMethod;
  /** 形如 `/admin/finance/refunds/:id/approve`，`:xxx` 为路径参数 */
  path: string;
  /** 中文名（取自 @ApiOperation.summary，缺省为方法名） */
  label: string;
  /** 源码 @Roles 真值；空数组 = 源码未标注，执行前按 tier 兜底判定，绝不默认放行 */
  roles: string[];
  /** 「文件:行号」，用于核对漂移 */
  source: string;
  params: CatalogParam[];
}
