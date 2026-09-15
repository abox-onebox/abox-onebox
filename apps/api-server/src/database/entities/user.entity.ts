import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, PkColumn } from './transformers';

/**
 * ab_user 用户表
 * 说明（ER v2.1）：phone 可选；已删除 company_id / floor；
 * team_leader_id 为关键字段（注册时绑定所属团长，用户跟随团长取餐）
 */
@Entity('ab_user')
export class User {
  @PkColumn()
  id!: number;

  @Index('uk_user_openid', { unique: true })
  @Column({ type: 'varchar', length: 64, comment: '微信 openid' })
  openid!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  unionid?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  nickname?: string | null;

  @Column({ name: 'avatar_url', type: 'varchar', length: 512, nullable: true })
  avatarUrl?: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, comment: '可选，普通用户可不填' })
  phone?: string | null;

  @Index('idx_user_phone_hash')
  @Column({ name: 'phone_hash', type: 'varchar', length: 64, nullable: true })
  phoneHash?: string | null;

  @Column({ type: 'tinyint', default: 0 })
  gender!: number;

  @Index('idx_user_building')
  @Column({ name: 'building_id', type: 'bigint', transformer: bigintTransformer, nullable: true, comment: '跟随团长所属办公楼' })
  buildingId?: number | null;

  @Index('idx_user_team_leader')
  @Column({ name: 'team_leader_id', type: 'bigint', transformer: bigintTransformer, nullable: true, comment: '所属团长' })
  teamLeaderId?: number | null;

  @Column({ name: 'subscribe_flag', type: 'json', nullable: true })
  subscribeFlag?: Record<string, number> | null;

  @Column({ type: 'tinyint', default: 1, comment: '1正常 2黑名单' })
  status!: number;

  @Column({ name: 'last_order_at', type: 'datetime', precision: 3, nullable: true })
  lastOrderAt?: Date | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'datetime', precision: 3, nullable: true })
  deletedAt?: Date | null;
}
