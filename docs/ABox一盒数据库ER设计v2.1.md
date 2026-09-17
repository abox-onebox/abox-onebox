# ABox 一盒 · 数据库 ER 设计 v2.1

> 基于 ER v2.0 增量修订，回填《MVP 优化交接包 v1.1》C2/C3/C4/C6/C9 裁决（2026-09-14）
> 前置：v1.0 ER 设计（已废弃）；核心差异见 § 一
> **工程增量（2026-09-15 ~ 09-16）**：§5.1 M3 补丁 · §5.3 M3-4 `ab_refund.order_status_before` · §5.4 M3-5 零 DDL · **§5.5 M3-6 `ab_supplier` 补 7 列**

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

### 1.2 新增的表（10 张）

| 表名 | 用途 |
| --- | --- |
| `ab_building_group` | 楼群（多栋楼聚合为一个分发单位） |
| `ab_meal_assignment` | 套餐-楼群-日期分配表 |
| `ab_balance` | 用户余额账户 |
| `ab_balance_log` | 余额变动流水 |
| `ab_supplier_dish_daily` | 供应商-菜品-日期对应（每日生产哪道菜） |
| `ab_delivery_record` | 货拉拉送达记录（轻量） |
| `ab_distribution_center` | 加工场所配置（C4 · 表驱动，默认 4 个，可增删；**M4-0 起 `supplier_id` 为可空历史字段**） |
| `ab_withdraw` | **提现申请单**（2026-09-15 补 · C11：出款走灵活用工代发代扣，须独立单承载提现单号 / 审批 / 打款状态） |
| `ab_supplier_dish_center_daily` | **供应商-菜品-集散中心-日 交付确认明细**（2026-09-16 补 · M3-8：出餐确认的交互粒度是「一道菜分别送达 N 个集散中心」的**逐项**确认，需独立承载实送份数 / 确认人 / 确认时点） |
| `ab_message_template` | **通知模板**（2026-09-16 补 · M3-12：D59/D60 的「场景 + 渠道 + 变量白名单 + 启用闸门」在 `ab_config` 的**扁平标量**类型系统里装不下；且 `ab_message` 是**推送日志**表（`template_id` 存微信侧模板 ID），**不是模板定义**） |

### 1.3 修改的表（7 张）

| 表名 | 修改 |
| --- | --- |
| `ab_user` | `phone` 改可选；删除 `company_id`、`floor` 必填 |
| `ab_set_meal` | 删除 `uk_set_meal_date`（同一天可以有多个套餐分配给不同楼群） |
| `ab_set_meal_item` | `supplier_id` 不再唯一约束（可重复，前期一人多菜） |
| `ab_supplier` | 增加 `type` 字段（出餐型/集散型/混合型 · **M4-0 起转为历史字段**）；**增加资质审核五列 `audit_status` / `audit_remark` / `audited_at` / `audited_by` + 证照有效期 `license_expire_at`（D26 落点 · 2026-09-16 补）**；**增加 `invoice_title`（D28 发票抬头）与 `takeout_links`（JSON · 外卖跳转 · 不参与结算）** |
| `ab_team_leader` | 增加 `balance` 字段（余额账户）；`level` 等级字段（C2）；`signed_at` 改为 `agreed_at` 勾选协议（C3）；**增加 `floor` 楼层维度（2026-09-15 裁定② 恢复）**；**增加收款方式三字段 `payout_type` / `payout_account`（脱敏存储）/ `payout_name`（C11 · 提现前置条件，2026-09-15 补）** |
| `ab_refund` | 增加代退三段式字段：`apply_source`、`apply_reason`、`apply_by_leader_id`、`approve_admin_id`、`approve_at`（C6）；**增加 `order_status_before`（申请前订单状态 · D42 驳回回退的唯一依据，2026-09-15 补）** |
| `ab_balance_log` | **增加出款字段 `payout_channel` / `payout_batch_no` / `tax_withheld_amount`（P2-5 · C11，2026-09-15 补）** |

---

## 二、ER 总览（27 张表 · 2026-09-16 增补 `ab_supplier_dish_center_daily` 与 `ab_message_template`）

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
       │ab_config     │    │ab_message    │  推送日志（只增）
       └──────────────┘    └──────────────┘
                                   ▲ 发射自（场景键）
       ┌────────────────────┐      │
       │ab_message_template │──────┘  通知模板（M3-12 · 27 张表）
       │ (通知模板·5 场景)  │
       └────────────────────┘

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

