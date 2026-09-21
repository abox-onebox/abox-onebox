import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, moneyTransformer, rateTransformer, PkColumn } from './transformers';

/**
 * ab_supplier 供应商表
 * 依据：《ER v2.1》§4.3 + 《表结构评审意见 v1.0》P1-3（share_rate 废弃）、P2-6（银行信息可为空）
 * 供应商名（三味屋/四季鲜蔬/京味小馆/老李家）为**演示占位名**；
 * "巡礼之年"是主体公司品牌（北京巡礼之年科技有限公司），不得用作供应商名。
 */
@Entity('ab_supplier')
@Index('idx_supplier_type_status', ['type', 'status'])
export class Supplier {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  /**
   * ⚠️ **自营下已停用（历史字段 · 2026-09-16 路线裁定）**
   *
   * 「出餐型 / 集散型 / 混合型」三分法建立在「供应商入驻 + 供应商自己承担集散」之上。
   * 单主体自营后**不存在**「承担集散的供应商」—— 供应商只有一种角色：**半成品供货方**
   * （供货 + 报价，菜单由 ABox 定、热加工与打包在 ABox 自有场所完成）。
   * 三个枚举值中只剩一个成立，留着它就是「给了选择、选了没区别」。
   *
   * 处置：D27 设置类型**端点已下线**、D24/D25 新建编辑**已停收**、D23 筛选与展示**已移除**、
   * `SUPPLIER_TYPE_CONFLICT`(50008) 三处闸门**已删除**。本列保留仅为兼容历史行与索引，
   * **任何逻辑不得再读**（同 `share_rate` / `ab_distribution_center.supplier_id` 的处理）。
   */
  @Column({
    type: 'varchar',
    length: 16,
    default: 'dish',
    comment: '⚠️ 已停用（自营前历史字段）：自营下供应商只有「半成品供货方」一种角色',
  })
  type!: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 32 })
  contactName!: string;

  @Column({ name: 'contact_phone', type: 'varchar', length: 20 })
  contactPhone!: string;

  @Column({ name: 'business_license', type: 'varchar', length: 256, nullable: true })
  businessLicense?: string | null;

  @Column({ name: 'food_license', type: 'varchar', length: 256, nullable: true })
  foodLicense?: string | null;

  /**
   * 资质审核状态（D26 落点）· pending 待审 / approved 通过 / rejected 驳回
   *
   * ⚠️ 与 `status`（合作中/停用）**正交**：审核回答「有没有合规资格」，
   *    停用回答「平台现在要不要合作」。驳回不自动停用 ——
   *    审核是事实判定，停用是经营决策。但出餐前置校验读本列，未通过即 50001。
   */
  @Column({
    name: 'audit_status',
    type: 'varchar',
    length: 16,
    default: 'pending',
    comment: 'pending待审 / approved通过 / rejected驳回（D26）',
  })
  auditStatus!: string;

  /** 审核意见（驳回时必填，便于运营答复商家） */
  @Column({ name: 'audit_remark', type: 'varchar', length: 256, nullable: true })
  auditRemark?: string | null;

  @Column({ name: 'audited_at', type: 'datetime', precision: 3, nullable: true })
  auditedAt?: Date | null;

  /** 审核人（ab_admin_user.id；自动拦截器无法表达「审谁」，故显式落库） */
  @Column({ name: 'audited_by', type: 'bigint', transformer: bigintTransformer, nullable: true })
  auditedBy?: number | null;

  /**
   * 食品经营许可证有效期（D26 入参 · 原型 P33「资质到期」列）
   *
   * ⚠️ 为何必须有：123 号令要求平台核验入网商户证照，**证照过期即不得出餐**。
   *    没有本列，「资质 30 天内到期 / 已过期」两个 KPI 与到期联动下架都无从算起
   *    （原型 P33 已明确展示该列表说明了联动行为）。可空 = 兼容历史行，不是「可以不登记」。
   */
  @Column({ name: 'license_expire_at', type: 'date', nullable: true })
  licenseExpireAt?: string | null;

  /** 发票抬头（D28 入参；与展示名 `name` 可能不同，故独立成列） */
  @Column({ name: 'invoice_title', type: 'varchar', length: 128, nullable: true })
  invoiceTitle?: string | null;

  /**
   * 外卖平台店铺链接（原型 P33「外卖平台店铺链接配置」· 美团/淘宝/京东）
   *
   * 结构固定（3 平台 + 可选推荐），且**不参与任何结算计算** → 用一列 JSON 而非独立表，
   * 换掉一整张表与一套 CRUD。用途仅限用户端 P38 溯源页的外卖跳转。
   * ⚠️ C8：能跳转 ≠ 是合作伙伴，平台永不下发「备选商家」概念。
   */
  @Column({ name: 'takeout_links', type: 'json', nullable: true })
  takeoutLinks?: Record<string, { url: string | null; shopId?: string | null }> | null;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '主营：川菜/粤菜/汤/面点' })
  category?: string | null;

  @Column({
    name: 'share_rate',
    type: 'decimal',
    transformer: rateTransformer,
    precision: 5,
    scale: 4,
    default: 0,
    comment: '⚠️ 废弃（C9 后按菜品协商采购价），仅为兼容历史数据，新逻辑不得读取',
  })
  shareRate!: string;

  @Column({
    name: 'wx_sub_mch_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '二期预留',
  })
  wxSubMchId?: string | null;

  /** C11：对公账户信息**后置收集**，允许为空，不阻塞开发 */
  @Column({
    name: 'bank_account',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '对公账户（可后置收集）',
  })
  bankAccount?: string | null;

  @Column({ name: 'bank_name', type: 'varchar', length: 64, nullable: true })
  bankName?: string | null;

  @Column({
    name: 'payee_type',
    type: 'varchar',
    length: 16,
    default: 'corporate',
    comment: 'corporate对公 / personal对私 / cash现金（付款登记用 · C11 P2-6）',
  })
  payeeType!: string;

  @Column({ type: 'varchar', length: 256, nullable: true, comment: '集散中心地址' })
  address?: string | null;

  @Column({ name: 'capacity_per_day', type: 'int', nullable: true, comment: '每日产能' })
  capacityPerDay?: number | null;

  @Column({ type: 'tinyint', default: 1, comment: '1合作中 0停用' })
  status!: number;

  @Column({ name: 'total_served', type: 'int', default: 0 })
  totalServed!: number;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'datetime', precision: 3, nullable: true })
  deletedAt?: Date | null;
}

