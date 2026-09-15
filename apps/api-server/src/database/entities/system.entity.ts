import { Column, CreateDateColumn, UpdateDateColumn, Entity, Index } from 'typeorm';
import { bigintTransformer, PkColumn } from './transformers';

/** ab_admin_user 后台账号（运营后台 + 供应商后台，按 role 过滤菜单） */
@Entity('ab_admin_user')
export class AdminUser {
  @PkColumn()
  id!: number;

  @Index('uk_admin_username', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  username!: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 128 })
  passwordHash!: string;

  @Column({ name: 'real_name', type: 'varchar', length: 32, nullable: true })
  realName?: string | null;

  @Column({
    type: 'varchar',
    length: 32,
    default: 'operator',
    comment: 'super_admin/admin/operator/finance/viewer/supplier',
  })
  role!: string;

  /** 供应商账号绑定 ab_supplier.id（role=supplier 时使用） */
  @Column({ name: 'supplier_id', type: 'bigint', transformer: bigintTransformer, nullable: true })
  supplierId?: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone?: string | null;

  @Column({ type: 'tinyint', default: 1 })
  status!: number;

  @Column({ name: 'last_login_at', type: 'datetime', precision: 3, nullable: true })
  lastLoginAt?: Date | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** ab_operation_log 操作日志（含 snapshot 变更前后值 · P2-1） */
@Entity('ab_operation_log')
export class OperationLog {
  @PkColumn()
  id!: number;

  @Index('idx_oplog_user_time')
  @Column({ name: 'admin_user_id', type: 'bigint', transformer: bigintTransformer, nullable: true })
  adminUserId?: number | null;

  @Index('idx_oplog_module_action')
  @Column({ type: 'varchar', length: 32, comment: '模块名' })
  module!: string;

  @Column({ type: 'varchar', length: 32, comment: '操作类型' })
  action!: string;

  @Column({ name: 'target_id', type: 'varchar', length: 64, nullable: true, comment: '对象ID' })
  targetId?: string | null;

  @Column({ name: 'request_ip', type: 'varchar', length: 64, nullable: true })
  requestIp?: string | null;

  @Column({ name: 'request_data', type: 'json', nullable: true })
  requestData?: unknown;

  @Column({ name: 'response_data', type: 'json', nullable: true })
  responseData?: unknown;

  @Column({ type: 'json', nullable: true, comment: '变更前后值快照（P2-1，审计回放）' })
  snapshot?: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}

/** ab_config 系统配置字典（业务参数运行期可调，权威来源见 docs/） */
@Entity('ab_config')
export class SysConfig {
  @PkColumn()
  id!: number;

  @Index('uk_config_key', { unique: true })
  @Column({ name: 'config_key', type: 'varchar', length: 64 })
  configKey!: string;

  @Column({ name: 'config_value', type: 'text' })
  configValue!: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  description?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** ab_message 消息推送日志（订阅消息，保留 90 天） */
@Entity('ab_message')
export class Message {
  @PkColumn()
  id!: number;

  @Index('idx_msg_user_time')
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer, nullable: true })
  userId?: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  openid?: string | null;

  @Column({ name: 'template_id', type: 'varchar', length: 64, comment: '微信订阅消息模板ID' })
  templateId!: string;

  @Column({ type: 'json' })
  payload!: unknown;

  @Index('idx_msg_status')
  @Column({ type: 'varchar', length: 16, default: 'pending', comment: 'pending/success/fail' })
  status!: string;

  @Column({ name: 'error_msg', type: 'varchar', length: 256, nullable: true })
  errorMsg?: string | null;

  @Column({ name: 'sent_at', type: 'datetime', precision: 3, nullable: true })
  sentAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}