> ⚠️ **上列 DDL 与实装的两处偏差（按实际库为准，`migrations/1700000000000-init.ts`）**：
> ① `distribute_supplier_id` 已改名 **`distribution_center_id`**（可空）—— 《表结构评审意见 v1.0》**P0-3** 改为「集散中心」表驱动（C4），且 M4-0 起**不再按供应商归属**，对外派生文案统一称「**加工场所**」；
> ② 实装多一列 **`sold_count` INT UNSIGNED NOT NULL DEFAULT 0**，**注释已由「已订份数（实时累加）」修正为「截单定格的已售份数」**（M4-1 · 2026-09-17）：
> 原注释描述的「实时累加」**在代码里从来没有实现过**（下单 / 取消 / 退款三条路径都没有累加点，只有种子赋过值），
> 而它是 `ab_supplier_dish_daily.plan_quantity`（推给供应商的备料量）的**聚合基数** ——
> 于是跑批推的份数**恒为 0，且没有任何地方会报错**。
> **现口径**：在**截单这一「定格」时刻**从 `ab_order` 聚合一次并落库，计入
> `status NOT IN ('pending_pay','cancelled')` 的订单份数；**截单前不承诺准确，截单后不再变**。
> ⭐ 语义上是「**已发生的事实**」而非派生值 —— 自营口径下它是**供应商采购款的基数**（实收量口径的另一端），
> 故与「生产计划生成即冻结」同族：**在唯一的业务事件时点定格一次，事后不重算**。

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

#### 3.6.1 `ab_supplier_dish_center_daily` 供应商-菜品-**集散中心**-日 交付确认明细（M3-8 新增）