/** ab_dish 菜品库（沿用 v1.0） */
@Entity('ab_dish')
@Index('idx_dish_category', ['category', 'status'])
export class Dish {
  @PkColumn()
  id!: number;

  @Index('idx_dish_supplier')
  @Column({ name: 'supplier_id', type: 'bigint', transformer: bigintTransformer })
  supplierId!: number;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ name: 'image_url', type: 'varchar', length: 512, nullable: true })
  imageUrl?: string | null;

  /** 品类轴：main 主荤 / half 半荤 / veg 素菜 / soup 汤品 / staple 主食（展示文案见 DISH_CATEGORY_LABEL） */
  @Column({ type: 'varchar', length: 32, nullable: true })
  category?: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description?: string | null;

  @Column({
    name: 'cost_price',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 8,
    scale: 2,
    comment: '菜品供价（C9 修订：与供应商**逐菜协商**，非固定口径）',
  })
  costPrice!: string;

  @Column({ name: 'sale_count', type: 'int', default: 0 })
  saleCount!: number;

  @Column({
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 3,
    scale: 2,
    default: 0,
    comment: '评分',
  })
  rating!: string;

  @Column({ type: 'tinyint', default: 1, comment: '1上架 0下架' })
  status!: number;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'datetime', precision: 3, nullable: true })
  deletedAt?: Date | null;
}

/** ab_supplier_dish_daily 供应商每日生产哪道菜（ER v2.1 §3.5） */
@Entity('ab_supplier_dish_daily')
@Index('idx_supplier_dish_date', ['produceDate', 'status'])
@Index('uk_supplier_dish_date', ['supplierId', 'dishId', 'produceDate'], { unique: true })
export class SupplierDishDaily {
  @PkColumn()
  id!: number;

