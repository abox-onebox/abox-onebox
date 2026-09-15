# ABox 一盒 · 表结构评审意见 v1.0

> **文档性质**：ER v2.1（23 张表）的开发前评审结论 + 缺口补齐 DDL
> **评审范围**：字段完备性（能否支撑 C1–C9）、表间一致性、索引与性能、跨层口径（DB ↔ API）
> **结论**：**建议修订后通过** —— 6 项 P0 必须修，6 项 P1 建议修，4 项 P2 可选
> **评审后表数**：23 → **24 张**（新增 `ab_leader_invite`）

---

## 〇、文档信息

| 项 | 内容 |
| --- | --- |
| 版本 | v1.0 |
| 日期 | 2026-09-14 |
| 评审对象 | `ABox一盒数据库ER设计v2.1.md` |
| 依据 | 交接包 v1.1（C1–C9）· PRD v2.1 · 接口规范 v1.0 · 订单状态机 v1.0 |
| 评审人 | 产品/架构（AI 辅助）· 待后端负责人会签 |

---

## 一、评审结论摘要

### 1.1 总体判断

ER v2.1 在 v1.0 基础上做的**结构性调整是正确的**：删除楼长相关表、引入 `ab_meal_assignment` 作为"日 × 楼群"核心分配表、把套餐还原为"模板"、新增集散中心配置表（C4）——这些都准确反映了业务演进。

但**"设计完整性"仍有缺口**：23 张表中有 **9 张没有字段定义**（§五 仅列名），其中 `ab_commission`、`ab_supplier_share`、`ab_refund` 三张**恰恰是 C2/C6/C9 的落点**，不补则无法开工。

### 1.2 问题分级统计

| 级别 | 数量 | 含义 |
| --- | --- | --- |
| **P0 必须修** | 6 | 不修则对应裁决项无法实现，或与 PRD/接口冲突 |
| **P1 建议修** | 6 | 不修可开工，但会埋下歧义或返工风险 |
| **P2 可选** | 4 | 优化项，二期亦可 |
| 合计 | 16 | — |

---

## 二、P0 · 必须修正项

### P0-1 ⛔ `ab_team_leader` 缺 `level` 字段，且 `commission_rate` 默认值错误

**问题**

```sql
`commission_rate` DECIMAL(5,4) NOT NULL DEFAULT 0.1000,
```

- 默认值 `0.1000`（10%）是 **v1.0 时代的单一佣金口径遗留**。C2 出台后为 **4 级阶梯 8/9/10/12%**，新申请团长应为**见习 8%**，默认值应改 `0.0800`。
- 更严重：**整表没有 `level` 字段**。C2 的"见习/正式/金牌/首席"是**业务实体状态**，不能用 `commission_rate` 反推（调价后费率与等级会脱钩）。

**修正建议**

```sql
ALTER TABLE `ab_team_leader`
  ADD COLUMN `level` VARCHAR(16) NOT NULL DEFAULT 'trainee'
    COMMENT 'trainee见习/formal正式/gold金牌/chief首席（C2）' AFTER `real_name`,
  ADD COLUMN `level_updated_at` DATETIME(3) DEFAULT NULL COMMENT '最近升级时间' AFTER `level`,
  ADD COLUMN `month_orders` INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT '当月完成份数（C2 月单，每日跑批刷新）' AFTER `total_orders`,
  ADD COLUMN `invited_formal_count` INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT '累计介绍并已转正团长数（C2 双条件之一，由 ab_leader_invite 汇总）' AFTER `month_orders`,
  ADD COLUMN `last_order_at` DATETIME(3) DEFAULT NULL
    COMMENT '最近促成订单时间（C2 见习 30 天失效判定）' AFTER `agreed_at`,
  MODIFY COLUMN `commission_rate` DECIMAL(5,4) NOT NULL DEFAULT 0.0800
    COMMENT '当前费率，随 level 联动（8/9/10/12%）',
  ADD KEY `idx_team_leader_level_status` (`level`, `status`);
```

**依据**：C2（双条件升级 + 见习 30 天失效）· `leader-expire.task`（见《订单状态机》§3.1）

---

### P0-2 ⛔ `ab_order.status` 注释缺两个退款态

**问题**

