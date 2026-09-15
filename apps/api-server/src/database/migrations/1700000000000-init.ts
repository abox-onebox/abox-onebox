import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 初始迁移 —— 24 张表（MySQL 8 · utf8mb4 · InnoDB）
 *
 * 依据：《数据库 ER 设计 v2.1》+《表结构评审意见 v1.0》
 *   P0-1 team_leader 补 level / month_orders / invited_formal_count / last_order_at，费率默认 0.08
 *   P0-2 order.status 补 refund_applying / refunding
 *   P0-3 meal_assignment.distribute_supplier_id → distribution_center_id
 *   P0-4 新增 leader_invite
 *   P0-5 补 refund 完整 DDL
 *   P0-6 补 commission / supplier_share 完整 DDL
 *   P1-4 set_meal 仅保留启用开关
 *   P1-5 MVP 阶段 ab_order **暂不分区**（单量破万再引入）
 *   P2-1 operation_log 增 snapshot；P2-5 commission/balance_log 增出款字段；P2-6 supplier 银行字段可空
 *
 * 约定：金额 DECIMAL(10,2) / 时间 DATETIME(3) UTC+8 / 软删除 deleted_at / 表前缀 ab_
 * 说明：sqlite 模式不使用本迁移（由 synchronize 自动建表）
 */
