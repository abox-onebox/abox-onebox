import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  SUPPLIER_AUDIT_STATUS_LABEL,
  SUPPLIER_STATUS_LABEL,
  SupplierAuditStatus,
  SupplierStatus,
} from '@abox/shared-types';

import { CurrentAdmin, Roles } from '../../common/decorators/auth.decorator';
import { OperationLog } from '../../common/decorators/operation-log.decorator';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  AdminSuppliersQueryDto,
  AuditSupplierDto,
  CreateSupplierDto,
  PAYEE_TYPE_LABEL,
  PayeeType,
  SetSettleAccountDto,
  SetTakeoutLinksDto,
  SupplierIdParamDto,
  UpdateSupplierDto,
} from './dto/supplier-admin.dto';
import { SupplierAdminService } from './supplier-admin.service';

/**
 * 后台 · 供应商管理（《接口规范 v1.0》§6.4 D23–D28 · 原型 P33 / 模块 M34-01~04）
 *
 * 路径 `admin/suppliers/*` —— 前缀 `admin/` 是 `JwtAuthGuard` 的**主体隔离**依据。
 * 注意供应商端（供应商 Web，role=supplier）的 S* 接口在 `modules/supplier/supplier.controller.ts`
 *（`@Controller('supplier')`），两者**同名不同主体**：一个管「平台看供应商」，一个管
 *「供应商看自己」，靠 `typ` 与路径前缀在鉴权层就分开了。
 *
 * ⚠️ **路由顺序**：`GET filter-options` 必须声明在 `GET :id` **之前**，
 *    否则 `/admin/suppliers/filter-options` 会被 `:id` 当成 id（同 D8 export / D19 的坑）。
 *
 * ⚠️ **两级白名单**（与 M3-4/M3-5 同一设计）：
 *    类级放 `operator` —— 运营要能看名录、跟进资质补办；
 *    D24–D28 与外卖链接**方法级收窄到 `super_admin`/`admin`** ——
 *    填供应商档案、审资质、改结算账户，都是「决定钱付给谁」的事。
 *    `finance` 同样收窄掉（菜单矩阵 `admin-role.ts` 里财务本就没有 `/supplier/*`）：
 *    若 API 放行而菜单没有，就会出现「能调但进不去」的诡异状态。
 *
 * ⚠️ **M4-0（自营口径）：D27「设置类型」已下线** —— 自营下不存在「承担集散的供应商」，
 *    「出餐型 / 集散型 / 混合型」三分法失效，端点整体删除而非返回固定值
 *    （留一个「点了没区别」的按钮，运营会以为平台还在按类型分配职责）。
 *    原 50008 闸门（本控制器 3 处 + D30/D31 那侧同一规则）随之删除，号位保留。
 */