```sql
COMMENT 'pending_pay/paid/cut_off/cooked/delivering/delivered/completed/cancelled/refunded',
```

只有 `refunded`，**缺 `refund_applying`（待审批）与 `refunding`（退款中）**。而 C6 三段式要求这两个中间态必须可查（后台待审批队列依赖它）。

**修正建议**

```sql
MODIFY COLUMN `status` VARCHAR(24) NOT NULL DEFAULT 'pending_pay'
  COMMENT 'pending_pay待支付/paid已支付/cut_off已截单/cooked已出餐/delivering配送中/delivered待取餐/completed已完成/cancelled已取消/refund_applying退款申请中/refunding退款中/refunded已退款（C6）',
  ADD KEY `idx_order_refund_status` (`status`, `meal_date`);
```

**依据**：C6 · 《订单状态机》§1.1（11 态）· 接口 D40（退款待审批队列）

---

### P0-3 ⛔ `ab_meal_assignment.distribute_supplier_id` 与 C4 冲突

**问题**

```sql
`distribute_supplier_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '该楼群的集散中心供应商',
```

C4 已裁决集散中心是**独立配置表** `ab_distribution_center`（表驱动、可增删、带分账参数）。这里却直接存 `supplier_id`，**绕过配置表**，导致：

- 无法读取该集散中心的费用参数（集散/场地费、打包费 · C9 修订后默认均为 ¥0）
- 集散中心增删后，历史分配无法追溯其配置版本
- 与《目录结构 v2.0》的 `distribution-center/` 模块割裂

**修正建议**

```sql
ALTER TABLE `ab_meal_assignment`
  CHANGE COLUMN `distribute_supplier_id` `distribution_center_id` BIGINT UNSIGNED DEFAULT NULL
    COMMENT '该楼群的集散中心（关联 ab_distribution_center · C4）',
  ADD KEY `idx_meal_assignment_dc` (`distribution_center_id`);
```

**依据**：C4 · M34-05 · 接口 D29–D32

---

### P0-4 ⛔ 缺 `ab_leader_invite` 表（C2 晋级审计无法落地）

**问题**：C2 双条件之一是「介绍 N 名转正团长」，但现有 23 张表**没有任何表记录"谁邀请了谁"**。`ab_user` 只有 `team_leader_id`（当前归属），无法表达：

- 邀请关系与时间（用于判定"介绍成功"）
- 被邀请人是否已转正（决定邀请人是否达标）
- 邀请渠道（小程序码 / 海报 / 链接）与埋点

**修正建议：新增表 ①**

```sql
CREATE TABLE `ab_leader_invite` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `inviter_leader_id` BIGINT UNSIGNED DEFAULT NULL
    COMMENT '邀请人团长 id；自荐申请为 NULL',
  `invitee_user_id`   BIGINT UNSIGNED NOT NULL COMMENT '被邀请用户 id',
  `invitee_leader_id` BIGINT UNSIGNED DEFAULT NULL
    COMMENT '被邀请人转任团长后的 id（转正后回填）',
  `invite_code`       VARCHAR(32)  DEFAULT NULL COMMENT '邀请码（团长 ID 派生）',
  `channel`           VARCHAR(16)  NOT NULL DEFAULT 'link'
    COMMENT 'link链接/qrcode小程序码/poster海报/self自荐',
  `bind_at`           DATETIME(3)  NOT NULL COMMENT '绑定时间（注册时）',
  `invitee_level`     VARCHAR(16)  DEFAULT NULL
    COMMENT '被邀请人当前等级快照（转正后刷新）',
  `is_formal`         TINYINT      NOT NULL DEFAULT 0
    COMMENT '被邀请人是否已达"正式及以上"（C2 计数口径）',
  `formal_at`         DATETIME(3)  DEFAULT NULL COMMENT '被邀请人转正时间',
  `remark`            VARCHAR(256) DEFAULT NULL,
  `created_at`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_invite_invitee` (`invitee_user_id`)
    COMMENT '一个用户只绑定一个邀请人',
  KEY `idx_invite_inviter` (`inviter_leader_id`, `is_formal`),
  KEY `idx_invite_formal_at` (`formal_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团长推荐关系（C2 晋级审计）';
