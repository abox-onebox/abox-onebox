import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 独立券系统（2026-10-23）：新建两张表
 *   · `ab_coupon`        —— 代金券券种定义（后台管理：面额 / 门槛 / 有效期 / 限量）
 *   · `ab_user_coupon`   —— 用户持有券（发放记录 / 我的券 / 核券记录共用）
 *
 * 用途：推荐转正返券（referral）/ 售后补偿（compensation）/ 后台手动发券（manual）。
 * 下单选用券时抵扣落到订单 `discount_amount`（既有列，原恒 0）。
 *
 * ## 与实体逐列一致
 * 列名 / 类型 / 索引名 + 列序 + 唯一性须与 `entities/coupon.entity.ts` 逐项一致，
 * 否则 `schema:parity` / `index:parity` 转红。
 *
 * ## 幂等
 * `CREATE TABLE IF NOT EXISTS`（MySQL 8 天然幂等）；`down()` 对称 `DROP TABLE IF EXISTS`。
 */
const CREATE_COUPON_DEF = `CREATE TABLE IF NOT EXISTS \`ab_coupon\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`name\` VARCHAR(64) NOT NULL COMMENT '券名称',
    \`face_value\` DECIMAL(10,2) NOT NULL COMMENT '面额（元）',
    \`threshold\` DECIMAL(10,2) NOT NULL DEFAULT '0.00' COMMENT '使用门槛（元）；0 = 无门槛',
    \`validity_type\` VARCHAR(16) NOT NULL COMMENT 'days=领取后N天有效 / period=固定起止日',
    \`valid_days\` INT DEFAULT NULL COMMENT 'validity_type=days 时有效',
    \`valid_from\` DATE DEFAULT NULL COMMENT 'validity_type=period 时生效日',
    \`valid_to\` DATE DEFAULT NULL COMMENT 'validity_type=period 时失效日',
    \`total_limit\` INT DEFAULT NULL COMMENT '发行总量上限；null = 不限',
    \`issued_count\` INT NOT NULL DEFAULT 0 COMMENT '已发放数',
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active/inactive',
    \`remark\` VARCHAR(256) DEFAULT NULL,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='代金券券种定义（独立券系统）'`;

const CREATE_USER_COUPON = `CREATE TABLE IF NOT EXISTS \`ab_user_coupon\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '持有用户（ab_user.id）',
    \`code\` VARCHAR(32) NOT NULL COMMENT '唯一券码',
    \`coupon_def_id\` BIGINT UNSIGNED DEFAULT NULL COMMENT '关联券种定义（手动补偿券可空）',
    \`name\` VARCHAR(64) NOT NULL COMMENT '券名称（快照）',
    \`face_value\` DECIMAL(10,2) NOT NULL COMMENT '面额（元）',
    \`threshold\` DECIMAL(10,2) NOT NULL DEFAULT '0.00' COMMENT '使用门槛（元）；0 = 无门槛',
    \`valid_from\` DATETIME(3) NOT NULL COMMENT '生效时刻',
    \`valid_to\` DATETIME(3) NOT NULL COMMENT '失效时刻',
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'unused' COMMENT 'unused/used/expired',
    \`obtained_from\` VARCHAR(16) NOT NULL DEFAULT 'manual' COMMENT 'referral/compensation/manual/system/activity',
    \`used_at\` DATETIME(3) DEFAULT NULL COMMENT '核销时刻',
    \`order_no\` VARCHAR(32) DEFAULT NULL COMMENT '核销订单号',
    \`remark\` VARCHAR(256) DEFAULT NULL COMMENT '发放备注（补偿原因等）',
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uk_user_coupon_code\` (\`code\`),
    KEY \`idx_user_coupon_user_status\` (\`user_id\`,\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户持有券（发放/我的券/核券共用）'`;

export class Coupon1700000000017 implements MigrationInterface {
  name = 'Coupon1700000000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(CREATE_COUPON_DEF);
    await queryRunner.query(CREATE_USER_COUPON);
    console.log('   ↳ Coupon：建表 ab_coupon / ab_user_coupon（IF NOT EXISTS，重跑幂等）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `ab_user_coupon`');
    await queryRunner.query('DROP TABLE IF EXISTS `ab_coupon`');
  }
}
