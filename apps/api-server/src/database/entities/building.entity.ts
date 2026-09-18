import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, coordTransformer, PkColumn } from './transformers';

/**
 * ab_building 办公楼表
 *
 * 结构沿革：v1.0 建表 → **M3-7 增 1 列**（`population`）+ 状态语义扩为三态
 * （见《ER v2.1》§5.6）。
 */
@Entity('ab_building')
@Index('idx_building_city_district', ['city', 'district'])
export class Building {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, comment: '办公楼名称' })
  name!: string;

  @Column({ type: 'varchar', length: 256 })
  address!: string;

  @Column({ type: 'varchar', length: 32, default: '北京' })
  city!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  district?: string | null;

  @Column({
    type: 'decimal',
    transformer: coordTransformer,
    precision: 10,
    scale: 6,
    nullable: true,
  })
  longitude?: string | null;

  @Column({
    type: 'decimal',
    transformer: coordTransformer,
    precision: 10,
    scale: 6,
    nullable: true,
  })
  latitude?: string | null;

  @Column({ name: 'floor_count', type: 'int', nullable: true })
  floorCount?: number | null;

  @Index('idx_building_group_rel')
  @Column({
    name: 'building_group_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '所属楼群（ER v2.1 §二）',
  })
  buildingGroupId?: number | null;

  /**
   * 覆盖人数（估算 · M3-7 新增）
   *
   * 用途：备料量测算与楼栋容量评估（原型 P37 列表「约 520 人」）。
   * ⚠️ 这是**运营录入的估算值**，不是实时统计 —— 真实就餐人数看订单量，
   *    两者混用会让「覆盖率」类指标失去意义。
   */
  @Column({ type: 'int', nullable: true, comment: '覆盖人数（估算）' })
  population?: number | null;

  /**
   * 状态三态（M3-7 扩展，见 `@abox/shared-types` `BuildingStatus`）
   *
   * `1` 营业中 · `2` 待开通 · `3` 已暂停。
   * ⚠️ M3-7 之前注释为「1合作中 2停用」，而种子把「待开通」与「已暂停」都写成 2
   *    —— 一值两义。tinyint 值域扩展修复该缺陷，`1` 的语义未变。
   * **只有 `1` 可开团**：套餐编排里 2/3 一律禁选。
   */
  @Index('idx_building_status')
  @Column({ type: 'tinyint', default: 1, comment: '1营业中 2待开通 3已暂停' })
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

/**
 * ab_building_group 楼群表（多栋楼聚合为一个分发单位）
 * 依据：《ER v2.1》§3.1
 */
@Entity('ab_building_group')
@Index('idx_building_group_city', ['city', 'district'])
export class BuildingGroup {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, comment: '楼群名，如"国贸商圈"' })
  name!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  description?: string | null;

  @Column({ type: 'varchar', length: 32, default: '北京' })
  city!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  district?: string | null;

  @Column({ type: 'tinyint', default: 1, comment: '1启用 2停用' })
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