const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS \`ab_user\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`openid\` VARCHAR(64) NOT NULL COMMENT '微信 openid',
    \`unionid\` VARCHAR(64) DEFAULT NULL,
    \`nickname\` VARCHAR(64) DEFAULT NULL,
    \`avatar_url\` VARCHAR(512) DEFAULT NULL,
    \`phone\` VARCHAR(20) DEFAULT NULL COMMENT '可选，普通用户可不填',
    \`phone_hash\` VARCHAR(64) DEFAULT NULL,
    \`gender\` TINYINT NOT NULL DEFAULT 0,
    \`building_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`team_leader_id\` BIGINT UNSIGNED DEFAULT NULL COMMENT '所属团长；邀请链接注册即绑定，自然流量可后置',
    \`subscribe_flag\` JSON DEFAULT NULL,
    \`status\` TINYINT NOT NULL DEFAULT 1 COMMENT '1正常 2黑名单',
    \`last_order_at\` DATETIME(3) DEFAULT NULL,
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    \`deleted_at\` DATETIME(3) DEFAULT NULL,
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_user_openid\` (\`openid\`),
    KEY \`idx_user_phone_hash\` (\`phone_hash\`), KEY \`idx_user_building\` (\`building_id\`),
    KEY \`idx_user_team_leader\` (\`team_leader_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表'`,

  `CREATE TABLE IF NOT EXISTS \`ab_team_leader\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`user_id\` BIGINT UNSIGNED NOT NULL,
    \`building_id\` BIGINT UNSIGNED NOT NULL,
    \`phone\` VARCHAR(20) NOT NULL,
    \`real_name\` VARCHAR(32) NOT NULL,
    \`floor\` VARCHAR(32) DEFAULT NULL COMMENT '楼层，如 12F（2026-09-15 裁定补回）',
    \`level\` VARCHAR(16) NOT NULL DEFAULT 'trainee' COMMENT 'trainee/formal/gold/chief（C2）',
    \`level_updated_at\` DATETIME(3) DEFAULT NULL COMMENT '最近升级时间',
    \`commission_rate\` DECIMAL(5,4) NOT NULL DEFAULT 0.0800 COMMENT '随 level 联动 8/9/10/12%',
    \`total_orders\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`month_orders\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当月完成份数（C2）',
    \`invited_formal_count\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '累计介绍并转正团长数（C2）',
    \`total_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    \`total_commission\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    \`withdrawn_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    \`pending_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    \`balance\` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '可用余额',
    \`payout_type\` VARCHAR(16) DEFAULT NULL COMMENT 'bank/alipay（2026-09-15 补 · L12 40007 绑定态载体）',
    \`payout_account\` VARCHAR(64) DEFAULT NULL COMMENT '收款账号（脱敏）',
    \`payout_name\` VARCHAR(32) DEFAULT NULL COMMENT '收款人姓名',
    \`status\` TINYINT NOT NULL DEFAULT 1 COMMENT '1在职 2停职',
    \`agreed_at\` DATETIME(3) DEFAULT NULL COMMENT '勾选协议时间（C3 提交即生效）',
    \`agree_version\` VARCHAR(16) DEFAULT NULL,
    \`last_order_at\` DATETIME(3) DEFAULT NULL COMMENT '最近促成订单（C2 见习 30 天失效）',
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    \`deleted_at\` DATETIME(3) DEFAULT NULL,
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_team_leader_user\` (\`user_id\`),
    KEY \`idx_team_leader_building\` (\`building_id\`), KEY \`idx_team_leader_level_status\` (\`level\`,\`status\`),
    KEY \`idx_team_leader_last_order\` (\`last_order_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团长表'`,

  `CREATE TABLE IF NOT EXISTS \`ab_building\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`name\` VARCHAR(64) NOT NULL, \`address\` VARCHAR(256) NOT NULL,
    \`city\` VARCHAR(32) NOT NULL DEFAULT '北京', \`district\` VARCHAR(32) DEFAULT NULL,
    \`longitude\` DECIMAL(10,6) DEFAULT NULL, \`latitude\` DECIMAL(10,6) DEFAULT NULL,
    \`floor_count\` INT DEFAULT NULL, \`building_group_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`status\` TINYINT NOT NULL DEFAULT 1 COMMENT '1合作中 2停用',
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    \`deleted_at\` DATETIME(3) DEFAULT NULL,
    PRIMARY KEY (\`id\`), KEY \`idx_building_city_district\` (\`city\`,\`district\`),
    KEY \`idx_building_group_rel\` (\`building_group_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='办公楼表'`,

  `CREATE TABLE IF NOT EXISTS \`ab_building_group\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`name\` VARCHAR(64) NOT NULL, \`description\` VARCHAR(256) DEFAULT NULL,
    \`city\` VARCHAR(32) NOT NULL DEFAULT '北京', \`district\` VARCHAR(32) DEFAULT NULL,
    \`status\` TINYINT NOT NULL DEFAULT 1, \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    \`deleted_at\` DATETIME(3) DEFAULT NULL,
    PRIMARY KEY (\`id\`), KEY \`idx_building_group_city\` (\`city\`,\`district\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='楼群表'`,

  `CREATE TABLE IF NOT EXISTS \`ab_leader_invite\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`inviter_leader_id\` BIGINT UNSIGNED DEFAULT NULL COMMENT '邀请人团长；自荐为 NULL',
    \`invitee_user_id\` BIGINT UNSIGNED NOT NULL,
    \`invitee_leader_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`invite_code\` VARCHAR(32) DEFAULT NULL, \`channel\` VARCHAR(16) NOT NULL DEFAULT 'link',
    \`bind_at\` DATETIME(3) NOT NULL, \`invitee_level\` VARCHAR(16) DEFAULT NULL,
    \`is_formal\` TINYINT NOT NULL DEFAULT 0, \`formal_at\` DATETIME(3) DEFAULT NULL,
    \`remark\` VARCHAR(256) DEFAULT NULL,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_invite_invitee\` (\`invitee_user_id\`),
    KEY \`idx_invite_inviter\` (\`inviter_leader_id\`,\`is_formal\`), KEY \`idx_invite_formal_at\` (\`formal_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团长推荐关系（C2 晋级审计）'`,

  `CREATE TABLE IF NOT EXISTS \`ab_withdraw\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`withdraw_no\` VARCHAR(32) NOT NULL COMMENT '提现单号 WD+yyyyMMdd+8位',
    \`leader_id\` BIGINT UNSIGNED NOT NULL, \`user_id\` BIGINT UNSIGNED NOT NULL,
    \`amount\` DECIMAL(12,2) NOT NULL COMMENT '申请金额（元）',
    \`tax_withheld_amount\` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '平台代扣个税（C11）',
    \`actual_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '实际到账 = amount - tax',
    \`payout_channel\` VARCHAR(16) NOT NULL DEFAULT 'FLEX_MANUAL' COMMENT 'FLEX_MANUAL/FLEX_API',
    \`payout_batch_no\` VARCHAR(32) DEFAULT NULL COMMENT '出款批次号（人工登记）',
    \`receive_type\` VARCHAR(16) NOT NULL DEFAULT 'bank', \`receive_account\` VARCHAR(64) NOT NULL,
    \`receive_name\` VARCHAR(32) NOT NULL,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending'
      COMMENT 'pending待审批/approved已批准/paying打款中/success已到账/rejected已驳回/failed打款失败',
    \`auditor_id\` BIGINT UNSIGNED DEFAULT NULL, \`audit_at\` DATETIME(3) DEFAULT NULL,
    \`audit_remark\` VARCHAR(256) DEFAULT NULL, \`fail_reason\` VARCHAR(256) DEFAULT NULL,
    \`paid_at\` DATETIME(3) DEFAULT NULL,
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_withdraw_no\` (\`withdraw_no\`),
    KEY \`idx_withdraw_leader_time\` (\`leader_id\`,\`created_at\`), KEY \`idx_withdraw_status\` (\`status\`,\`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='提现申请单（2026-09-15 补 · C11 出款口径）'`,

  `CREATE TABLE IF NOT EXISTS \`ab_supplier\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`name\` VARCHAR(128) NOT NULL, \`type\` VARCHAR(16) NOT NULL DEFAULT 'dish',
    \`contact_name\` VARCHAR(32) NOT NULL, \`contact_phone\` VARCHAR(20) NOT NULL,
    \`business_license\` VARCHAR(256) DEFAULT NULL, \`food_license\` VARCHAR(256) DEFAULT NULL,
    \`category\` VARCHAR(32) DEFAULT NULL,
    \`share_rate\` DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT '废弃（C9 后按菜品成本单价）',
    \`wx_sub_mch_id\` VARCHAR(64) DEFAULT NULL,
    \`bank_account\` VARCHAR(64) DEFAULT NULL COMMENT '对公账户（C11 可后置收集）',
    \`bank_name\` VARCHAR(64) DEFAULT NULL,
    \`payee_type\` VARCHAR(16) NOT NULL DEFAULT 'corporate' COMMENT 'corporate/personal/cash',
    \`address\` VARCHAR(256) DEFAULT NULL, \`capacity_per_day\` INT UNSIGNED DEFAULT NULL,
    \`status\` TINYINT NOT NULL DEFAULT 1, \`total_served\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    \`deleted_at\` DATETIME(3) DEFAULT NULL,
    PRIMARY KEY (\`id\`), KEY \`idx_supplier_type_status\` (\`type\`,\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商'`,

  `CREATE TABLE IF NOT EXISTS \`ab_dish\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`supplier_id\` BIGINT UNSIGNED NOT NULL, \`name\` VARCHAR(64) NOT NULL,
    \`image_url\` VARCHAR(512) DEFAULT NULL, \`category\` VARCHAR(32) DEFAULT NULL,
    \`description\` VARCHAR(512) DEFAULT NULL, \`cost_price\` DECIMAL(8,2) NOT NULL,
    \`sale_count\` INT UNSIGNED NOT NULL DEFAULT 0, \`rating\` DECIMAL(3,2) DEFAULT 0.00,
    \`status\` TINYINT NOT NULL DEFAULT 1, \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    \`deleted_at\` DATETIME(3) DEFAULT NULL,
    PRIMARY KEY (\`id\`), KEY \`idx_dish_supplier\` (\`supplier_id\`), KEY \`idx_dish_category\` (\`category\`,\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='菜品库'`,

  `CREATE TABLE IF NOT EXISTS \`ab_supplier_dish_daily\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`supplier_id\` BIGINT UNSIGNED NOT NULL, \`dish_id\` BIGINT UNSIGNED NOT NULL,
    \`produce_date\` DATE NOT NULL, \`plan_quantity\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`actual_quantity\` INT UNSIGNED DEFAULT NULL, \`unit_price\` DECIMAL(8,2) NOT NULL,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending', \`completed_at\` DATETIME(3) DEFAULT NULL,
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_supplier_dish_date\` (\`supplier_id\`,\`dish_id\`,\`produce_date\`),
    KEY \`idx_supplier_dish_date\` (\`produce_date\`,\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商每日菜品'`,

  `CREATE TABLE IF NOT EXISTS \`ab_set_meal\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`name\` VARCHAR(128) DEFAULT NULL, \`meal_date\` DATE DEFAULT NULL,
    \`price\` DECIMAL(8,2) NOT NULL, \`cost_price\` DECIMAL(8,2) NOT NULL,
    \`cover_url\` VARCHAR(512) DEFAULT NULL, \`description\` VARCHAR(512) DEFAULT NULL,
    \`one_liner\` VARCHAR(128) DEFAULT NULL,
    \`status\` TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 0停用（模板库开关 · P1-4）',
    \`created_by\` BIGINT UNSIGNED DEFAULT NULL, \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), KEY \`idx_set_meal_status_date\` (\`status\`,\`meal_date\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐模板'`,

  `CREATE TABLE IF NOT EXISTS \`ab_set_meal_item\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`set_meal_id\` BIGINT UNSIGNED NOT NULL, \`dish_id\` BIGINT UNSIGNED NOT NULL,
    \`supplier_id\` BIGINT UNSIGNED NOT NULL COMMENT '可重复（同一供应商可出多菜）',
    \`slot\` TINYINT NOT NULL COMMENT '1主荤 2半荤 3素菜 4汤 5主食',
    \`share_amount\` DECIMAL(8,2) DEFAULT NULL,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), KEY \`idx_set_meal_item_meal\` (\`set_meal_id\`), KEY \`idx_set_meal_item_supplier\` (\`supplier_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐菜品明细'`,

  `CREATE TABLE IF NOT EXISTS \`ab_meal_assignment\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`meal_date\` DATE NOT NULL, \`building_group_id\` BIGINT UNSIGNED NOT NULL,
    \`set_meal_id\` BIGINT UNSIGNED NOT NULL,
    \`distribution_center_id\` BIGINT UNSIGNED DEFAULT NULL COMMENT '集散中心（C4 表驱动 · P0-3）',
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/active/cancelled',
    \`publish_at\` DATETIME(3) DEFAULT NULL, \`cutoff_at\` DATETIME(3) DEFAULT NULL,
    \`sold_count\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_meal_assignment_date_group\` (\`meal_date\`,\`building_group_id\`),
    KEY \`idx_meal_assignment_meal\` (\`set_meal_id\`), KEY \`idx_meal_assignment_dc\` (\`distribution_center_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐-楼群-日期分配'`,

  `CREATE TABLE IF NOT EXISTS \`ab_order\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`order_no\` VARCHAR(32) NOT NULL, \`user_id\` BIGINT UNSIGNED NOT NULL,
    \`team_leader_id\` BIGINT UNSIGNED DEFAULT NULL, \`building_id\` BIGINT UNSIGNED NOT NULL,
    \`building_group_id\` BIGINT UNSIGNED NOT NULL, \`set_meal_id\` BIGINT UNSIGNED NOT NULL,
    \`assignment_id\` BIGINT UNSIGNED NOT NULL, \`meal_date\` DATE NOT NULL,
    \`quantity\` INT UNSIGNED NOT NULL DEFAULT 1, \`unit_price\` DECIMAL(8,2) NOT NULL,
    \`total_amount\` DECIMAL(10,2) NOT NULL, \`balance_used\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    \`discount_amount\` DECIMAL(10,2) NOT NULL DEFAULT 0.00, \`pay_amount\` DECIMAL(10,2) NOT NULL,
    \`remark\` VARCHAR(256) DEFAULT NULL,
    \`status\` VARCHAR(24) NOT NULL DEFAULT 'pending_pay' COMMENT '11 态（C6 含 refund_applying/refunding）',
    \`paid_at\` DATETIME(3) DEFAULT NULL, \`completed_at\` DATETIME(3) DEFAULT NULL,
    \`cancelled_at\` DATETIME(3) DEFAULT NULL, \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_order_no\` (\`order_no\`),
    KEY \`idx_order_user\` (\`user_id\`,\`meal_date\`), KEY \`idx_order_team_leader\` (\`team_leader_id\`,\`meal_date\`),
    KEY \`idx_order_assignment\` (\`assignment_id\`), KEY \`idx_order_status\` (\`status\`,\`meal_date\`),
    KEY \`idx_order_building_meal\` (\`building_id\`,\`meal_date\`), KEY \`idx_order_refund_status\` (\`status\`,\`meal_date\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表（MVP 暂不分区 · P1-5）'`,

  `CREATE TABLE IF NOT EXISTS \`ab_payment_log\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`order_id\` BIGINT UNSIGNED NOT NULL, \`order_no\` VARCHAR(32) NOT NULL,
    \`transaction_id\` VARCHAR(64) DEFAULT NULL, \`pay_amount\` DECIMAL(10,2) NOT NULL,
    \`pay_method\` VARCHAR(16) NOT NULL DEFAULT 'wxpay_jsapi',
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending', \`paid_at\` DATETIME(3) DEFAULT NULL,
    \`raw_response\` JSON DEFAULT NULL,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_payment_order\` (\`order_id\`),
    KEY \`idx_payment_transaction\` (\`transaction_id\`), KEY \`idx_payment_status\` (\`status\`,\`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付流水'`,

  `CREATE TABLE IF NOT EXISTS \`ab_refund\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`refund_no\` VARCHAR(32) NOT NULL, \`order_id\` BIGINT UNSIGNED NOT NULL,
    \`order_no\` VARCHAR(32) NOT NULL, \`user_id\` BIGINT UNSIGNED NOT NULL,
    \`team_leader_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`apply_source\` VARCHAR(16) NOT NULL DEFAULT 'leader' COMMENT 'user/leader/admin（C6）',
    \`amount\` DECIMAL(10,2) NOT NULL, \`reason_type\` VARCHAR(16) DEFAULT NULL,
    \`reason\` VARCHAR(256) DEFAULT NULL,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'applying' COMMENT 'applying/approved/refunding/refunded/rejected',
    \`auditor_id\` BIGINT UNSIGNED DEFAULT NULL, \`audit_at\` DATETIME(3) DEFAULT NULL,
    \`audit_remark\` VARCHAR(256) DEFAULT NULL, \`wx_refund_no\` VARCHAR(64) DEFAULT NULL,
    \`refunded_at\` DATETIME(3) DEFAULT NULL,
    \`reversed\` TINYINT NOT NULL DEFAULT 0 COMMENT '反向分账是否已执行（C9 幂等）',
    \`reversed_at\` DATETIME(3) DEFAULT NULL, \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_refund_no\` (\`refund_no\`),
    KEY \`idx_refund_order\` (\`order_id\`), KEY \`idx_refund_status_time\` (\`status\`,\`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退款单（C6 三段式）'`,

  `CREATE TABLE IF NOT EXISTS \`ab_delivery_record\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`meal_date\` DATE NOT NULL, \`building_group_id\` BIGINT UNSIGNED NOT NULL,
    \`expected_at\` DATETIME(3) NOT NULL, \`actual_at\` DATETIME(3) DEFAULT NULL,
    \`driver_name\` VARCHAR(64) DEFAULT NULL, \`driver_phone\` VARCHAR(20) DEFAULT NULL,
    \`plate_no\` VARCHAR(16) DEFAULT NULL, \`total_quantity\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/called/en_route/arrived',
    \`remark\` VARCHAR(256) DEFAULT NULL, \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_delivery_date_group\` (\`meal_date\`,\`building_group_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='货拉拉送达记录'`,

  `CREATE TABLE IF NOT EXISTS \`ab_commission\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`order_id\` BIGINT UNSIGNED NOT NULL, \`order_no\` VARCHAR(32) NOT NULL,
    \`team_leader_id\` BIGINT UNSIGNED NOT NULL, \`leader_level\` VARCHAR(16) NOT NULL,
    \`rate\` DECIMAL(5,4) NOT NULL, \`base_amount\` DECIMAL(10,2) NOT NULL,
    \`quantity\` INT UNSIGNED NOT NULL, \`amount\` DECIMAL(10,2) NOT NULL,
    \`type\` VARCHAR(16) NOT NULL DEFAULT 'normal' COMMENT 'normal/reversal（C9）',
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/settled/cancelled',
    \`settled_at\` DATETIME(3) DEFAULT NULL, \`meal_date\` DATE NOT NULL,
    \`payout_channel\` VARCHAR(16) NOT NULL DEFAULT 'FLEX_MANUAL' COMMENT 'C11 灵活用工',
    \`payout_batch_no\` VARCHAR(32) DEFAULT NULL,
    \`tax_withheld_amount\` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '代扣个税（C11）',
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_commission_order_type\` (\`order_id\`,\`type\`),
    KEY \`idx_commission_leader_date\` (\`team_leader_id\`,\`meal_date\`), KEY \`idx_commission_status\` (\`status\`,\`meal_date\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团长佣金流水（C2/C9/C11）'`,

  `CREATE TABLE IF NOT EXISTS \`ab_supplier_share\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`share_no\` VARCHAR(32) NOT NULL, \`share_date\` DATE NOT NULL, \`meal_date\` DATE NOT NULL,
    \`payee_type\` VARCHAR(16) NOT NULL COMMENT 'supplier/distribution_center（C9）',
    \`payee_id\` BIGINT UNSIGNED NOT NULL, \`dish_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`quantity\` INT UNSIGNED NOT NULL, \`unit_price\` DECIMAL(8,2) NOT NULL,
    \`amount\` DECIMAL(12,2) NOT NULL, \`type\` VARCHAR(16) NOT NULL DEFAULT 'normal',
    \`channel\` VARCHAR(16) NOT NULL DEFAULT 'manual' COMMENT 'C11：人工对公转账（wxpay 二期）',
    \`payment_voucher_no\` VARCHAR(64) DEFAULT NULL, \`invoice_no\` VARCHAR(64) DEFAULT NULL,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/success/failed/reversed',
    \`fail_reason\` VARCHAR(256) DEFAULT NULL, \`settled_at\` DATETIME(3) DEFAULT NULL,
    \`paid_at\` DATETIME(3) DEFAULT NULL, \`origin_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_share_no\` (\`share_no\`),
    KEY \`idx_share_payee\` (\`payee_type\`,\`payee_id\`,\`meal_date\`), KEY \`idx_share_status\` (\`status\`,\`share_date\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商/集散中心应付结算流水（C9/C11）'`,

  `CREATE TABLE IF NOT EXISTS \`ab_balance\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, \`user_id\` BIGINT UNSIGNED NOT NULL,
    \`balance\` DECIMAL(12,2) NOT NULL DEFAULT 0.00, \`frozen\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    \`total_in\` DECIMAL(12,2) NOT NULL DEFAULT 0.00, \`total_out\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_balance_user\` (\`user_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户余额账户'`,

  `CREATE TABLE IF NOT EXISTS \`ab_balance_log\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, \`user_id\` BIGINT UNSIGNED NOT NULL,
    \`type\` VARCHAR(32) NOT NULL, \`direction\` TINYINT NOT NULL,
    \`amount\` DECIMAL(12,2) NOT NULL, \`balance_after\` DECIMAL(12,2) NOT NULL,
    \`related_id\` VARCHAR(64) DEFAULT NULL, \`remark\` VARCHAR(256) DEFAULT NULL,
    \`payout_channel\` VARCHAR(16) DEFAULT NULL, \`payout_batch_no\` VARCHAR(32) DEFAULT NULL,
    \`tax_withheld_amount\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), KEY \`idx_balance_log_user_time\` (\`user_id\`,\`created_at\`), KEY \`idx_balance_log_type\` (\`type\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='余额变动流水'`,

  `CREATE TABLE IF NOT EXISTS \`ab_distribution_center\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`name\` VARCHAR(64) NOT NULL, \`supplier_id\` BIGINT UNSIGNED NOT NULL,
    \`address\` VARCHAR(256) NOT NULL, \`contact_name\` VARCHAR(32) DEFAULT NULL,
    \`contact_phone\` VARCHAR(20) DEFAULT NULL,
    \`rice_fee\` DECIMAL(8,2) NOT NULL DEFAULT 0.00, \`pack_fee\` DECIMAL(8,2) NOT NULL DEFAULT 0.00,
    \`service_groups\` JSON DEFAULT NULL, \`status\` TINYINT NOT NULL DEFAULT 1,
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    \`deleted_at\` DATETIME(3) DEFAULT NULL,
    PRIMARY KEY (\`id\`), KEY \`idx_dc_supplier\` (\`supplier_id\`), KEY \`idx_dc_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='集散中心配置（C4）'`,

  `CREATE TABLE IF NOT EXISTS \`ab_admin_user\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, \`username\` VARCHAR(64) NOT NULL,
    \`password_hash\` VARCHAR(128) NOT NULL, \`real_name\` VARCHAR(32) DEFAULT NULL,
    \`role\` VARCHAR(32) NOT NULL DEFAULT 'operator', \`supplier_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`phone\` VARCHAR(20) DEFAULT NULL, \`status\` TINYINT NOT NULL DEFAULT 1,
    \`last_login_at\` DATETIME(3) DEFAULT NULL, \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_admin_username\` (\`username\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台账号'`,

  `CREATE TABLE IF NOT EXISTS \`ab_operation_log\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, \`admin_user_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`module\` VARCHAR(32) NOT NULL, \`action\` VARCHAR(32) NOT NULL,
    \`target_id\` VARCHAR(64) DEFAULT NULL, \`request_ip\` VARCHAR(64) DEFAULT NULL,
    \`request_data\` JSON DEFAULT NULL, \`response_data\` JSON DEFAULT NULL,
    \`snapshot\` JSON DEFAULT NULL,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), KEY \`idx_oplog_user_time\` (\`admin_user_id\`,\`created_at\`),
    KEY \`idx_oplog_module_action\` (\`module\`,\`action\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志'`,

  `CREATE TABLE IF NOT EXISTS \`ab_config\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, \`config_key\` VARCHAR(64) NOT NULL,
    \`config_value\` TEXT NOT NULL, \`description\` VARCHAR(256) DEFAULT NULL,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), UNIQUE KEY \`uk_config_key\` (\`config_key\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='配置字典'`,

  `CREATE TABLE IF NOT EXISTS \`ab_message\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, \`user_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`openid\` VARCHAR(64) DEFAULT NULL, \`template_id\` VARCHAR(64) NOT NULL,
    \`payload\` JSON NOT NULL, \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending',
    \`error_msg\` VARCHAR(256) DEFAULT NULL, \`sent_at\` DATETIME(3) DEFAULT NULL,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`), KEY \`idx_msg_user_time\` (\`user_id\`,\`created_at\`), KEY \`idx_msg_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='消息推送日志'`,
];

const TABLE_NAMES = [
  'ab_message',
  'ab_config',
  'ab_operation_log',
  'ab_admin_user',
  'ab_withdraw',
  'ab_distribution_center',
  'ab_balance_log',
  'ab_balance',
  'ab_supplier_share',
  'ab_commission',
  'ab_delivery_record',
  'ab_refund',
  'ab_payment_log',
  'ab_order',
  'ab_meal_assignment',
  'ab_set_meal_item',
  'ab_set_meal',
  'ab_supplier_dish_daily',
  'ab_dish',
  'ab_supplier',
  'ab_leader_invite',
  'ab_building_group',
  'ab_building',
  'ab_team_leader',
  'ab_user',
];

export class Init1700000000000 implements MigrationInterface {
  name = 'Init1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of TABLES) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of TABLE_NAMES) {
      await queryRunner.query(`DROP TABLE IF EXISTS \`${name}\``);
    }
  }
}