```sql
CREATE TABLE `ab_supplier_dish_center_daily` (
  `id`                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `supplier_id`            BIGINT UNSIGNED NOT NULL,
  `dish_id`                BIGINT UNSIGNED NOT NULL,
  `produce_date`           DATE NOT NULL COMMENT '出餐日（= 套餐日 T，非确认操作日）',
  `distribution_center_id` BIGINT UNSIGNED NOT NULL COMMENT '送达目标集散中心',
  `plan_quantity`          INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '应送份数（分中心）',
  `actual_quantity`        INT UNSIGNED DEFAULT NULL COMMENT '实送份数；短送/多送都要留痕（对账依据）',
  `status`                 VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending / confirmed',
  `confirmed_at`           DATETIME(3) DEFAULT NULL,
  `confirmed_by`           BIGINT UNSIGNED DEFAULT NULL COMMENT '确认操作账号（ab_admin_user.id）',
  `remark`                 VARCHAR(255) DEFAULT NULL COMMENT '备注（如短送原因）',
  `version`                INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sddc` (`supplier_id`, `dish_id`, `produce_date`, `distribution_center_id`),
  KEY `idx_sddc_supplier` (`supplier_id`),
  KEY `idx_sddc_date_center` (`produce_date`, `distribution_center_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出餐确认明细（按集散中心逐项）';
```

> **为什么必须独立成表**（而不是在 `ab_supplier_dish_daily` 上挂 JSON 列）：
> ① 粒度天然**一对多** —— 一道菜同一天要分别送到 N 个集散中心（原型 P22：红烧肉 385 份 → 4 个中心各 120/96/88/81），
> JSON 列无法做「**哪些集散中心还没确认**」的 SQL 聚合，而这正是 S3 打包闸门的刚需；
> ② 确认是一个**事件**（实送份数 + 操作人 + 时点），并发确认同一父行的 JSON 会**丢更新**；
> ③ S3 要按集散中心 join 出「所有供应商的到位情况」，JSON 到不了。
>
> **与父表的关系**：本表是明细，`ab_supplier_dish_daily` 是**日计划总量**。
> 父表 `status` 由本表**派生驱动**（无确认 `pending` / 部分 `cooking` / 全部 `done`），
> 故**不新增 `partial`** —— 既有三值域已能表达，扩枚举会牵动 M1/M2 已验收的读端。
>
> **零产量不落库**：只生成 `plan_quantity > 0` 的行（`sold_count=0` 的分配很常见，
> 照单生成会让 P21 长出一串「0 份」的菜）。

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

### 3.8 `ab_distribution_center` 集散中心配置表（C4 · 新增）⭐（**M4-0 起对外称「加工场所」** —— 实体名与 `name` 字段保留，改的是派生文案与页面标题）

```sql
CREATE TABLE `ab_distribution_center` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(64) NOT NULL COMMENT '集散中心名，如"集散中心 1（国贸片）"',
  `supplier_id`   BIGINT UNSIGNED DEFAULT NULL COMMENT '⚠️ M4-0 起为**历史字段**（列保留 · 可空 · 新逻辑不读不写）：加工场所属 ABox 自有，不再关联供应商',
  `address`       VARCHAR(256) NOT NULL COMMENT '场地地址（**M4-0 起**：ABox 自有持证场所地址，不再复用供应商场地；须 = 证照地址 = 线上店铺地址）',
  `contact_name`  VARCHAR(32)  DEFAULT NULL,
  `contact_phone` VARCHAR(20)  DEFAULT NULL,
  `rice_fee`      DECIMAL(8,2) NOT NULL DEFAULT 0.00 COMMENT '场地费（C9 修订 + M4-0：**默认 ¥0 仅表示「尚未登记」，不代表成本为零** —— ABox 自有场所摊销，非 0 才是常态）',
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='加工场所配置（MVP 默认 4 个，数量可配置，不硬编码；M4-0 起 supplier_id 为历史字段）';
```

> ⭐ C4 裁决：运营按 4 个跑，但系统**不得硬编码**；集散中心**复用合作供应商场地**，场地 / 打包费用**默认 ¥0**（科目保留、字段级拆分便于审计，按实际登记）。<br>> **C9 修订（2026-09-15）**：原「固定 ¥5.00/份 = 米饭 ¥2.00 + 打包 ¥3.00」作废 —— 供价逐菜协商、场地复用默认 0、打包人工与配送费单列，平台毛利为结果值。<br>> **M4-0 修订（2026-09-16 · 自营口径前置）**：① `supplier_id` 由 NOT NULL 改**可空历史字段**（加工场所属 ABox 自有，不再挂供应商）；② 对外**派生文案**（打包任务 `reason` / 菜单 / 页面标题）统一称**「加工场所」**，实体名与库内 `name` 字段**保留**；③ 费用**默认 0 仅表示「尚未登记」**（自营下场地是 ABox 自有场所摊销、打包是 ABox 用工，**非 0 才是常态**）；④ 场地须为 ABox **自有持证场所**（证照地址 = 线上店铺地址 = 实际出餐地址）。

### 3.9 `ab_message_template` 通知模板（M3-12 · 2026-09-16 新增）⭐

```sql
CREATE TABLE `ab_message_template` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `scene`              VARCHAR(64) NOT NULL COMMENT '场景键（取值来自 MESSAGE_TEMPLATE_SPECS，D60 不可改）',
  `enabled`            TINYINT NOT NULL DEFAULT 0 COMMENT '总开关 1启用 0关闭 —— **真生效**',
  `wechat_template_id` VARCHAR(64) DEFAULT NULL COMMENT '微信订阅消息模板 ID（微信公众平台创建）—— **真生效**',
  `group_content`      TEXT DEFAULT NULL COMMENT '微信群人工通知文案，含 {{变量}}，变量须在该场景白名单内 —— **存档用途**',
  `updated_by`         BIGINT UNSIGNED DEFAULT NULL COMMENT '最近修改人（ab_admin_user.id）',
  `version`            INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_msg_tpl_scene` (`scene`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知模板（5 场景 · 只存可编辑部分，场景定义留在代码里）';
```

> ⭐ **为什么必须独立成表**（而不是塞进 `ab_config`）：
> ① `CONFIG_SPECS` 的类型系统是**扁平标量**（money / percent / int / text / time），撑不住
> 「场景 + 多渠道 + 变量白名单 + 启用闸门」这个**结构化**整体。硬塞只有两条路 ——
> JSON-in-`config_value`（则 D58 的白名单与单点校验失效，校验逻辑四散 → 立刻多出第二个真相），
> 或拆成十几个扁平键（则「一个场景」在库里不复存在，`ab_message` 也无从对应）；
> ② ⚠️ **一处规格纠偏**：《接口规范》§八 原把 `ab_message` 列入 P36 依赖 —— 实查它是
> **推送日志**表（只增，记「发过什么」），**不是模板定义**，故新增本表并同步登记映射表。
>
> ⭐ **场景定义不落库**：`scene` / 渠道组合 / 触发时机 / 变量白名单 / 是否必推全是**代码事实**
> （`modules/admin/template/message-template.specs.ts`），落库必然漂移成「库里写着走微信群、
> 代码只发订阅消息」这种**无法自证**的矛盾。本表只存**可编辑部分**。
>
> ⭐ **`group_content` 的效力必须说清**：微信订阅消息的内容格式在**微信公众平台**侧按模板
> 定义（`thing1` / `time2` 这类 keyword），服务端只能往 `data` 填值 —— 后台改文案**改不了
> 用户看到的推送**。故本字段是**存档 / 人工发群**用途，页面以 `fieldWiring='record_only'`
> 如实标注（同 M3-10「给了输入框却没接上线」的纪律）。
>
> **零产量不适用**：本表是**全局配置**（5 行），由 `MESSAGE_TEMPLATE_SPECS` **派生种子**
> （不存在第二份场景列表）；只有 `leader_delivery` 种子态启用（含微信群渠道，人工发群只需文案）。

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
  `type`            VARCHAR(16) DEFAULT NULL
                    COMMENT '⚠️ M4-0 起为**历史字段**（列保留 · 新逻辑不读不写）：dish=出餐型 / distribute=集散型 / both=混合型',
  `contact_name`    VARCHAR(32)  NOT NULL,
  `contact_phone`   VARCHAR(20)  NOT NULL,
  `business_license` VARCHAR(256) DEFAULT NULL,
  `food_license`    VARCHAR(256) DEFAULT NULL,
  `license_expire_at` DATE       DEFAULT NULL COMMENT '食品经营许可证有效期（M3-6 · 123 号令核验项）',
  `audit_status`    VARCHAR(16) NOT NULL DEFAULT 'pending'
                    COMMENT 'pending待审 / approved通过 / rejected驳回（M3-6 · D26 落点）',
  `audit_remark`    VARCHAR(256) DEFAULT NULL COMMENT '审核意见（驳回必填 · M3-6）',
  `audited_at`      DATETIME(3) DEFAULT NULL COMMENT '审核时间（M3-6）',
  `audited_by`      BIGINT UNSIGNED DEFAULT NULL COMMENT '审核人 ab_admin_user.id（M3-6）',
  `invoice_title`   VARCHAR(128) DEFAULT NULL COMMENT '发票抬头（M3-6 · C10）',
  `takeout_links`   JSON         DEFAULT NULL COMMENT '外卖平台店铺链接（M3-6 · 不参与结算）',
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商（M4-0 起 type 为历史字段 —— 不再区分出餐型/集散型/混合型）';
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
| `ab_commission` | 不变（流水表；佣金比例由 4 级阶梯 8/9/10/12% 配置驱动 · C2）。⭐ **M4-2 起 `status` 走两段式**：`pending`（T 日 14:00 计佣，**钱还没进余额**）→ `settled`（T+1 02:00 入账）；退款落在 `pending` 窗口时置 `cancelled`（**不写负行**） |
| `ab_supplier_share` | 不变（⚠️ 2026-09-16 自营口径：语义已从「分账流水」改为「**半成品采购应付流水**」，**零 DDL**；`payee_type` 恒 `supplier`，`distribution_center` 冻结；**M3-9 已实装**：出单 / 列表 / 付款登记 / 未出单异常清单 + 供应商端 S9 自查，**幂等走软层不建唯一索引**——本表要容纳 `type='reversal'` 负行，同键正负两行是合法冲销） |
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
>
> ⚠️🚧 **2026-09-16 自营口径修订**：下表中 **`ab_supplier_share` 一行已作废**（退款不再冲减供应商应付）——
> 半成品在出餐日当日已交付并投入使用，退款发生在交付之后，与供应商无关。
> `reverseSupplierShares()` 待回退，列为 **M3-9 开工前置项**。详见 《ABox一盒自营结算口径定义v1.0.md》 §5。
> 其余各行（`ab_refund` / `ab_order` / `ab_commission` / `ab_balance`）**不受影响**。

| 表 | 写什么 | 口径 |
| --- | --- | --- |
| `ab_refund` | 新增一行（`apply_source='admin'`，`status='refunding' → 'refunded'`）· **`reversed=1` + `reversed_at`** | `reversed` 是「反向结算已执行」幂等位；`cancelled_at` 在 `ab_order` 上近似承载退款时刻（无独立 `refunded_at` 列） |
| `ab_order` | `status='refunded'` · `cancelled_at=now` | 退款是**终态**；`cancelled_at` 复用为「异常区时间线」的发生时间 |
| `ab_commission` | **两段式下分两条路径**（M4-2 · 2026-09-17）：① 退款落在**未入账窗口**（`pending`）→ **只置原 `normal` 行 `status='cancelled'`**、**不新增反向行**（钱从未进过余额）；② 佣金**已入账**（`settled`）→ **新增一行** `type='reversal'`（`amount` / `quantity` 取负）**且**原 `normal` 行 `status='cancelled'` | **C9：原记录不得改写** —— 两条路径都保持原行金额为原值（改成 0 会让佣金明细的「发生额」永久失真）。⚠️ 旧实现只写路径②，在 `pending` 窗口下会**从余额里扣一笔从未入账的钱**（甚至扣成负数形成假欠款），而余额本就可为负 → **不报任何错** |
| `ab_balance` / `ab_balance_log` | 余额退回（`type='refund'`,`direction=+1`）/ 佣金冲销（**仅 `settled` 路径**：`direction=−1`）。⭐ **佣金仍为 `pending` 时不产生任何余额流水** | 余额**允许被扣成负数**：佣金已提现就形成欠款，由后续佣金抵扣；硬拦会把退款卡死。⚠️ 但「允许为负」不等于「可以凭空扣」—— `pending` 窗口下扣的是**从未入账的钱** |
| ~~`ab_supplier_share`~~ | ⛔ **已作废（2026-09-16 自营口径）** —— 原文：「未付款行 → 直接扣减（扣空置 `status='reversed'`）；已付款行 → 写反向流水（`type='reversal'`）挂下期抵扣」 | 作废理由：该口径成立的前提是「供应商按用户卖出的份数**分账**」。自营下应付基数是**实收量**，半成品已交付 → **退款不冲减供应商应付**。`type='reversal'` 改义为「应付单算错」的**纠错冲销**。✅ **回退已完成（M3-9）**：`reversal.service.ts` 移除 `reverseSupplierShares()`，退款不再触碰本表 |

**关键字段速查**

| 字段 | 语义 |
| --- | --- |
| `ab_refund.amount` | **用户实际付出去的钱** = `total_amount − discount_amount`（＝微信实付 + 余额抵扣）。**不是** `pay_amount` |
| `ab_refund.auditor_id` | 后台强制退款时 = 操作人（「自己批准自己」）；D41 审批时 = 真实审批人 |
| `ab_refund.order_status_before` | **申请前的订单状态** —— D42 驳回时订单要回到哪里的**唯一依据**。见 §5.3 |
| `ab_supplier_share.type` | `normal` 正常采购 / `reversal` **纠错冲销**（⚠️ 2026-09-16 自营口径改义：**不再由退款触发**，仅用于「应付单生成后发现算错」，由运营主动发起）；`reversal` 行的 `share_date` = **冲减登记日**（决定进哪一期的结算单） |
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

### 5.4 M3-5 后台团长管理：**零 DDL 变更**

> M3-5（D19–D22 · 原型 P32）**不动任何表结构** —— 这是刻意的结果，不是「还没来得及」。

| 能力 | 复用的既有列 | 说明 |
| --- | --- | --- |
| D19 名录（等级 / 费率 / 月单 / 推荐数 / 余额 / 冻结） | `ab_team_leader.level` · `commission_rate` · `month_orders` · `invited_formal_count` · `total_commission` · `pending_amount` · `floor` | M2 已把团长侧数据打全，后台只做读聚合（`ab_balance` 取余额真源） |
| D19 申请流水 | `ab_team_leader.created_at`（＝申请时间）+ `ab_leader_invite.channel` | C3 申请即生效 → 流水**即终态**，没有 `pending` 审核态列（`pendingAuditCount` 恒为 0 是**口径表达**） |
| D19 裂变链 | `ab_leader_invite.inviter_leader_id` · `invitee_user_id` · `invitee_leader_id` · `is_formal` · `formal_at` | 上行（谁推荐他）与下行（他推荐了谁）共用这一张表 |
| D20 任命 / 转交 | `ab_team_leader.status`（现任置 2）+ `ab_user.building_id` | 继任者**新建行**而非改写原行，故不需要「交接历史」列 —— 历史佣金与推荐关系天然留在原行 |
| D21 变更 | `level` + `commission_rate`（**联动**）· `building_id` · `floor` · `level_updated_at` | 费率联动是 M2 既有约定，D21 只是补上后台入口 |
| D22 资质补录 | `status` · `agreed_at` · `agree_version` + `ab_user.team_leader_id` | 停用同时清归属，与 L20 退出团长同一处理 |

⚠️ **没有「微信号」列**：原型 P32 申请流水表格里的「微信号」在数据模型里**无对应字段**（L17 申请表单只收 姓名 / 手机号 / 楼层 / 办公楼 / 协议）。本期以 `ab_user.nickname` + `openid` 后 6 位代替，并在接口出参 `notes.wechatId` 里如实标注偏差 —— 若要真实微信号，须改 L17 表单并**新增列**（届时本表会出现在 §四）。

### 5.5 M3-6 后台供应商管理：`ab_supplier` 补 7 列（**有 DDL 变更**）

> M3-6（D23–D32 · 原型 P33 · 模块 M34-01~04）的唯一结构变更。**为什么非加不可**：D26 是「资质审核」接口，而 `ab_supplier` 原本只有 `business_license` / `food_license` 两个**存证照编号的字符串**，没有任何地方记录「审没审过、谁审的、什么时候审的」—— 没有落点，审核就只是把请求丢掉。
> 同时补齐原型 P33 明确展示的「资质到期」列：123 号令要求平台核验入网商户证照，**证照过期即不得出餐**，没有到期日就既算不出「30 天内到期」KPI，也做不了到期联动下架。

```sql
ALTER TABLE `ab_supplier`
  ADD COLUMN `audit_status`      varchar(16) NOT NULL DEFAULT 'pending'
             COMMENT 'pending待审 / approved通过 / rejected驳回（D26 落点）',
  ADD COLUMN `audit_remark`     varchar(256) NULL COMMENT '审核意见（驳回必填，便于运营答复商家）',
  ADD COLUMN `audited_at`       datetime(3)  NULL COMMENT '审核时间',
  ADD COLUMN `audited_by`       bigint       NULL COMMENT '审核人 ab_admin_user.id',
  ADD COLUMN `license_expire_at` date        NULL COMMENT '食品经营许可证有效期（123 号令核验项）',
  ADD COLUMN `invoice_title`    varchar(128) NULL COMMENT '发票抬头（C10 人工对公转账用，与展示名可能不同）',
  ADD COLUMN `takeout_links`    json         NULL COMMENT '外卖平台店铺链接（美团/淘宝闪购/京东，仅用户端溯源跳转，不参与结算）';
```

| 列 | 关键口径 | 理由 |
| --- | --- | --- |
| `audit_status` | 与 `status`（1 合作中 / 0 停用）**正交** | 审核回答「有没有合规资格」，停用回答「平台现在要不要合作」。驳回**不自动停用** —— 审核是事实判定，停用是经营决策；若混在一起，「驳回」会变成不可逆的经营动作 |
| `audit_status` 默认值 | `pending`（新建即待审） | 资质未核验前 `canServe=false`，S2 出餐前置校验会拦（50001）。默认给 `approved` 等于「默认放行」 |
| `audited_by` | 显式落库，**不靠操作日志反查** | 操作日志的 `targetId` 只能表达「审了哪个对象」，表达不了「审谁」；合规场景要能直接 `SELECT` 出审核人 |
| `license_expire_at` | `DATE`，可空 | 可空 = 兼容历史行，不是「可以不登记」—— D26 `approved` 要求该值**未过期**，缺值即 50001 |
| `invoice_title` | 独立列，**不复用 `name`** | 展示名与开票名不一致是常态（个体户尤其） |
| `takeout_links` | `JSON`，**不建独立表** | 结构固定（3 平台 + 可选推荐）且**不参与任何结算**；换掉一整张表与一套 CRUD。用途仅限用户端 P38 溯源页跳转（C8：能跳转 ≠ 是合作伙伴） |

⚠️ **派生值不落库**：`licenseState`（`normal`/`expiring`/`expired`/`unknown`）与 `canServe` 都是**服务端现算**。落库就要有定时任务去刷，算错一次就是一整批脏数据。

⚠️ **集散中心（`ab_distribution_center`）零 DDL 变更**：D29–D32 复用的列在 v1.0 已齐备（`rice_fee` / `pack_fee` 默认 0 · `service_groups` JSON · `supplier_id` · `status` · `deleted_at`）。软删靠既有 `deleted_at`，无需新增 —— D32 的两道前置（历史应付 / 被分配引用）是**校验逻辑**，不是结构。

### 5.7 M4-0 契约级修正：两列降级为历史字段（**改可空 · 零新增列 · 零新表**）

> M4-0（2026-09-16 · 自营口径前置）把 M3-6 引入的、在自营口径下不再成立的两个假设拆掉。**表数仍 27**。

| 表 | 列 | 变更 | 理由 |
| --- | --- | --- | --- |
| `ab_distribution_center` | `supplier_id` | `NOT NULL` → **`DEFAULT NULL`**（历史字段） | 自营下加工场所是 ABox **自有**场地；「场所属于某供应商」既无业务意义，又让「场所 → 供应商」唯一性约束失真 |
| `ab_supplier` | `type` | `NOT NULL DEFAULT 'dish'` → **`DEFAULT NULL`**（历史字段） | 三分类（出餐型 / 集散型 / 混合型）的前提是「供应商自己兼营场所」——自营下前提不成立 |

**统一手法（三要素，缺一不可）**：

1. **列保留** —— 历史数据可读，不删列、不改名（删列会连带毁掉历史审计与回滚能力）；
2. **改可空** —— 新流程不再写值，非空约束会让新插入失败；
3. **新逻辑不读不写 + DTO 删字段** —— 前端传旧字段即 **`10001`**（`forbidNonWhitelisted`），**绝不静默忽略**（静默忽略 = 「传了不报错、也不生效」，最难查的一类不一致）。

**连带收敛（同一批次）**：

- `PUT /admin/suppliers/{id}/type`（D27）**整条路由删除** → 旧路径 `10004`；错误码 `50008 SUPPLIER_TYPE_CONFLICT` 三处闸门拆除、号位保留不再使用；
- D23 列表不再下发 `typeOptions`、`?type=` 筛选不受理；供应商详情由 7 块减为 **6 块**（移除「加工场所」块与 `dcCount`）；
- D29/D30/D31 三个入口**均不再收 `supplierId`** → `10001`；
- ⭐ 打包任务 `GET /supplier/packing-tasks`（S3）**整条迁运营后台** `GET /admin/packing-tasks`（P39）—— 原可见性判据「本主体名下有启用中集散中心」在上述改动后**必然失效**，且其**数据面本身跨供应商**（开给任一供应商即泄露同业经营数据，违反 I1），故**迁移**而非换判据。详见《缺陷与陷阱》#58。

**迁移与种子落点**：`migrations/1700000000000-init.ts`（`ab_distribution_center.supplier_id` 已建为 `DEFAULT NULL`）· `seeds/seed.ts`（4 个场所**不写 `supplierId`**，`riceFee`/`packFee` 写 0 并在注释里点明「未登记 ≠ 免费」）。

### 5.6 M3-7 后台办公楼与楼群：`ab_building` 增 1 列 + 状态三态（**有 DDL 变更 · 无新表**）

> M3-7（D13–D18 · 原型 P37 五视图 · 模块 M33-01/02）的结构变更。**为什么非加不可**：
> ① 原型 P37 列表逐行显示「约 520 人」，而 `ab_building` 只有 `floor_count`（楼层数）—— 备料量测算与楼栋容量评估需要的是**人数**，不是层数，且层数推不出人数。
> ② `status` 原注释「1 合作中 / 2 停用」而种子把「待开通」与「已暂停」**都写成 `2`** —— 一值两义：运营既分不清「还没上线」和「已暂停合作」，也做不了「停用后恢复」的状态机。

```sql
ALTER TABLE `ab_building`
  ADD COLUMN `population` int NULL COMMENT '覆盖人数（运营估算，非实时统计）',
  MODIFY COLUMN `status` tinyint NOT NULL DEFAULT 1 COMMENT '1营业中 2待开通 3已暂停',
  ADD INDEX `idx_building_status` (`status`);
```

| 列 | 关键口径 | 理由 |
| --- | --- | --- |
| `population` | `INT NULL`，**运营录入的估算值** | 真实就餐人数看订单量；混用会让「覆盖率」类指标失去意义。可空 = 兼容历史行、允许「还没估」 |
| `status` 三态 | `1` 营业中 / `2` 待开通 / `3` 已暂停，`tinyint` **值域扩展** | 只扩值域、不动类型；`1` 的语义**不变**（旧数据无需迁移）。旧值 `2` 归「待开通」—— 保守处理：合作状态未确认的按未开通算 |
| `status` 唯一可开团值 | **只有 `1`** | 套餐编排的楼栋多选把 2/3 一律禁选；`canOrder` 亦要求 `1` |
| `idx_building_status` | 新增单列索引 | D13 列表按状态筛选、P37 总览统计各状态楼栋数是高频路径 |

⚠️ **`ab_building_group` 零 DDL 变更**：`status`（1 启用 / 2 停用）**刻意保持二态**，不沿用楼栋三态 —— 楼群是纯组织维度，没有「待开通」这个中间态；多一个值只会让筛选器多一个永远为 0 的选项。

⚠️ **「主/备集散中心 + 路线号」不落库**：`delivery-map` 视图与 D13/D16 出参里的 `mainDcId` / `backupDcId` / `routeNo` 全部由 `ab_distribution_center.service_groups`（M3-6）**实时派生**，楼栋上不存副本。落库就要有定时任务去刷，改一次集散配置就会造出「配置已改、楼栋还显示老集散」的不一致。

⚠️ **DDL 总量**：25 张表不变（M2 的 `ab_withdraw` 之后**无新增表**）；`ab_building` 是本批次唯一被改的表。

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
('settlement.site_fee', '0.00', '场地费：ABox 自有场所摊销 → 默认 0 仅表示「尚未登记」，非 0 才是常态'),
('settlement.packing_labor_fee', '0.00', '打包人工：雇佣兼职打包（按件/按时/按班次），默认 0'),
('settlement.delivery_fee', '0.00', '配送费：安排货拉拉送货（按趟/按路线），默认 0'),
('settlement.gross_profit_policy', 'residual', '平台毛利口径：结果值 = 售价 − 成本合计 − 佣金'),
('wechat.subscribe.app_id', '', '小程序 AppID'),
('wechat.pay.mch_id', '', '微信支付商户号');

-- 加工场所（C4：默认 4 个，表驱动）
-- ⚠️ M4-0 起**不写 supplier_id**（历史字段）；seed.ts 内的演示 `name` 仍为「集散中心 N（片区）」，
--    改的是派生文案与页面标题（对外一律称「加工场所」）。
INSERT INTO ab_distribution_center (name, address, contact_name, contact_phone) VALUES
('集散中心 1（国贸/建外）', '朝阳区建国路 88 号', '王师傅', '13800000001'),
('集散中心 2（银泰/建外）', '朝阳区光华路 21 号', '刘师傅', '13800000002'),
('集散中心 3（国贸/远洋）', '朝阳区东三环中路 65 号', '赵师傅', '13800000003'),
('集散中心 4（华贸组）',   '朝阳区四惠东', '钱师傅', '13800000004');
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
| 供应商生产域 | 2（supplier_dish_daily、supplier_dish_center_daily） |
| 订单与支付域 | 4（order、payment_log、refund、delivery_record） |
| 财务域 | 5（commission、supplier_share、balance、balance_log、withdraw） |
| 集散中心域 | 1（distribution_center） |
| 系统域 | 5（admin_user、operation_log、config、message、message_template） |
| **合计** | **27 张表** |

> 张数说明：较 v1.0 删除 3 张（address / company / floor_leader）、新增 9 张、修改 8 张、沿用 9 张。
> ⚠️ 阶段二已补 `ab_leader_invite`（支撑 C2 晋级审计）与 `ab_withdraw`（C11 提现单）；
> M3-7 **零新表**（仅 `ab_building` 增 `population` 列）、**M3-8 补 `ab_supplier_dish_center_daily`**（出餐确认明细）、
> **M3-10 / M3-11 零新表**（配置走 `ab_config`、看板纯聚合）、**M3-12 补 `ab_message_template`**（通知模板），
> **合计 27 张表** —— 与 `apps/api-server/src/database/entities/index.ts` 的 `ALL_ENTITIES` 逐张对齐，
> 并由 `tests/baseline_manifest.py` 在门禁中校验。

---

*文档结束 · ABox 一盒 · ER v2.1（回填 C2/C3/C4/C6/C9；阶段一基线一致性修补）· 2026-09-14*
*2026-09-15 增补：`ab_withdraw` 提现申请单（C11）· `ab_balance_log` 出款字段 · `ab_team_leader` 收款方式三字段 + `floor` 恢复*
*2026-09-16 增补：`ab_supplier_dish_center_daily`（M3-8 出餐确认明细 · 26 张）· `ab_message_template`（M3-12 通知模板 · **27 张**）*
