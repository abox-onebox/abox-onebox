import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  DishCategory,
  LicenseState,
  SupplierAuditStatus,
  SupplierStatus,
  SupplierType,
  TakeoutPlatform,
} from '@abox/shared-types';

/**
 * 后台 · 供应商管理 DTO（《接口规范 v1.0》§6.4 D23–D28 · 原型 P33）
 *
 * ⚠️ 校验分层（与订单/退款/团长后台同一纪律）：
 *   类级装饰器 → 只管「类型 / 格式 / 枚举合法性」（失败即 10001）
 *   服务层     → 管「业务语义」（类型与集散中心冲突 50008、对公账户缺项 10001、
 *                证照过期不得通过审核 50001、被引用/有历史结算不得停用 50002 …）
 *
 * ⚠️ 全局 `ValidationPipe` 开了 `forbidNonWhitelisted` —— DTO 未声明的字段会被
 *   **直接拒绝（10001）而非静默忽略**。别在前端偷偷多传一个 `id` 就以为能改主键。
 *
 * ⚠️ **金额入参用「分」（后缀 `Fen`）**：`ab_distribution_center.rice_fee` 是
 *   DECIMAL(8,2) 元列，但接口层统一收发「整数分」—— 端上只做 `fenToYuan` 显示，
 *   避免「入参元、出参分、库里又是元」的三重换算记忆负担。
 */