  @Column({ name: 'supplier_id', type: 'bigint', transformer: bigintTransformer })
  supplierId!: number;

  @Column({ name: 'dish_id', type: 'bigint', transformer: bigintTransformer })
  dishId!: number;

  @Column({ name: 'produce_date', type: 'date' })
  produceDate!: string;

  @Column({ name: 'plan_quantity', type: 'int', default: 0, comment: '计划生产量' })
  planQuantity!: number;

  @Column({ name: 'actual_quantity', type: 'int', nullable: true })
  actualQuantity?: number | null;

  @Column({
    name: 'unit_price',
    type: 'decimal',
    transformer: moneyTransformer,
    precision: 8,
    scale: 2,
    comment: '协商采购价（逐菜议定）',
  })
  unitPrice!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending', comment: 'pending/cooking/done' })
  status!: string;

  @Column({ name: 'completed_at', type: 'datetime', precision: 3, nullable: true })
  completedAt?: Date | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/**
 * ab_supplier_dish_center_daily 供应商-菜品-**集散中心**-日 交付确认明细（M3-8 · S2 载体）
 *
 * ## 为什么不把这条明细塞进父表的 JSON 列
 * 粒度天然是**一对多**：一道菜同一天要分别送到 N 个集散中心。
 * 原型 P22 实证 —— 红烧肉当日 385 份 → 集散中心 1/2/3/4 各 120/96/88/81 份，
 * 而「出餐确认」的交互粒度**正是按集散中心逐项勾选**。于是：
 *   ① JSON 列无法做「哪些集散中心还没确认」的 SQL 聚合（S3 打包闸门刚需）；
 *   ② 确认是一个**事件**（实送份数 + 操作人 + 时点），并发确认同一父行的 JSON 会**丢更新**；
 *   ③ S3 要按集散中心 join 出「所有供应商的到位情况」，JSON 到不了。
 * 故参照 `ab_set_meal_item`（套餐 → 菜 → 供应商）的明细独立成表风格。
 *
 * ⚠️ 与父表的关系：本表是明细、父表 `ab_supplier_dish_daily` 是**日计划总量**。
 *    父表 `status` 由本表派生驱动 —— 全部分中心 confirmed 时，父表才置 `done`。
 */
@Entity('ab_supplier_dish_center_daily')
@Index('idx_sddc_date_center', ['produceDate', 'distributionCenterId'])
@Index('uk_sddc', ['supplierId', 'dishId', 'produceDate', 'distributionCenterId'], { unique: true })
export class SupplierDishCenterDaily {
  @PkColumn()
  id!: number;

  @Index('idx_sddc_supplier')
  @Column({ name: 'supplier_id', type: 'bigint', transformer: bigintTransformer })
  supplierId!: number;

  @Column({ name: 'dish_id', type: 'bigint', transformer: bigintTransformer })
  dishId!: number;

  @Column({ name: 'produce_date', type: 'date', comment: '出餐日（= 套餐日 T，非确认操作日）' })
  produceDate!: string;

  @Column({
    name: 'distribution_center_id',
    type: 'bigint',
    transformer: bigintTransformer,
    comment: '送达目标集散中心',
  })
  distributionCenterId!: number;

  @Column({ name: 'plan_quantity', type: 'int', default: 0, comment: '应送份数（分中心）' })
  planQuantity!: number;

  @Column({
    name: 'actual_quantity',
    type: 'int',
    nullable: true,
    comment: '实送份数；确认时登记，短送/多送都要留痕（对账依据）',
  })
  actualQuantity?: number | null;

  @Column({ type: 'varchar', length: 16, default: 'pending', comment: 'pending / confirmed' })
  status!: string;

  @Column({ name: 'confirmed_at', type: 'datetime', precision: 3, nullable: true })
  confirmedAt?: Date | null;

  @Column({
    name: 'confirmed_by',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '确认操作账号（ab_admin_user.id）—— 出餐确认是责任动作，必须留痕',
  })
  confirmedBy?: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '备注（如短送原因）' })
  remark?: string | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