@ApiTags('后台·供应商管理')
@ApiBearerAuth()
@Controller('admin/suppliers')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class SupplierAdminController {
  constructor(private readonly supplierAdmin: SupplierAdminService) {}

  // ------------------------------------------------------------ D23 名录

  @Get()
  @ApiOperation({
    summary: 'D23 供应商名录',
    description:
      '按类型 / 合作状态 / 资质审核状态 / 证照有效期 / 品类 / 关键词筛选。' +
      'summary 为同一过滤条件的全量统计（翻页不跳 KPI）；' +
      '`licenseState`（normal/expiring/expired/unknown）是派生值，不落库；' +
      '`canServe` = 合作中 ∧ 资质已通过 ∧ 证照未过期（S2 出餐前置校验的同一判据）。' +
      '列表手机号一律脱敏，详情才回真实号码。',
  })
  list(@Query() q: AdminSuppliersQueryDto, @CurrentAdmin('role') role: string) {
    return this.supplierAdmin.list(q, role);
  }

  @Get('filter-options')
  @ApiOperation({
    summary: 'D23 附属 · 筛选器下拉（审核状态 / 合作状态 / 付款方式）',
    description:
      '关键字补充：品类下拉由列表接口的 `categoryOptions` 动态下发（真实数据去重），' +
      '此处只回枚举类选择器。独立成接口而非复用 `/admin/meal/dishes`：' +
      '后者供套餐编排选菜，语义是「有没有这道菜」，与「有哪些品类」不是一回事。' +
      '⚠️ M4-0 起**不再下发 `typeOptions`** —— 供应商类型已停用（自营下只有一种角色）。',
  })
  filterOptions() {
    return {
      auditStatusOptions: Object.values(SupplierAuditStatus).map((v) => ({
        value: v,
        label: SUPPLIER_AUDIT_STATUS_LABEL[v],
      })),
      statusOptions: [SupplierStatus.ACTIVE, SupplierStatus.SUSPENDED].map((v) => ({
        value: v,
        label: SUPPLIER_STATUS_LABEL[v],
      })),
      payeeTypeOptions: (Object.keys(PAYEE_TYPE_LABEL) as PayeeType[]).map((v) => ({
        value: v,
        label: PAYEE_TYPE_LABEL[v],
      })),
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'D23 附属 · 供应商详情（档案 + 菜品 + 应付 + 操作日志）',
    description:
      '含真实联系电话与脱敏后的银行账号。⚠️ 银行账号原文**任何后台接口都不回**，' +
      '付款登记时由财务线下核对（服务端只存不回，避免日志/截图泄露）。' +
      '⚠️ M4-0 起不再回 `distributionCenters` —— 加工场所属 ABox 自有，不挂在供应商名下。',
  })
  detail(@Param() p: SupplierIdParamDto) {
    return this.supplierAdmin.detail(p.id);
  }

  // ------------------------------------------------------------ D24 / D25

  @Post()
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '新增供应商' })
  @ApiOperation({
    summary: 'D24 新增供应商',
    description:
      '新建即 `audit_status=pending`：资质未核验前 `canServe=false`，出餐前置校验会拦（50001）。' +
      '证照与银行账户允许后置收集（C11），但**通过审核时必须有未过期的证照有效期**。',
  })
  create(@Body() dto: CreateSupplierDto) {
    return this.supplierAdmin.create(dto);
  }

  @Put(':id')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '编辑供应商', targetParam: 'id' })
  @ApiOperation({
    summary: 'D25 编辑供应商（含启停）',
    description:
      '部分更新，只改传了的字段。⚠️ 一个隐式副作用会在出参回报：' +
      '把 `licenseExpireAt` 改成过去 → **同步下架关联菜品**并回 `unpublishedDishCount`。' +
      '本接口是供应商启停的**唯一入口**（D 系列没有单独的停用接口）。' +
      '⚠️ M4-0 起不再收 `type`（供应商类型已停用，传上来即 10001）。',
  })
  update(@Param() p: SupplierIdParamDto, @Body() dto: UpdateSupplierDto) {
    return this.supplierAdmin.update(p.id, dto);
  }

  // ------------------------------------------------------------ D26 资质审核

  @Post(':id/audit')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '供应商资质审核', targetParam: 'id' })
  @ApiOperation({
    summary: 'D26 资质审核（营业执照 · 食品经营许可证）',
    description:
      '⚠️ 审核**不影响**合作状态（status）—— 审核是事实判定，停用是经营决策，' +
      '驳回后不会自动把商家下架，需运营在 D25 显式停用。' +
      'approved 要求库中或入参有**未过期**的证照有效期，否则 50001（证照有效期不接受后置补）；' +
      'rejected 必须填审核意见（≥2 字）。',
  })
  audit(
    @Param() p: SupplierIdParamDto,
    @Body() dto: AuditSupplierDto,
    @CurrentAdmin('sub') adminUserId: number,
  ) {
    return this.supplierAdmin.audit(p.id, dto, adminUserId);
  }

  // ------------------------------------------------------------ D27 已下线
  //
  // `PUT /admin/suppliers/:id/type` **已随自营口径移除**（M4-0）：
  // 自营下不存在「承担集散的供应商」，「出餐型 / 集散型 / 混合型」三分法失效
  // （供应商只有一种角色：半成品供货方），`ab_supplier.type` 列保留为历史字段。
  // 刻意**整条路由删掉**而不是「返回固定值 / 忽略入参」——
  // 后者会让运营以为类型还在起作用，只是暂时改不了。

  // ------------------------------------------------------------ D28 结算账户

  @Put(':id/settle-account')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '更新供应商结算账户', targetParam: 'id' })
  @ApiOperation({
    summary: 'D28 对公结算账户（开户行 · 账号 · 发票抬头）',
    description:
      'C10：供应商与集散走**人工对公转账**，系统只出应付结算单与回单号，不接支付通道。' +
      '`payeeType=corporate` 时开户行与账号必填（服务层校验）；' +
      '响应只回 `bankAccountMasked`，账号原文不回传。',
  })
  setSettleAccount(@Param() p: SupplierIdParamDto, @Body() dto: SetSettleAccountDto) {
    return this.supplierAdmin.setSettleAccount(p.id, dto);
  }

  // ------------------------------------------------------------ 扩展 · 外卖链接

  @Put(':id/takeout-links')
  @Roles('super_admin', 'admin')
  @OperationLog({ module: 'supplier', action: '配置外卖平台链接', targetParam: 'id' })
  @ApiOperation({
    summary: '扩展 · 外卖平台店铺链接（美团 / 淘宝闪购 / 京东）',
    description:
      '⚠️ 《接口规范》§6.4 原 D 系列未定义本接口，按原型 P33「外卖平台店铺链接配置」补齐并登记为扩展。' +
      '只传要改的平台（未传 = 保持原值）；传 `url: null` = 清空该平台（「未入驻」是合法状态）。' +
      'C8 约束：能跳转 ≠ 是合作伙伴，平台永不下发「哪些是备选商家」。',
  })
  setTakeoutLinks(@Param() p: SupplierIdParamDto, @Body() dto: SetTakeoutLinksDto) {
    return this.supplierAdmin.setTakeoutLinks(p.id, dto);
  }
}
