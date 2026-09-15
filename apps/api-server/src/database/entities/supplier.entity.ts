import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, moneyTransformer, rateTransformer, PkColumn } from './transformers';

/**
 * ab_supplier 供应商表
 * 依据：《ER v2.1》§4.3 + 《表结构评审意见 v1.0》P1-3（share_rate 废弃）、P2-6（银行信息可为空）
 * 供应商名（三味屋/四季鲜蔬/京味小馆/老李家）为**演示占位名**；
 * "巡礼之年"是主体公司品牌（北京巡礼之年科技有限公司），不得用作供应商名。
 */
@Entity('ab_supplier')
export class Supplier {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  /** dish 出餐型 / distribute 集散型 / both 混合型 */
  @Index('idx_supplier_type_status')
  @Column({ type: 'varchar', length: 16, default: 'dish' })
  type!: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 32 })
  contactName!: string;

  @Column({ name: 'contact_phone', type: 'varchar', length: 20 })
  contactPhone!: string;

  @Column({ name: 'business_license', type: 'varchar', length: 256, nullable: true })
  businessLicense?: string | null;

  @Column({ name: 'food_license', type: 'varchar', length: 256, nullable: true })
  foodLicense?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '主营：川菜/粤菜/汤/面点' })
  category?: string | null;

  @Column({
    name: 'share_rate',
    type: 'decimal', transformer: rateTransformer,
    precision: 5,
    scale: 4,
    default: 0,
    comment: '⚠️ 废弃（C9 后分账按菜品成本单价），仅为兼容历史数据，新逻辑不得读取',
  })
  shareRate!: string;

  @Column({ name: 'wx_sub_mch_id', type: 'varchar', length: 64, nullable: true, comment: '二期预留' })
  wxSubMchId?: string | null;

  /** C11：对公账户信息**后置收集**，允许为空，不阻塞开发 */
  @Column({ name: 'bank_account', type: 'varchar', length: 64, nullable: true, comment: '对公账户（可后置收集）' })
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

  /** 档位：main 主荤 / half 半荤 / veg 素菜 / soup 汤 / staple 主食 */
  @Index('idx_dish_category')
  @Column({ type: 'varchar', length: 32, nullable: true })
  category?: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description?: string | null;

  @Column({ name: 'cost_price', type: 'decimal', transformer: moneyTransformer, precision: 8, scale: 2, comment: '成本（分账依据 · C9）' })
  costPrice!: string;

  @Column({ name: 'sale_count', type: 'int', default: 0 })
  saleCount!: number;

  @Column({ type: 'decimal', transformer: moneyTransformer, precision: 3, scale: 2, default: 0, comment: '评分' })
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
@Index('uk_supplier_dish_date', ['supplierId', 'dishId', 'produceDate'], { unique: true })
export class SupplierDishDaily {
  @PkColumn()
  id!: number;

  @Column({ name: 'supplier_id', type: 'bigint', transformer: bigintTransformer })
  supplierId!: number;

  @Column({ name: 'dish_id', type: 'bigint', transformer: bigintTransformer })
  dishId!: number;

  @Index('idx_supplier_dish_date')
  @Column({ name: 'produce_date', type: 'date' })
  produceDate!: string;

  @Column({ name: 'plan_quantity', type: 'int', default: 0, comment: '计划生产量' })
  planQuantity!: number;

  @Column({ name: 'actual_quantity', type: 'int', nullable: true })
  actualQuantity?: number | null;

  @Column({ name: 'unit_price', type: 'decimal', transformer: moneyTransformer, precision: 8, scale: 2, comment: '分账单价' })
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