```

**设计说明**

| 字段 | 为何需要 |
| --- | --- |
| `invitee_user_id` 唯一键 | 防止"一用户被多团长抢绑"；注册时确定归属 |
| `is_formal` 冗余位 | C2 计数需高频聚合（每次登录看进度），避免 JOIN `ab_team_leader` 判等级 |
| `channel` | 埋点分析"哪种分享方式转化高" |
| `inviter_leader_id` 可空 | 支持 **C3 自荐申请**（无邀请人） |

**依据**：C2（双条件）· 接口 L17/L18、D19 · 《目录结构 v2.0》`team-leader/invite.service.ts`

---

### P0-5 ⛔ `ab_refund` 无 DDL（C6 三段式的载体缺失）

**问题**：§1.3 声明 `ab_refund` 属"修改的表"，但 §四 修改表 DDL **只有 6 张**，没有 `ab_refund`。即 C6 的"申请 → 审批 → 实退"三段式**没有表结构支撑**。

**修正建议：新增表 ②**

```sql
CREATE TABLE `ab_refund` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `refund_no`      VARCHAR(32)  NOT NULL COMMENT '退款单号（唯一）',
  `order_id`       BIGINT UNSIGNED NOT NULL,
  `order_no`       VARCHAR(32)  NOT NULL,
  `user_id`        BIGINT UNSIGNED NOT NULL,
  `team_leader_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '发起代退的团长',
  `apply_source`   VARCHAR(16)  NOT NULL DEFAULT 'leader'
    COMMENT 'user自助/leader团长代退/admin强制（C6）',
  `amount`         DECIMAL(10,2) NOT NULL COMMENT '退款金额（原路退用户）',
  `reason_type`    VARCHAR(16)  DEFAULT NULL
    COMMENT 'quality品质/missing缺漏/late延误/wrong错单/other（对应接口 L7）',
  `reason`         VARCHAR(256) DEFAULT NULL,
  `status`         VARCHAR(16)  NOT NULL DEFAULT 'applying'
    COMMENT 'applying待审批/approved已批准/refunding退款中/refunded已退款/rejected已驳回（C6）',
  `auditor_id`     BIGINT UNSIGNED DEFAULT NULL COMMENT '审批人（后台账号）',
  `audit_at`       DATETIME(3)  DEFAULT NULL,
  `audit_remark`   VARCHAR(256) DEFAULT NULL COMMENT '驳回原因或审批备注',
  `wx_refund_no`   VARCHAR(64)  DEFAULT NULL COMMENT '微信退款单号',
  `refunded_at`    DATETIME(3)  DEFAULT NULL,
  `reversed`       TINYINT      NOT NULL DEFAULT 0
    COMMENT '反向结算是否已执行（C9 修订：回退协商供价 + 场地费 + 打包人工/配送费 + 佣金，毛利留存）',
  `reversed_at`    DATETIME(3)  DEFAULT NULL,
  `version`        INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_refund_no` (`refund_no`),
  UNIQUE KEY `uk_refund_order_active` (`order_id`, `status`)
    COMMENT '防重复申请：同单在 applying/approved/refunding 仅一条',
  KEY `idx_refund_status_time` (`status`, `created_at`),
  KEY `idx_refund_order` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退款单（C6 三段式：申请→审批→实退）';