/** 手机号（中国大陆）· 与 L17 团长申请同一正则 */
const PHONE_RE = /^1[3-9]\d{9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 供应商付款方式（C11 P2-6：对公 / 对私 / 现金） */
export const PAYEE_TYPES = ['corporate', 'personal', 'cash'] as const;
export type PayeeType = (typeof PAYEE_TYPES)[number];

export const PAYEE_TYPE_LABEL: Record<PayeeType, string> = {
  corporate: '对公转账',
  personal: '对私转账',
  cash: '现金结算',
};

// ============================================================================
// D23 · 供应商名录
// ============================================================================

/** 资质有效期筛选（派生值，服务层实时算） */
export const LICENSE_STATES = Object.values(LicenseState);

export class AdminSuppliersQueryDto {
  @ApiPropertyOptional({ description: '类型过滤', enum: SupplierType })
  @IsOptional()
  @IsIn(Object.values(SupplierType), { message: '供应商类型不合法' })
  type?: string;

  @ApiPropertyOptional({ description: '合作状态：1 合作中 / 0 停用', enum: SupplierStatus })
  @IsOptional()
  @Type(() => Number)
  @IsIn(Object.values(SupplierStatus), { message: '状态需为 1（合作中）或 0（停用）' })
  status?: number;

  @ApiPropertyOptional({ description: '资质审核状态过滤', enum: SupplierAuditStatus })
  @IsOptional()
  @IsIn(Object.values(SupplierAuditStatus), { message: '审核状态不合法' })
  auditStatus?: string;

  @ApiPropertyOptional({
    description:
      '证照有效期过滤：normal 有效 / expiring 30 天内到期 / expired 已过期 / unknown 未登记',
    enum: LicenseState,
  })
  @IsOptional()
  @IsIn(LICENSE_STATES as unknown as string[], { message: '证照状态不合法' })
  licenseState?: string;

  @ApiPropertyOptional({ description: '主营品类（川菜/粤菜/汤/面点）' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  category?: string;

  @ApiPropertyOptional({ description: '关键词：名称 / 联系人 / 手机号 / 集散中心名（片段）' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  keyword?: string;

  @ApiPropertyOptional({ description: '页码，默认 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数，默认 20，上限 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class SupplierIdParamDto {
  @ApiProperty({ description: '供应商 id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id!: number;
}

// ============================================================================
// D24 / D25 · 新增 / 编辑供应商
// ============================================================================

/** 可写字段的公共集合（D24 取必填版，D25 取全选填版） */
class SupplierWriteFields {
  @ApiProperty({ description: '供应商名（不得使用主体品牌「巡礼之年」）', example: '三味屋' })
  @IsString()
  @MinLength(2, { message: '供应商名至少 2 个字' })
  @MaxLength(128)
  name!: string;

  @ApiProperty({
    description: '类型：dish 出餐型 / distribute 集散型 / both 混合型',
    enum: SupplierType,
  })
  @IsIn(Object.values(SupplierType), { message: '供应商类型不合法' })
  type!: string;

  @ApiProperty({ description: '联系人' })
  @IsString()
  @MinLength(2, { message: '联系人至少 2 个字' })
  @MaxLength(32)
  contactName!: string;

  @ApiProperty({ description: '联系电话（11 位手机号）' })
  @Matches(PHONE_RE, { message: '联系电话格式不正确' })
  contactPhone!: string;

  @ApiPropertyOptional({ description: '主营品类' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  category?: string;

  @ApiPropertyOptional({ description: '营业执照文件 URL 或编号（后置收集，允许为空）' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  businessLicense?: string;

  @ApiPropertyOptional({ description: '食品经营许可证文件 URL 或编号（后置收集，允许为空）' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  foodLicense?: string;

  @ApiPropertyOptional({ description: '食品经营许可证有效期 YYYY-MM-DD' })
  @IsOptional()
  @Matches(DATE_RE, { message: '证照有效期格式应为 YYYY-MM-DD' })
  licenseExpireAt?: string;

  @ApiPropertyOptional({ description: '地址（集散型必填）' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  address?: string;

  @ApiPropertyOptional({ description: '每日产能（份）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  capacityPerDay?: number;

  @ApiPropertyOptional({ description: '付款方式', enum: PAYEE_TYPES })
  @IsOptional()
  @IsIn(PAYEE_TYPES as unknown as string[], { message: '付款方式不合法' })
  payeeType?: PayeeType;
}

/** D24 新增供应商（P33 右上「新增」） */
export class CreateSupplierDto extends SupplierWriteFields {}

/** D25 编辑供应商（全部选填，只改传了的字段） */
export class UpdateSupplierDto {
  @ApiPropertyOptional({ description: '供应商名' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: '供应商名至少 2 个字' })
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({ description: '类型', enum: SupplierType })
  @IsOptional()
  @IsIn(Object.values(SupplierType), { message: '供应商类型不合法' })
  type?: string;

  @ApiPropertyOptional({ description: '联系人' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: '联系人至少 2 个字' })
  @MaxLength(32)
  contactName?: string;

  @ApiPropertyOptional({ description: '联系电话' })
  @IsOptional()
  @Matches(PHONE_RE, { message: '联系电话格式不正确' })
  contactPhone?: string;

  @ApiPropertyOptional({ description: '主营品类' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  category?: string;

  @ApiPropertyOptional({ description: '营业执照' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  businessLicense?: string;

  @ApiPropertyOptional({ description: '食品经营许可证' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  foodLicense?: string;

  @ApiPropertyOptional({ description: '食品经营许可证有效期 YYYY-MM-DD' })
  @IsOptional()
  @Matches(DATE_RE, { message: '证照有效期格式应为 YYYY-MM-DD' })
  licenseExpireAt?: string;

  @ApiPropertyOptional({ description: '地址' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  address?: string;

  @ApiPropertyOptional({ description: '每日产能（份）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  capacityPerDay?: number;

  @ApiPropertyOptional({ description: '付款方式', enum: PAYEE_TYPES })
  @IsOptional()
  @IsIn(PAYEE_TYPES as unknown as string[], { message: '付款方式不合法' })
  payeeType?: PayeeType;

  @ApiPropertyOptional({
    description: '合作状态：1 合作中 / 0 停用（D25 是供应商启停的**唯一入口**）',
    enum: SupplierStatus,
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(Object.values(SupplierStatus), { message: '状态需为 1（合作中）或 0（停用）' })
  status?: number;
}

// ============================================================================
// D26 · 资质审核
// ============================================================================

export const AUDIT_RESULTS = ['approved', 'rejected'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/** D26 资质审核（营业执照 + 食品经营许可证） */
export class AuditSupplierDto {
  @ApiProperty({ description: '审核结论：approved 通过 / rejected 驳回', enum: AUDIT_RESULTS })
  @IsIn(AUDIT_RESULTS as unknown as string[], { message: '审核结论需为 approved 或 rejected' })
  result!: AuditResult;

  @ApiPropertyOptional({
    description: '审核时补登的证照有效期 YYYY-MM-DD（approved 时若库中为空则必传）',
  })
  @IsOptional()
  @Matches(DATE_RE, { message: '证照有效期格式应为 YYYY-MM-DD' })
  licenseExpireAt?: string;

  @ApiPropertyOptional({ description: '审核意见（驳回时必填，≥2 字）' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  remark?: string;
}

// ============================================================================
// D27 · 设置类型
// ============================================================================

export class SetSupplierTypeDto {
  @ApiProperty({ description: '类型：dish / distribute / both', enum: SupplierType })
  @IsIn(Object.values(SupplierType), { message: '供应商类型不合法' })
  type!: string;
}

// ============================================================================
// D28 · 对公结算账户
// ============================================================================

export class SetSettleAccountDto {
  @ApiProperty({
    description: '付款方式：corporate 对公 / personal 对私 / cash 现金（C11）',
    enum: PAYEE_TYPES,
  })
  @IsIn(PAYEE_TYPES as unknown as string[], { message: '付款方式不合法' })
  payeeType!: PayeeType;

  @ApiPropertyOptional({ description: '开户行（payeeType=corporate 时必填）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankName?: string;

  @ApiPropertyOptional({ description: '银行账号（payeeType=corporate 时必填）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankAccount?: string;

  @ApiPropertyOptional({ description: '发票抬头（与展示名可能不同）' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  invoiceTitle?: string;
}

// ============================================================================
// 扩展 · 外卖平台店铺链接（原型 P33「外卖平台店铺链接配置」）
//
// ⚠️ 《接口规范》§6.4 未定义该接口 —— 原型与路由（`/supplier/takeout-links`）
//    已存在，此处按「扩展接口」补齐并在文档 §6.4 末尾登记，不占用已占号位。
// ============================================================================

export class TakeoutLinkItemDto {
  @ApiPropertyOptional({ description: '小程序路径或 H5 地址；传 null 表示清空该平台' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  url?: string | null;

  @ApiPropertyOptional({ description: '平台内店铺标识（运营核对用）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  shopId?: string | null;
}

/** 三个平台都声明为选填对象：只想改一家，不必把另外两家回传一遍 */
export class SetTakeoutLinksDto {
  @ApiPropertyOptional({ description: '美团外卖', type: TakeoutLinkItemDto })
  @IsOptional()
  @IsObject()
  @Type(() => TakeoutLinkItemDto)
  meituan?: TakeoutLinkItemDto;

  @ApiPropertyOptional({ description: '淘宝闪购', type: TakeoutLinkItemDto })
  @IsOptional()
  @IsObject()
  @Type(() => TakeoutLinkItemDto)
  taobao?: TakeoutLinkItemDto;

  @ApiPropertyOptional({ description: '京东外卖', type: TakeoutLinkItemDto })
  @IsOptional()
  @IsObject()
  @Type(() => TakeoutLinkItemDto)
  jd?: TakeoutLinkItemDto;

  @ApiPropertyOptional({
    description: '推荐平台（前端 `/supplier/takeout-links` 的「推荐」列）',
    enum: TakeoutPlatform,
  })
  @IsOptional()
  @IsIn(Object.values(TakeoutPlatform), { message: '推荐平台不合法' })
  recommended?: TakeoutPlatform;
}

// ============================================================================
// 扩展 · 菜品库维护（D7 依赖 `ab_dish.supplier_id` 反查供应商，必须有维护入口）
// ============================================================================

/**
 * 菜品档位 · **唯一真源在 `@abox/shared-types` 的 `DishCategory`**
 *
 * ⚠️ 不在此另写一份字符串数组：端上要显示中文档位名（主荤/半荤/素菜/汤品/主食），
 *    两处各写一套，就等着「后端认 main、前端显示成主菜」的漂移。
 * ⚠️ 与 `DishSlot`（套餐槽位）是两套枚举，见 `shared-types/enums/supplier-admin.ts` 的注释。
 */
export const DISH_CATEGORIES = Object.values(DishCategory);
export type DishCategoryValue = DishCategory;

export class AdminDishesQueryDto {
  @ApiPropertyOptional({ description: '按供应商过滤' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId?: number;

  @ApiPropertyOptional({ description: '档位过滤', enum: DISH_CATEGORIES })
  @IsOptional()
  @IsIn(DISH_CATEGORIES as unknown as string[], { message: '菜品档位不合法' })
  category?: string;

  @ApiPropertyOptional({ description: '上下架：1 上架 / 0 下架' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([0, 1], { message: '状态需为 1（上架）或 0（下架）' })
  status?: number;

  @ApiPropertyOptional({ description: '关键词：菜品名' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  keyword?: string;

  @ApiPropertyOptional({ description: '页码，默认 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数，默认 20，上限 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class DishIdParamDto {
  @ApiProperty({ description: '菜品 id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  id!: number;
}

/** 新增菜品（供价**逐菜协商** · C9，必填且 > 0） */
export class CreateDishDto {
  @ApiProperty({ description: '供应商 id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplierId!: number;

  @ApiProperty({ description: '菜品名' })
  @IsString()
  @MinLength(2, { message: '菜品名至少 2 个字' })
  @MaxLength(64)
  name!: string;

  @ApiProperty({ description: '档位', enum: DISH_CATEGORIES })
  @IsIn(DISH_CATEGORIES as unknown as string[], { message: '菜品档位不合法' })
  category!: string;

  @ApiProperty({
    description: '供价（**分**）· C9 逐菜协商价，与供应商单独约定，非固定口径',
    example: 750,
  })
  @Type(() => Number)
  @IsInt({ message: '供价需为整数分' })
  @Min(1, { message: '供价必须大于 0' })
  @Max(1000000)
  costPriceFen!: number;

  @ApiPropertyOptional({ description: '菜品描述 / 卖点' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @ApiPropertyOptional({ description: '图片 URL' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  imageUrl?: string;

  @ApiPropertyOptional({ description: '上下架：1 上架（默认）/ 0 下架' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([0, 1], { message: '状态需为 1（上架）或 0（下架）' })
  status?: number;
}

/** 编辑菜品（不含 supplierId —— 换供应商＝换一个供价主体，请新建菜品） */
export class UpdateDishDto {
  @ApiPropertyOptional({ description: '菜品名' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: '菜品名至少 2 个字' })
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '档位', enum: DISH_CATEGORIES })
  @IsOptional()
  @IsIn(DISH_CATEGORIES as unknown as string[], { message: '菜品档位不合法' })
  category?: string;

  @ApiPropertyOptional({ description: '供价（分）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '供价需为整数分' })
  @Min(1, { message: '供价必须大于 0' })
  @Max(1000000)
  costPriceFen?: number;

  @ApiPropertyOptional({ description: '菜品描述' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @ApiPropertyOptional({ description: '图片 URL' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  imageUrl?: string;

  @ApiPropertyOptional({ description: '上下架' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([0, 1], { message: '状态需为 1（上架）或 0（下架）' })
  status?: number;
}

/** 批量上下架（下架关联菜品的联动动作也要可追溯，故单独成一个显式接口） */
export class BatchDishStatusDto {
  @ApiProperty({ description: '菜品 id 列表', type: [Number] })
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  ids!: number[];

  @ApiProperty({ description: '目标状态：1 上架 / 0 下架' })
  @Type(() => Number)
  @IsIn([0, 1], { message: '状态需为 1（上架）或 0（下架）' })
  status!: number;

  @ApiPropertyOptional({ description: '变更原因（批量下架必填，便于回溯）' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  reason?: string;
}
