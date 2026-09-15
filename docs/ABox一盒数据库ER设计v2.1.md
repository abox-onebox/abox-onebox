# ABox 一盒 · 数据库 ER 设计 v2.1

> 基于 ER v2.0 增量修订，回填《MVP 优化交接包 v1.1》C2/C3/C4/C6/C9 裁决（2026-09-14）
> 前置：v1.0 ER 设计（已废弃）；核心差异见 § 一

---

## 〇、设计原则（沿用 v1.0）

1. **订单表按月分区**（RANGE PARTITION）
2. **金额统一 `DECIMAL(10,2)`**
3. **时间统一 `DATETIME(3)`，UTC+8**
4. **软删除用 `deleted_at`**
5. **每张表必备字段**：`id`、`created_at`、`updated_at`、`version`
6. **命名规范**：表名 `ab_<module>_<entity>`，字段名 snake_case

---

## 一、与 v1.0 的差异清单

### 1.1 删除的表（3 张）

| 表名 | 删除原因 |
| --- | --- |
| `ab_address` | 普通用户无需填地址（跟随团长） |
| `ab_company` | 简化模型，普通用户无需选公司 |
| `ab_floor_leader` | **无楼长角色**，团长兼任取餐分发 |

### 1.2 新增的表（8 张）

| 表名 | 用途 |
| --- | --- |
| `ab_building_group` | 楼群（多栋楼聚合为一个分发单位） |
| `ab_meal_assignment` | 套餐-楼群-日期分配表 |
| `ab_balance` | 用户余额账户 |
| `ab_balance_log` | 余额变动流水 |
| `ab_supplier_dish_daily` | 供应商-菜品-日期对应（每日生产哪道菜） |
| `ab_delivery_record` | 货拉拉送达记录（轻量） |
| `ab_distribution_center` | 集散中心配置（C4 · 表驱动，默认 4 个，可增删） |
| `ab_withdraw` | **提现申请单**（2026-09-15 补 · C11：出款走灵活用工代发代扣，须独立单承载提现单号 / 审批 / 打款状态） |

### 1.3 修改的表（7 张）

| 表名 | 修改 |
| --- | --- |
| `ab_user` | `phone` 改可选；删除 `company_id`、`floor` 必填 |
| `ab_set_meal` | 删除 `uk_set_meal_date`（同一天可以有多个套餐分配给不同楼群） |
| `ab_set_meal_item` | `supplier_id` 不再唯一约束（可重复，前期一人多菜） |
| `ab_supplier` | 增加 `type` 字段（出餐型/集散型/混合型） |
| `ab_team_leader` | 增加 `balance` 字段（余额账户）；`level` 等级字段（C2）；`signed_at` 改为 `agreed_at` 勾选协议（C3）；**增加 `floor` 楼层维度（2026-09-15 裁定② 恢复）**；**增加收款方式三字段 `payout_type` / `payout_account`（脱敏存储）/ `payout_name`（C11 · 提现前置条件，2026-09-15 补）** |
| `ab_refund` | 增加代退三段式字段：`apply_source`、`apply_reason`、`apply_by_leader_id`、`approve_admin_id`、`approve_at`（C6）；**增加 `order_status_before`（申请前订单状态 · D42 驳回回退的唯一依据，2026-09-15 补）** |
| `ab_balance_log` | **增加出款字段 `payout_channel` / `payout_batch_no` / `tax_withheld_amount`（P2-5 · C11，2026-09-15 补）** |

---

## 二、ER 总览（25 张表 · 2026-09-15 增补 `ab_withdraw`）