```

> ⚠️ `uk_refund_order_active` 为业务唯一键，**须在应用层保证"仅活跃态唯一"**（MySQL 唯一索引无法带条件）；实现方式：普通索引 + 事务内 `SELECT ... FOR UPDATE` 校验，或使用 `status` 生成列。
> 说明：`reversed` 字段标记反向分账是否执行，避免重复冲销（幂等）。

---

### P0-6 ⛔ `ab_commission` / `ab_supplier_share` 无 DDL（C2/C9 落点缺失）

**问题**：这两张表被列在 §五"未修改"，但 **§五 只给了 9 个表名，没有任何字段**。而：

- `ab_commission` 是 **C2 四级佣金（8/9/10/12%）**的流水载体
- `ab_supplier_share` 是 **C9 供应商 / 集散中心应付结算（按协商供价 + 场地费 + 打包人工 + 配送费）**与**反向冲减**的载体

不定义为空谈。

**修正建议：新增表 ③**

```sql
CREATE TABLE `ab_commission` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`       BIGINT UNSIGNED NOT NULL,
  `order_no`       VARCHAR(32)  NOT NULL,
  `team_leader_id` BIGINT UNSIGNED NOT NULL,
  `leader_level`   VARCHAR(16)  NOT NULL COMMENT '结算时的等级快照（C2）',
  `rate`           DECIMAL(5,4) NOT NULL COMMENT '结算时费率快照（0.08/0.09/0.10/0.12）',
  `base_amount`    DECIMAL(10,2) NOT NULL COMMENT '计佣基数（订单金额）',
  `quantity`       INT UNSIGNED NOT NULL COMMENT '计入份数（实发）',
  `amount`         DECIMAL(10,2) NOT NULL COMMENT '佣金金额（正=入账，负=冲销）',
  `type`           VARCHAR(16)  NOT NULL DEFAULT 'normal'
    COMMENT 'normal正常/reversal退款冲销（C9 反向结算）',
  `status`         VARCHAR(16)  NOT NULL DEFAULT 'pending'
    COMMENT 'pending待结算/settled已打款/cancelled已冲销',
  `settled_at`     DATETIME(3)  DEFAULT NULL,
  `meal_date`      DATE         NOT NULL,
  `created_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_commission_order_type` (`order_id`, `type`)
    COMMENT '同单同类型仅一条，防重复计佣',
  KEY `idx_commission_leader_date` (`team_leader_id`, `meal_date`),
  KEY `idx_commission_status` (`status`, `meal_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团长佣金流水（C2 四级 / C9 反向冲销）';

