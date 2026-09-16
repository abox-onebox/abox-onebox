/**
 * 供应商端（供应商 Web · role=supplier）请求 DTO —— M3-8 · S1/S2/S3
 *
 * ⚠️ **与 `supplier-admin.dto.ts` 是两套主体**，别互抄：
 *   · `supplier-admin.dto.ts` —— 运营后台（`/admin/suppliers/*`）看的「平台管供应商」
 *   · 本文件 —— 供应商看自己（`/supplier/*`），主体由账号绑定的 `supplierId` 决定，
 *     **请求体里一律不出现 `supplierId`**（否则成了「供应商 A 改供应商 B 的计划」）。
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** `YYYY-MM-DD`（出餐日） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 单次出餐确认的明细上限。
 *
 * 为什么要有上限：一道菜 × 一个集散中心 = 1 项，正常量级是「菜品数（≤10）× 中心数（≤8）」。
 * 给 100 的余量足够运营批量补确认，同时挡住「构造超大数组打满事务」的请求。
 */
export const MAX_CONFIRM_ITEMS = 100;

/** S1 · 工作台查询（`date` 缺省 = 最近一个有生产计划的出餐日） */
export class SupplierWorkbenchQueryDto {
  @IsOptional()
  @Matches(DATE_RE, { message: 'date 必须是 YYYY-MM-DD' })
  date?: string;
}

/** S3 · 打包任务查询 */
export class PackingTasksQueryDto {
  @IsOptional()
  @Matches(DATE_RE, { message: 'date 必须是 YYYY-MM-DD' })
  date?: string;
}

/**
 * S2 · 单项出餐确认
 *
 * 粒度 = (菜, 集散中心)：供应商把「某道菜送到某个集散中心」这件事逐项确认。
 * 与原型 P22 的交互一一对应 —— 每个集散中心一张卡 + 一个勾选框。
 */
export class CookConfirmItemDto {
  @Type(() => Number)
  @IsInt({ message: 'dishId 必须是整数' })
  @Min(1)
  dishId!: number;

  @Type(() => Number)
  @IsInt({ message: 'distributionCenterId 必须是整数' })
  @Min(1)
  distributionCenterId!: number;

  /**
   * 实送份数：**不传 = 足额送达**（取该明细的应送份数）。
   * 传了才落库 —— 短送留痕是对账依据，但不能强迫供应商每次都填。
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  actualQuantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}

/** S2 · 出餐确认请求体 */
export class CookConfirmDto {
  /** 出餐日（= 套餐日 T）。**必填**：确认的是「哪一天那餐」，不能让服务端猜。 */
  @Matches(DATE_RE, { message: 'date 必须是 YYYY-MM-DD' })
  date!: string;

  @IsArray()
  @ArrayMinSize(1, { message: '至少提交一项' })
  @ArrayMaxSize(MAX_CONFIRM_ITEMS, { message: `单次最多提交 ${MAX_CONFIRM_ITEMS} 项` })
  @ValidateNested({ each: true })
  @Type(() => CookConfirmItemDto)
  items!: CookConfirmItemDto[];
}