```
                              ┌──────────────────┐
                              │ ab_building_group│  楼群
                              │   (楼群)         │
                              └────┬─────────────┘
                                   │ 1
                                   │
                                   │ N
                              ┌────▼─────────────┐
                              │ ab_building       │
                              │   (办公楼)        │
                              └────┬─────────────┘
                                   │ 1
                                   │
            ┌──────────────────────┼──────────────────────┐
            │ N                    │ N                    │ N
       ┌────▼────────┐         ┌────▼────────┐      ┌─────▼───────┐
       │ab_team_leader│        │ ab_set_meal │      │ab_meal_     │
       │   (团长)     │        │  (套餐模板)  │      │assignment   │
       └────┬────────┘        └─────┬───────┘      │(套餐分配)   │
            │ 1                     │ 1             └─────────────┘
            │                       │ N
            │ N                     ▼
       ┌────▼────────┐         ┌─────────────┐
       │  ab_user    │         │ab_set_meal_ │
       │  (用户)     │         │item(套餐明细)│
       └────┬────────┘         └──────┬──────┘
            │ 1                       │ N
            │                         │ 1
            │ N                       ▼
       ┌────▼────────┐         ┌─────────────┐
       │  ab_order   │         │  ab_dish    │
       │  (订单)     │         │  (菜品)     │
       └────┬────────┘         └──────┬──────┘
            │ 1                       │ N
            │                         │ 1
   ┌────────┼─────────────────────┐   │
   │ N      │                     │   │
   ▼        ▼                     ▼   ▼
┌────────┐ ┌──────────────┐  ┌──────────────┐
│ab_payment│ │ab_commission │  │ ab_supplier  │
│  _log    │ │ (团长佣金)   │  │  (供应商)    │
└────────┘ └──────────────┘  └──────────────┘

       ┌──────────────┐    ┌────────────────────┐
       │  ab_balance  │    │ab_supplier_dish_   │
       │  (用户余额)  │    │  daily(供应商日菜品)│
       └──────┬───────┘    └────────────────────┘
              │ 1
              │ N
       ┌──────▼───────┐
       │ab_balance_log│
       │ (余额流水)   │
       └──────────────┘

       ┌──────────────┐    ┌──────────────┐
       │ab_refund     │    │ab_delivery_  │
       │ (退款流水)   │    │record(送达)  │
       └──────────────┘    └──────────────┘

       ┌──────────────┐    ┌──────────────┐
       │ab_admin_user │    │ab_operation_ │
       │ (后台账号)   │    │log(操作日志) │
       └──────────────┘    └──────────────┘

       ┌──────────────┐    ┌──────────────┐
       │ab_config     │    │ab_message    │
       └──────────────┘    └──────────────┘

       ┌────────────────┐  ┌────────────────────┐
       │ab_supplier_    │  │ab_distribution_    │
       │share(分账流水) │  │center(集散中心)    │
       └────────────────┘  └────────────────────┘
```

---

## 三、新增表 DDL

### 3.1 `ab_building_group` 楼群表