CREATE TABLE `ab_supplier_share` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `share_no`      VARCHAR(32)  NOT NULL COMMENT '应付结算单号',
  `share_date`    DATE         NOT NULL COMMENT '应付生成日（T+1）',
  `meal_date`     DATE         NOT NULL COMMENT '对应出餐日',
  `payee_type`    VARCHAR(16)  NOT NULL
    COMMENT 'supplier供应商/distribution_center集散中心（C9）',
  `payee_id`      BIGINT UNSIGNED NOT NULL COMMENT '供应商或集散中心 id',
  `dish_id`       BIGINT UNSIGNED DEFAULT NULL COMMENT '菜品（供应商应付按菜品计）',
  `quantity`      INT UNSIGNED NOT NULL COMMENT '份数',
  `unit_price`    DECIMAL(8,2) NOT NULL COMMENT '单位应付金额（协商供价 / 场地费 / 打包人工 / 配送费 · C9 修订）',
  `amount`        DECIMAL(12,2) NOT NULL COMMENT '应付金额（正=应付，负=反向冲销）',
  `type`          VARCHAR(16)  NOT NULL DEFAULT 'normal'
    COMMENT 'normal正常/reversal反向冲销（C9 退款回退）',
  `channel`       VARCHAR(16)  NOT NULL DEFAULT 'manual'
    COMMENT 'manual人工对公转账（当前唯一渠道）/ wxpay微信分账（二期预留）',
  `payment_voucher_no` VARCHAR(64) DEFAULT NULL COMMENT '付款凭证号（银行回单号）',
  `invoice_no`    VARCHAR(64)  DEFAULT NULL COMMENT '供应商发票号（税前扣除凭证）',
  `status`        VARCHAR(16)  NOT NULL DEFAULT 'pending'
    COMMENT 'pending待付款/success已付款/failed异常/reversed已冲减',
  `fail_reason`   VARCHAR(256) DEFAULT NULL,
  `settled_at`    DATETIME(3)  DEFAULT NULL COMMENT '结算日',
  `paid_at`       DATETIME(3)  DEFAULT NULL COMMENT '实际付款日（人工转账完成）',
  `origin_id`     BIGINT UNSIGNED DEFAULT NULL COMMENT '反向冲销时指向原分账记录',
  `created_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_share_no` (`share_no`),
  KEY `idx_share_payee` (`payee_type`, `payee_id`, `meal_date`),
  KEY `idx_share_status` (`status`, `share_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商/集散中心应付结算流水（C9 修订：协商供价 + 场地费 + 打包人工 + 配送费；含反向冲减）';
```

**结算方式（2026-09-14 定案）**：`ab_supplier_share` 只记录**应付**，实际付款由财务**人工对公转账**完成（平台对公账户 → 供应商对公账户）；因此 `channel` 当前恒为 `manual`，状态为 `待付款 / 已付款 / 已冲减`，`wxpay` 为二期预留。表名沿用 `share` 系历史命名，语义已收窄为「应付结算流水」。

**依据**：C2（四级佣金快照）· C9（结算口径 + 反向冲减）· 《订单状态机》§5.3/§5.4

---

## 三、P1 · 建议修正项

### P1-1 `ab_user.team_leader_id` 注释与默认值矛盾

注释写「必填，注册时绑定」，但定义为 `DEFAULT NULL`。

**建议**：保留 `DEFAULT NULL`（**团长团长自己注册时无上级**，且邀请关系可能后置绑定），但**修正注释**为：

```sql
COMMENT '所属（推荐）团长 id；通过邀请链接进入时注册即绑定，自然流量可后置绑定'
```

并把"邀请关系"的**权威来源**从 `ab_user.team_leader_id` 迁移到 `ab_leader_invite`（P0-4）——`ab_user` 该字段降级为**冗余快照**，便于查询。

### P1-2 金额单位跨层不一致（DB 用元，接口用分）

| 层 | 约定 |
| --- | --- |
| DB（ER v2.1） | `DECIMAL(12,2)` —— **元**，两位小数 |
| API（接口规范 v1.0） | **整数分**（`priceFen: 2580`） |

**这不是错误，但必须显式约定转换规则**，否则必然出现 100 倍误差事故。

**建议**：在 `packages/shared-utils` 提供统一工具，**禁止在业务代码里手写 `×100` / `÷100`**：

```ts
export const yuanToFen = (y: string | number): number =>
  Math.round(Number(y) * 100);
export const fenToYuan = (f: number): string =>
  (f / 100).toFixed(2);
```

并在 **DTO 层**做统一转换（Service 内部一律用分运算，落库前转回元）。**约定：转换只允许出现在 DTO ↔ Entity 边界**。

### P1-3 `ab_supplier.share_rate` 定位已模糊

C9 之后，供应商应付由**与各供应商逐菜协商的供价**（`ab_dish.cost_price` / `ab_supplier_dish_daily.unit_price`，C9 修订）决定，**不再按比例**。`share_rate` 字段保留会误导实现。

**建议**（二选一）

- **A（推荐）**：保留字段但明确注释「**废弃（C9 后应付按协商供价）；仅为兼容历史数据，新逻辑不得读取**」
- **B**：直接从表中移除（若 v1.0 上线前无历史数据）

### P1-4 `ab_set_meal.status` 与 `ab_meal_assignment.status` 语义重叠

`ab_set_meal.status` 注释为 `1模板 2已分配 3已截单 4已完成 5已取消`，但**"截单/完成"是"分配"的生命周期**，不是"模板"的。

**建议**：`ab_set_meal` 只保留 `1启用 0停用`（作为模板库开关），**流转状态全部由 `ab_meal_assignment` 承担**，避免两处状态打架。

### P1-5 `ab_order` 分区表的主键/唯一键约束

```sql
PRIMARY KEY (`id`, `created_at`),
UNIQUE KEY `uk_order_no` (`order_no`, `created_at`),
```

因 MySQL 分区表要求分区键必须包含在每个唯一索引中，这是**合规写法**。但含义是 **`order_no` 不全局唯一**（仅在 `created_at` 相同时才唯一）。

**建议**：
1. **`order_no` 全局唯一性由应用层保证**（生成器含日期 + 分片 + 序列，见 `common/utils/order-no.ts`），并在接口返回时不做"唯一性承诺"给前端。
2. 若需强约束，考虑改为 **`order_no` 含日期 + 按 `meal_date` 分区**（业务上更自然，查询也更常按 `meal_date`）。

> ⚠️ **MVP 阶段（≈500 单/天）建议先不分区**：分区带来的运维复杂度（跨分区查询、分区维护）在试运营期收益极低，可等单量破万再引入。

### P1-6 `ab_meal_assignment` 缺"生效集散中心"与"菜品种类"的冗余

后台套餐矩阵（D1）需要按"日 × 楼群"快速展示「4 道菜 + 集散中心」，目前需 JOIN `ab_set_meal_item` + `ab_distribution_center`。

**建议**：MVP 可不优化；若矩阵页 P99 超过 300ms，再加 `dish_count` / `dc_name` 冗余列（以触发器或 service 维护）。

---

## 四、P2 · 可选优化项

| # | 建议 | 说明 |
| --- | --- | --- |
| P2-1 | `ab_operation_log` 增加 `snapshot` JSON 列 | 记录变更前后值，便于审计回放（P31 订单详情"操作日志"需要） |
| P2-2 | `ab_dish` 增 `allergens` JSON | 支撑 M02-02「过敏备注」的智能提示，二期 |
| P2-3 | `ab_distribution_center.service_groups` 由 JSON 改关联表 | 当前 JSON 无法建索引；楼群数量增长后查询变慢，二期再拆 |
| P2-4 | 全表统一 `version` 乐观锁 | 现有表已有 `version`，建议确认所有更新路径都带上（尤其 `ab_balance`、`ab_order`） |
| P2-5 | `ab_commission` / 提现流水补 `payout_channel`、`batch_no`、`tax_withheld_amount` | **C11 定案改走灵活用工平台代发**：需记录打款通道、批次号与**代扣税额**，才能与灵活用工平台对账并核算税后到手金额 |
| P2-6 | `ab_supplier` 银行信息字段允许为空 | C11：**对公账户信息后置收集**，不阻塞开发；付款登记需支持「收款方式」备注（对公 / 对私 / 现金） |

---

## 五、评审后表清单（24 张）

| 域 | 表 | 状态 |
| --- | --- | --- |
| 用户与角色（4） | `ab_user`、`ab_team_leader`、`ab_building`、**`ab_leader_invite`** ⭐新增 | 3 改 + 1 增 |
| 楼群（1） | `ab_building_group` | 沿用 |
| 商家（2） | `ab_supplier`、`ab_dish` | 1 改 |
| 套餐（3） | `ab_set_meal`、`ab_set_meal_item`、`ab_meal_assignment` | 3 改 |
| 供应商生产（1） | `ab_supplier_dish_daily` | 沿用 |
| 订单与支付（4） | `ab_order`、`ab_payment_log`、**`ab_refund`** ⭐补 DDL、`ab_delivery_record` | 2 改 + 1 补 |
| 财务（4） | `ab_commission`、`ab_supplier_share`、`ab_balance`、`ab_balance_log` | 2 补 DDL |
| 集散中心（1） | `ab_distribution_center` | 沿用 |
| 系统（4） | `ab_admin_user`、`ab_operation_log`、`ab_config`、`ab_message` | 沿用 |
| **合计** | **24 张** | — |

> 与 ER v2.1 §九 的预告一致（"阶段二将补 `ab_leader_invite`，届时合计 24 张表"）。除该表外，**`ab_refund` / `ab_commission` / `ab_supplier_share` 三张需补全 DDL**（本次已给出）。

---

## 六、索引补充建议

| 表 | 补充索引 | 用途 |
| --- | --- | --- |
| `ab_team_leader` | `idx_team_leader_level_status (level, status)` | 后台按等级筛团长（P32/D19） |
| `ab_team_leader` | `idx_team_leader_last_order (last_order_at)` | `leader-expire.task` 扫描 |
| `ab_leader_invite` | `idx_invite_inviter (inviter_leader_id, is_formal)` | C2 进度查询（高频） |
| `ab_commission` | `idx_commission_leader_date (team_leader_id, meal_date)` | 佣金中心按日/月（P16） |
| `ab_supplier_share` | `idx_share_payee (payee_type, payee_id, meal_date)` | 供应商应付结算明细（P25） |
| `ab_refund` | `idx_refund_status_time (status, created_at)` | 后台待审批队列（D40） |
| `ab_order` | `idx_order_refund_status (status, meal_date)` | 退款态筛选 |

---

## 七、评审签署

| 角色 | 结论 | 日期 |
| --- | --- | --- |
| 产品/架构（AI 辅助评审） | 建议修订后通过（P0 必修） | 2026-09-14 |
| 后端负责人 | 待会签 | — |
| 前端负责人 | 已知悉跨层金额口径（P1-2） | — |

---

*文档结束 · ABox 一盒 · 表结构评审意见 v1.0 · 2026-09-14*
