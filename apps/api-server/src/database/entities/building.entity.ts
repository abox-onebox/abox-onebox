import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, coordTransformer, PkColumn } from './transformers';

/** ab_building 办公楼表（沿用 v1.0，无结构变更） */
@Entity('ab_building')
export class Building {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, comment: '办公楼名称' })
  name!: string;

  @Column({ type: 'varchar', length: 256 })
  address!: string;

  @Index('idx_building_city_district')
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

  @Column({ type: 'tinyint', default: 1, comment: '1合作中 2停用' })
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
export class BuildingGroup {
  @PkColumn()
  id!: number;

  @Column({ type: 'varchar', length: 64, comment: '楼群名，如"国贸商圈"' })
  name!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  description?: string | null;

  @Index('idx_building_group_city')
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