```sql
CREATE TABLE `ab_building_group` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`         VARCHAR(64) NOT NULL COMMENT '楼群名，如"国贸商圈"',
  `description`  VARCHAR(256) DEFAULT NULL,
  `city`         VARCHAR(32) NOT NULL DEFAULT '北京',
  `district`     VARCHAR(32) DEFAULT NULL,
  `status`       TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 2停用',
  `version`      INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at`   DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_building_group_city` (`city`, `district`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='楼群（多栋楼聚合为一个分发单位）';
```

### 3.2 `ab_meal_assignment` 套餐分配表 ⭐ 核心

```sql
CREATE TABLE `ab_meal_assignment` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `meal_date`        DATE NOT NULL COMMENT '套餐日期',
  `building_group_id` BIGINT UNSIGNED NOT NULL,
  `set_meal_id`      BIGINT UNSIGNED NOT NULL,
  `distribute_supplier_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '该楼群的集散中心供应商',
  `status`           VARCHAR(16) NOT NULL DEFAULT 'pending'
                     COMMENT 'pending/active/cancelled',
  `publish_at`       DATETIME(3) DEFAULT NULL COMMENT '实际开放预订时间',
  `cutoff_at`        DATETIME(3) DEFAULT NULL COMMENT '实际截单时间（冗余）',
  `version`          INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_meal_assignment_date_group` (`meal_date`, `building_group_id`),
  KEY `idx_meal_assignment_meal` (`set_meal_id`),
  KEY `idx_meal_assignment_date` (`meal_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐-楼群-日期分配（每天每楼群一套餐）';
```

### 3.3 `ab_balance` 用户余额表

```sql
CREATE TABLE `ab_balance` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       BIGINT UNSIGNED NOT NULL,
  `balance`       DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '可用余额',
  `frozen`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '冻结金额',
  `total_in`      DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '累计收入',
  `total_out`     DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '累计支出',
  `version`       INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_balance_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户余额账户';
```

### 3.4 `ab_balance_log` 余额流水

```sql
CREATE TABLE `ab_balance_log` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`       BIGINT UNSIGNED NOT NULL,
  `type`          VARCHAR(32) NOT NULL COMMENT 'commission/order_pay/withdraw/withdraw_refund/refund',
  `direction`     TINYINT NOT NULL COMMENT '1收入 -1支出',
  `amount`        DECIMAL(12,2) NOT NULL,
  `balance_after` DECIMAL(12,2) NOT NULL COMMENT '操作后余额',
  `related_id`    VARCHAR(64) DEFAULT NULL COMMENT '关联订单ID/佣金ID',
  `remark`        VARCHAR(256) DEFAULT NULL,
  `payout_channel`      VARCHAR(16) DEFAULT NULL COMMENT '出款通道（C11 · FLEX_MANUAL/FLEX_API）',
  `payout_batch_no`     VARCHAR(32) DEFAULT NULL COMMENT '灵活用工出款批次号',
  `tax_withheld_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '代扣个税（灵活用工回传）',
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_balance_log_user_time` (`user_id`, `created_at`),
  KEY `idx_balance_log_type` (`type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='余额变动流水';
```

### 3.5 `ab_withdraw` 提现申请单（C11 · 2026-09-15 补）⭐

> **为何必须独立成表**：余额流水（`ab_balance_log`）只记「发生额」，无法承载提现单的
> **审批状态机**（待审批 → 已批准 → 打款中 → 已到账 / 已驳回 / 打款失败）、
> 审批人与驳回原因、以及灵活用工出款批次号。L12 / L13 与后台 D45 / D46 均依赖本表。

```sql
CREATE TABLE `ab_withdraw` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `withdraw_no`         VARCHAR(32) NOT NULL COMMENT '提现单号 WD+yyyyMMdd+8位',
  `leader_id`           BIGINT UNSIGNED NOT NULL,
  `user_id`             BIGINT UNSIGNED NOT NULL,
  `amount`              DECIMAL(12,2) NOT NULL COMMENT '申请金额（元）',
  `tax_withheld_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '平台代扣个税（C11）',
  `actual_amount`       DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '实际到账 = amount - tax',
  `payout_channel`      VARCHAR(16) NOT NULL DEFAULT 'FLEX_MANUAL' COMMENT 'FLEX_MANUAL/FLEX_API',
  `payout_batch_no`     VARCHAR(32) DEFAULT NULL COMMENT '出款批次号（人工登记）',
  `receive_type`        VARCHAR(16) NOT NULL DEFAULT 'bank',
  `receive_account`     VARCHAR(64) NOT NULL COMMENT '收款账号（脱敏存储）',
  `receive_name`        VARCHAR(32) NOT NULL,
  `status`              VARCHAR(16) NOT NULL DEFAULT 'pending'
                        COMMENT 'pending待审批/approved已批准/paying打款中/success已到账/rejected已驳回/failed打款失败',
  `auditor_id`          BIGINT UNSIGNED DEFAULT NULL,
  `audit_at`            DATETIME(3) DEFAULT NULL,
  `audit_remark`        VARCHAR(256) DEFAULT NULL,
  `fail_reason`         VARCHAR(256) DEFAULT NULL,
  `paid_at`             DATETIME(3) DEFAULT NULL,
  `version`             INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_withdraw_no` (`withdraw_no`),
  KEY `idx_withdraw_leader_time` (`leader_id`, `created_at`),
  KEY `idx_withdraw_status` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='提现申请单（C11 出款口径：灵活用工代发代扣）';
```

> **口径要点**
> - **冻结时机**：L12 提交即冻结（`ab_balance.balance ↓` / `frozen ↑`），终态才释放；
>   与此同时写一条 `ab_balance_log(type='withdraw', direction=-1)`，故 L19 流水与 L11 余额可相互验算。
> - **`amount` 单位是「元」**（与其余接口出参「整数分」不同），端上提交前须转换。
> - **不接微信「商家转账到零钱」**：一期人工对公/代发（`FLEX_MANUAL`），二期切 `FLEX_API`。
> - 供应商 / 集散应付**不走本表**（属 `ab_supplier_share`，人工对公转账 + 回单号）。

### 3.6 `ab_supplier_dish_daily` 供应商-菜品-日对应

```sql
CREATE TABLE `ab_supplier_dish_daily` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `supplier_id`   BIGINT UNSIGNED NOT NULL,
  `dish_id`       BIGINT UNSIGNED NOT NULL,
  `produce_date`  DATE NOT NULL COMMENT '生产日期',
  `plan_quantity` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '计划生产量',
  `actual_quantity` INT UNSIGNED DEFAULT NULL COMMENT '实际生产量',
  `unit_price`    DECIMAL(8,2) NOT NULL COMMENT '当日供价单价（与供应商逐菜协商 · C9 修订，非固定）',
  `status`        VARCHAR(16) NOT NULL DEFAULT 'pending'
                  COMMENT 'pending/cooking/done',
  `completed_at`  DATETIME(3) DEFAULT NULL,
  `version`       INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_supplier_dish_date` (`supplier_id`, `dish_id`, `produce_date`),
  KEY `idx_supplier_dish_date` (`produce_date`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商每日生产哪道菜（前期动态/后期稳定）';
```

### 3.7 `ab_delivery_record` 货拉拉送达记录

```sql
CREATE TABLE `ab_delivery_record` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `meal_date`        DATE NOT NULL,
  `building_group_id` BIGINT UNSIGNED NOT NULL,
  `expected_at`      DATETIME(3) NOT NULL COMMENT '预计送达 11:30',
  `actual_at`        DATETIME(3) DEFAULT NULL COMMENT '实际送达',
  `driver_name`      VARCHAR(64) DEFAULT NULL COMMENT '货拉拉司机',
  `driver_phone`     VARCHAR(20) DEFAULT NULL,
  `plate_no`         VARCHAR(16) DEFAULT NULL COMMENT '车牌',
  `total_quantity`   INT UNSIGNED NOT NULL DEFAULT 0,
  `status`           VARCHAR(16) NOT NULL DEFAULT 'pending'
                     COMMENT 'pending/called/en_route/arrived',
  `remark`           VARCHAR(256) DEFAULT NULL,
  `version`          INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_delivery_date_group` (`meal_date`, `building_group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='货拉拉送达记录';
```

### 3.8 `ab_distribution_center` 集散中心配置表（C4 · 新增）⭐

```sql
CREATE TABLE `ab_distribution_center` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(64) NOT NULL COMMENT '集散中心名，如"集散中心 1（国贸片）"',
  `supplier_id`   BIGINT UNSIGNED NOT NULL COMMENT '关联供应商（集散中心=某供应商，可同时出餐）',
  `address`       VARCHAR(256) NOT NULL COMMENT '场地地址（集散中心复用合作供应商场地 · C4）',
  `contact_name`  VARCHAR(32)  DEFAULT NULL,
  `contact_phone` VARCHAR(20)  DEFAULT NULL,
  `rice_fee`      DECIMAL(8,2) NOT NULL DEFAULT 0.00 COMMENT '集散/场地费（C9 修订：复用供应商场地 → 默认 ¥0，按实际登记）',
  `pack_fee`      DECIMAL(8,2) NOT NULL DEFAULT 0.00 COMMENT '打包费（C9 修订：改由平台兼职承担 → settlement.packing_labor_fee，本项默认 ¥0）',
  `service_groups` JSON DEFAULT NULL COMMENT '服务的楼群 id 列表',
  `status`        TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 0停用',
  `version`       INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at`    DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_dc_supplier` (`supplier_id`),
  KEY `idx_dc_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='集散中心配置（MVP 默认 4 个，数量可配置，不硬编码）';
```

> ⭐ C4 裁决：运营按 4 个跑，但系统**不得硬编码**；集散中心**复用合作供应商场地**，场地 / 打包费用**默认 ¥0**（科目保留、字段级拆分便于审计，按实际登记）。<br>> **C9 修订（2026-09-15）**：原「固定 ¥5.00/份 = 米饭 ¥2.00 + 打包 ¥3.00」作废 —— 供价逐菜协商、场地复用默认 0、打包人工与配送费单列，平台毛利为结果值。

---

## 四、修改表 DDL（仅列变更字段）

### 4.1 `ab_user` 用户表

```sql
CREATE TABLE `ab_user` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid`            VARCHAR(64)  NOT NULL COMMENT '微信 openid',
  `unionid`           VARCHAR(64)  DEFAULT NULL,
  `nickname`          VARCHAR(64)  DEFAULT NULL,
  `avatar_url`        VARCHAR(512) DEFAULT NULL,
  `phone`             VARCHAR(20)  DEFAULT NULL COMMENT '可选，普通用户可不填',
  `phone_hash`        VARCHAR(64)  DEFAULT NULL,
  `gender`            TINYINT      DEFAULT 0,
  `building_id`       BIGINT UNSIGNED DEFAULT NULL COMMENT '跟随团长所属办公楼',
  `team_leader_id`    BIGINT UNSIGNED DEFAULT NULL COMMENT '所属团长（必填，注册时绑定）',
  `subscribe_flag`    JSON         DEFAULT NULL,
  `status`            TINYINT      NOT NULL DEFAULT 1,
  `last_order_at`     DATETIME(3)  DEFAULT NULL,
  `version`           INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at`        DATETIME(3)  DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_openid` (`openid`),
  KEY `idx_user_phone_hash` (`phone_hash`),
  KEY `idx_user_building` (`building_id`),
  KEY `idx_user_team_leader` (`team_leader_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';
```

> ⭐ 关键变化：`company_id`、`floor` 字段已删除；`team_leader_id` 变为关键字段

### 4.2 `ab_team_leader` 团长表

```sql
CREATE TABLE `ab_team_leader` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`           BIGINT UNSIGNED NOT NULL,
  `building_id`       BIGINT UNSIGNED NOT NULL,
  `phone`             VARCHAR(20)  NOT NULL COMMENT '必填',
  `real_name`         VARCHAR(32)  NOT NULL,
  `floor`             VARCHAR(32)  DEFAULT NULL COMMENT '楼层，如 12F；2026-09-15 裁定补回',
  `commission_rate`   DECIMAL(5,4) NOT NULL DEFAULT 0.1000,
  `total_orders`      INT UNSIGNED NOT NULL DEFAULT 0,
  `total_amount`      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `total_commission`  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `withdrawn_amount`  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `pending_amount`    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `balance`           DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT '可用余额',
  `status`            TINYINT NOT NULL DEFAULT 1,
  `agreed_at`         DATETIME(3) DEFAULT NULL COMMENT '勾选同意《团长合作协议》时间（C3：提交即生效，无人工审核）',
  `agree_version`     VARCHAR(16) DEFAULT NULL COMMENT '协议版本号（法务简版文本）',
  `version`           INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at`        DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_team_leader_user` (`user_id`),
  KEY `idx_team_leader_building` (`building_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团长表';
```

> ⭐ **2026-09-15 裁定（恢复 `floor`）**：v2.1 将 `ab_user.floor` 与 `floor` 必填一并删除时，误把团长表的楼层维度也带走了 —— 但《接口规范》U1 / U3 / L17 一直以 `floor` 为契约字段，且楼层是**核心组织维度**（同楼内按楼层分群分发、取餐提醒按楼层聚合）。故**恢复 `floor` 到 `ab_team_leader`**；`ab_user.floor` 仍保持删除（用户楼层由所属团长推定，不重复存储）。

### 4.3 `ab_supplier` 供应商表

```sql
CREATE TABLE `ab_supplier` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`            VARCHAR(128) NOT NULL,
  `type`            VARCHAR(16) NOT NULL DEFAULT 'dish'
                    COMMENT 'dish=出餐型 / distribute=集散型 / both=混合型',
  `contact_name`    VARCHAR(32)  NOT NULL,
  `contact_phone`   VARCHAR(20)  NOT NULL,
  `business_license` VARCHAR(256) DEFAULT NULL,
  `food_license`    VARCHAR(256) DEFAULT NULL,
  `category`        VARCHAR(32)  DEFAULT NULL,
  `share_rate`      DECIMAL(5,4) NOT NULL DEFAULT 0.0000,
  `wx_sub_mch_id`   VARCHAR(64)  DEFAULT NULL,
  `bank_account`    VARCHAR(64)  DEFAULT NULL,
  `bank_name`       VARCHAR(64)  DEFAULT NULL,
  `address`         VARCHAR(256) DEFAULT NULL COMMENT '集散中心地址',
  `capacity_per_day` INT UNSIGNED DEFAULT NULL COMMENT '每日产能',
  `status`          TINYINT NOT NULL DEFAULT 1,
  `total_served`    INT UNSIGNED NOT NULL DEFAULT 0,
  `version`         INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at`      DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_supplier_type_status` (`type`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商（出餐型/集散型/混合型）';
```

### 4.4 `ab_set_meal` 套餐表

```sql
CREATE TABLE `ab_set_meal` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(128) DEFAULT NULL COMMENT '套餐名（运营填写）',
  `meal_date`     DATE DEFAULT NULL COMMENT '模板日期（冗余，可空）',
  `price`         DECIMAL(8,2) NOT NULL,
  `cost_price`    DECIMAL(8,2) NOT NULL,
  `cover_url`     VARCHAR(512) DEFAULT NULL,
  `description`   VARCHAR(512) DEFAULT NULL,
  `one_liner`     VARCHAR(128) DEFAULT NULL COMMENT '一句话介绍（小程序卡片展示）',
  `status`        TINYINT NOT NULL DEFAULT 1 COMMENT '1模板 2已分配 3已截单 4已完成 5已取消',
  `created_by`    BIGINT UNSIGNED DEFAULT NULL,
  `version`       INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_set_meal_status_date` (`status`, `meal_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐模板';
```

> ⭐ 关键变化：删除 `uk_set_meal_date` 唯一约束；套餐本身是"模板"，分配到具体日期-楼群由 `ab_meal_assignment` 决定

### 4.5 `ab_set_meal_item` 套餐明细

```sql
CREATE TABLE `ab_set_meal_item` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `set_meal_id`   BIGINT UNSIGNED NOT NULL,
  `dish_id`       BIGINT UNSIGNED NOT NULL,
  `supplier_id`   BIGINT UNSIGNED NOT NULL,
  `slot`          TINYINT NOT NULL COMMENT '1主荤 2半荤 3素菜 4汤 5主食',
  `share_amount`  DECIMAL(8,2) DEFAULT NULL,
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_set_meal_item_meal` (`set_meal_id`),
  KEY `idx_set_meal_item_supplier` (`supplier_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='套餐菜品明细（supplier_id 可重复）';
```

> ⭐ 关键变化：`supplier_id` 不再唯一约束（同一供应商可出多菜，前期场景）

### 4.6 `ab_order` 订单表

```sql
CREATE TABLE `ab_order` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_no`         VARCHAR(32) NOT NULL,
  `user_id`          BIGINT UNSIGNED NOT NULL,
  `team_leader_id`   BIGINT UNSIGNED DEFAULT NULL,
  `building_id`      BIGINT UNSIGNED NOT NULL,
  `building_group_id` BIGINT UNSIGNED NOT NULL,
  `set_meal_id`      BIGINT UNSIGNED NOT NULL,
  `assignment_id`    BIGINT UNSIGNED NOT NULL COMMENT '关联套餐分配',
  `meal_date`        DATE NOT NULL,
  `quantity`         INT UNSIGNED NOT NULL DEFAULT 1,
  `unit_price`       DECIMAL(8,2) NOT NULL,
  `total_amount`     DECIMAL(10,2) NOT NULL,
  `balance_used`     DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '余额抵扣',
  `discount_amount`  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `pay_amount`       DECIMAL(10,2) NOT NULL COMMENT '微信实付',
  `remark`           VARCHAR(256) DEFAULT NULL,
  `status`           VARCHAR(16) NOT NULL DEFAULT 'pending_pay'
                     COMMENT 'pending_pay/paid/cut_off/cooked/delivering/delivered/completed/cancelled/refunded',
  `paid_at`          DATETIME(3) DEFAULT NULL,
  `completed_at`     DATETIME(3) DEFAULT NULL,
  `cancelled_at`     DATETIME(3) DEFAULT NULL,
  `version`          INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`, `created_at`),
  UNIQUE KEY `uk_order_no` (`order_no`, `created_at`),
  KEY `idx_order_user` (`user_id`, `meal_date`),
  KEY `idx_order_assignment` (`assignment_id`),
  KEY `idx_order_building_meal` (`building_id`, `meal_date`),
  KEY `idx_order_status` (`status`, `meal_date`),
  KEY `idx_order_team_leader` (`team_leader_id`, `meal_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE (TO_DAYS(`created_at`)) (
  PARTITION p202609 VALUES LESS THAN (TO_DAYS('2026-10-01')),
  PARTITION p202610 VALUES LESS THAN (TO_DAYS('2026-11-01')),
  PARTITION p202611 VALUES LESS THAN (TO_DAYS('2026-12-01')),
  PARTITION p202612 VALUES LESS THAN (TO_DAYS('2027-01-01')),
  PARTITION p_max    VALUES LESS THAN MAXVALUE
) COMMENT='订单表';
```

> ⭐ 关键变化：增加 `building_group_id`、`assignment_id`、`balance_used`；删除 `company_id`、`floor`

---

## 五、未修改的表（沿用 v1.0 · 9 张）

| 表 | 备注 |
| --- | --- |
| `ab_building` | 不变 |
| `ab_dish` | 不变 |
| `ab_payment_log` | 不变 |
| `ab_commission` | 不变（流水表；佣金比例由 4 级阶梯 8/9/10/12% 配置驱动 · C2） |
| `ab_supplier_share` | 不变（分账流水） |
| `ab_admin_user` | **+`supplier_id`**（供应商后台账号绑定 `ab_supplier.id`；NULL = 运营账号）· 见下方 §5.1 |
| `ab_operation_log` | **+`snapshot`**（JSON，操作者/角色/时刻，审计回放）· 见下方 §5.1 |
| `ab_config` | 不变 |
| `ab_message` | 不变 |

### 5.1 M3 补丁（2 张表各加 1 列）

> **为什么这两列必须在 M3 之前补上**：账号体系的「运营 + 供应商同工程、按 role 过滤菜单」
> 与「所有后台写操作可审计」是 M3 的验收前提。两列都**不新增表**（总表数仍 **25 张**）。

```sql
-- ① 供应商后台账号的身份锚点
ALTER TABLE `ab_admin_user`
  ADD COLUMN `supplier_id` BIGINT UNSIGNED DEFAULT NULL
    COMMENT '绑定 ab_supplier.id；role=supplier 时必填（S* 与 P21–P26 的数据范围锚点）'
    AFTER `role`,
  ADD KEY `idx_admin_supplier` (`supplier_id`);

-- ② 操作日志的结构化快照（谁在什么角色下、什么时刻做的）
ALTER TABLE `ab_operation_log`
  ADD COLUMN `snapshot` JSON DEFAULT NULL
    COMMENT '变更上下文快照：{ operator, role, at }（P2-1 审计回放）'
    AFTER `response_data`;
```

**口径要点**

| 项 | 说明 |
| --- | --- |
| `role` 枚举 | `super_admin` / `admin` / `operator` / `finance` / `viewer` / **`supplier`**（v1.0 的枚举漏了 supplier，M3 补齐） |
| 角色 → 菜单 | **不建 `ab_admin_role` 表**：由 `apps/api-server/src/common/constants/admin-role.ts` 代码定义，等出现「运营自定义角色」诉求再迁表（届时该文件降级为默认种子） |
| 口令存储 | `password_hash` 格式 `scrypt:<saltHex>:<hashHex>`（node:crypto 零依赖）；种子期另有 `dev_plain:<明文>` 占位，**上线前必须清空** |
| 令牌吊销 | 不入库：`adminRevokeKey(id)` 写 KV（`admin:revoked:<id>`），`AdminGuard` 比对令牌 `iat` |

### 5.2 M3-3 反向结算的落点（**无 DDL 变更**）

> M3-3（订单中心 D8–D12）没有新增表、也没有新增列 —— 反向结算全部**落回既有列**。
> 这里把它写清楚，是因为「退款要改哪些表」散在代码里最容易漏掉一张。

| 表 | 写什么 | 口径 |
| --- | --- | --- |
| `ab_refund` | 新增一行（`apply_source='admin'`，`status='refunding' → 'refunded'`）· **`reversed=1` + `reversed_at`** | `reversed` 是「反向结算已执行」幂等位；`cancelled_at` 在 `ab_order` 上近似承载退款时刻（无独立 `refunded_at` 列） |
| `ab_order` | `status='refunded'` · `cancelled_at=now` | 退款是**终态**；`cancelled_at` 复用为「异常区时间线」的发生时间 |
| `ab_commission` | **新增一行** `type='reversal'`（`amount` / `quantity` **取负**）+ 原 `normal` 行 `status='cancelled'` | **C9：原记录不得改写**。金额改成 0 会让佣金明细的「发生额」永久失真 |
| `ab_balance` / `ab_balance_log` | 余额退回（`type='refund'`,`direction=+1`）/ 佣金冲销（`direction=−1`） | 余额**允许被扣成负数**：佣金已提现就形成欠款，由后续佣金抵扣；硬拦会把退款卡死 |
| `ab_supplier_share` | 未付款行 → 直接扣减（扣空置 `status='reversed'`）；已付款行 → **写反向流水**（`type='reversal'`，`origin_id` 指向原行）挂**下期**抵扣 | 已付款行**不得改写**（钱已转出，改写等于篡改已发生的付款）。未生成应付时（`mode='not_generated'`）**不造空冲销行** —— 跑批按「有效订单」汇总，已退款单自然不在其中 |

**关键字段速查**

| 字段 | 语义 |
| --- | --- |
| `ab_refund.amount` | **用户实际付出去的钱** = `total_amount − discount_amount`（＝微信实付 + 余额抵扣）。**不是** `pay_amount` |
| `ab_refund.auditor_id` | 后台强制退款时 = 操作人（「自己批准自己」）；D41 审批时 = 真实审批人 |
| `ab_refund.order_status_before` | **申请前的订单状态** —— D42 驳回时订单要回到哪里的**唯一依据**。见 §5.3 |
| `ab_supplier_share.type` | `normal` / `reversal`；`reversal` 行的 `share_date` = **冲减登记日**（决定进哪一期的结算单） |
| `ab_supplier_share.origin_id` | 反向流水指向的原行 id（对账时用于回溯） |

### 5.3 M3-4 新增列：`ab_refund.order_status_before`（**有 DDL 变更**）

> M3-4（退款审批 D40–D42）**唯一**的表结构变更，就是这一列。

| 项 | 说明 |
| --- | --- |
| 列名 | `order_status_before`（`tinyint`，可空） |
| 语义 | 这笔退款申请**提交时**订单所处的状态（`pending_pay` / `paid` / `preparing` / `delivering` / `completed` …） |
| 写入时机 | `applyByLeader`（C6 第一段 · 团长代退）与 `forceRefund`（D11 · 后台强制退款，审计留痕） |
| 读取时机 | `rejectByAdmin`（D42 · 驳回）—— 把订单从当前的 `refund_applying` 回退到本列记录的状态 |
| 为什么必须有 | 订单状态机对退款分支**只有单向箭头**（`paid → refund_applying`），反向没有边。不记原状态，驳回时就**无家可回** —— 只能猜一个默认值，猜错就把订单放回错误状态 |
| 缺失如何处理 | **fail-closed → 40014**：缺列值（历史数据/脏写）时**拒绝驳回**，而不是回退到某个默认状态。宁可让运营走人工，也不静默把订单状态写错 |
| 可空性 | 允许为 `NULL`（历史行），但 D42 读到 `NULL` 即报 40014 —— 可空是兼容，不是「可以不写」 |

---

## 六、关键索引设计

| 表 | 索引 | 用途 |
| --- | --- | --- |
| `ab_meal_assignment` | `uk_meal_assignment_date_group` (meal_date, building_group_id) | 一日一楼群一套餐约束 |
| `ab_order` | `idx_order_assignment` (assignment_id) | 按分配查订单 |
| `ab_order` | `idx_order_status` (status, meal_date) | 订单中心筛选 |
| `ab_balance_log` | `idx_balance_log_user_time` (user_id, created_at) | 用户余额流水 |
| `ab_supplier_dish_daily` | `uk_supplier_dish_date` (supplier_id, dish_id, produce_date) | 供应商日菜品去重 |
| `ab_delivery_record` | `uk_delivery_date_group` (meal_date, building_group_id) | 一日一楼群一次配送 |
| `ab_withdraw` | `uk_withdraw_no` (withdraw_no) | 提现单号唯一（`WD`+yyyyMMdd+8 位） |
| `ab_withdraw` | `idx_withdraw_leader_time` (leader_id, created_at) | 团长提现记录（L13 列表） |
| `ab_withdraw` | `idx_withdraw_status` (status, created_at) | 后台审批队列（D45） |

---

## 七、初始数据 Seed

```sql
-- 楼群
INSERT INTO ab_building_group (name, city, district) VALUES
('国贸商圈', '北京', '朝阳区'),
('中关村商圈', '北京', '海淀区');

-- 办公楼
INSERT INTO ab_building (name, address, city, district) VALUES
('国贸大厦', '建国门外大街1号', '北京', '朝阳区'),
('银泰中心', '建国门外大街2号', '北京', '朝阳区'),
('中关村大厦', '中关村大街1号', '北京', '海淀区');

-- 系统配置
INSERT INTO ab_config (config_key, config_value, description) VALUES
('set_meal.default_price', '25.80', '套餐默认售价（统一价 · C1）'),
('set_meal.publish_time', '14:00', '每日开团时间'),
('set_meal.cutoff_time', '24:00', '每日截单时间'),
('set_meal.delivery_call_time', '10:00', '货拉拉叫车时间'),
('set_meal.packing_complete_time', '11:00', '兼职打包完成时间'),
('set_meal.delivery_arrival_time', '11:30', '送达办公楼时间'),
('commission.rate.trainee', '0.0800', '见习团长佣金比例（C2）'),
('commission.rate.formal', '0.0900', '正式团长佣金比例（C2）'),
('commission.rate.gold', '0.1000', '金牌团长佣金比例（C2）'),
('commission.rate.chief', '0.1200', '首席团长佣金比例（C2）'),
('commission.auto_confirm_time', '14:00', '自动确认收货时间'),
('commission.settle_hour', '02:00', '佣金自动结算时点'),
('commission.min_withdraw', '10.00', '最低提现金额'),
('order.cutoff_window_minutes', '10', '截单前 10 分钟禁止下单'),
('distribution_center.default_count', '4', '集散中心默认数量（表驱动，可增删 · C4）'),
('distribution_center.rice_fee', '0.00', '集散/场地费（复用供应商场地 → 默认 0 · C9 修订）'),
('distribution_center.pack_fee', '0.00', '打包费（改由平台兼职承担 → packing_labor_fee · C9 修订）'),
('settlement.supplier_purchase_price', 'negotiated', '供应商供价来源：与各供应商逐菜协商（非固定 · C9 修订）'),
('settlement.site_fee', '0.00', '集散/场地费：集散中心复用合作供应商场地 → 默认 0'),
('settlement.packing_labor_fee', '0.00', '打包人工：雇佣兼职打包（按件/按时/按班次），默认 0'),
('settlement.delivery_fee', '0.00', '配送费：安排货拉拉送货（按趟/按路线），默认 0'),
('settlement.gross_profit_policy', 'residual', '平台毛利口径：结果值 = 售价 − 成本合计 − 佣金'),
('wechat.subscribe.app_id', '', '小程序 AppID'),
('wechat.pay.mch_id', '', '微信支付商户号');

-- 集散中心（C4：默认 4 个，表驱动）
INSERT INTO ab_distribution_center (name, supplier_id, address, contact_name, contact_phone) VALUES
('集散中心 1（国贸片）', 1, '北京市朝阳区XX路1号', '王师傅', '13800000001'),
('集散中心 2（CBD片）',  2, '北京市朝阳区XX路2号', '刘师傅', '13800000002'),
('集散中心 3（中关村片）', 3, '北京市海淀区XX路3号', '赵师傅', '13800000003'),
('集散中心 4（望京片）',  4, '北京市朝阳区XX路4号', '钱师傅', '13800000004');
```

---

## 八、性能预估

| 接口 | QPS 预估 | P99 |
| --- | --- | --- |
| 首页加载套餐 | 50 | < 200ms |
| 下单提交 | 5 | < 500ms |
| 团长取餐列表 | 1 | < 300ms |
| 自动确认跑批 | 1（每日 1 次） | < 30s |
| 货拉拉送达推送 | 1 | < 10s |

> 单机 4C8G MySQL 可承载 10 个楼群（500 单/天）。

---

## 九、表数量总览

| 类别 | 数量 |
| --- | --- |
| 用户与角色域 | 4（user、team_leader、building、leader_invite） |
| 楼群域 | 1（building_group） |
| 商家域 | 2（supplier、dish） |
| 套餐域 | 3（set_meal、set_meal_item、meal_assignment） |
| 供应商生产域 | 1（supplier_dish_daily） |
| 订单与支付域 | 4（order、payment_log、refund、delivery_record） |
| 财务域 | 5（commission、supplier_share、balance、balance_log、withdraw） |
| 集散中心域 | 1（distribution_center） |
| 系统域 | 4（admin_user、operation_log、config、message） |
| **合计** | **25 张表** |

> 张数说明：较 v1.0 删除 3 张（address / company / floor_leader）、新增 8 张、修改 8 张、沿用 9 张。
> ⚠️ 阶段二已补 `ab_leader_invite`（支撑 C2 晋级审计）与 `ab_withdraw`（C11 提现单），
> **合计 25 张表** —— 与 `apps/api-server/src/database/entities/index.ts` 的 `ALL_ENTITIES` 逐张对齐，
> 并由 `tests/baseline_manifest.py` 在门禁中校验。

---

*文档结束 · ABox 一盒 · ER v2.1（回填 C2/C3/C4/C6/C9；阶段一基线一致性修补）· 2026-09-14*
*2026-09-15 增补：`ab_withdraw` 提现申请单（C11）· `ab_balance_log` 出款字段 · `ab_team_leader` 收款方式三字段 + `floor` 恢复*
