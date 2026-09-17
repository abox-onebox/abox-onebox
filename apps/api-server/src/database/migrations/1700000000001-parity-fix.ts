import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 补齐结构缺口 —— 把 M3-4 / M3-6 / M3-7 / M3-8 / M3-12 五批的 DDL 真正补进迁移
 *
 * ## 为什么会有这支迁移（《缺陷与陷阱》#76 · M5-2）
 * 全仓此前**只有一支**迁移 `1700000000000-init.ts`（25 张表），而实体有 **27 张表**。
 * 之所以长期没人发现：`data-source.ts` 里 `synchronize: driver === 'sqlite'` ——
 * **本地全部验证（seed / e2e×3）都跑 sqlite，由实体同步建表，迁移一次都不执行**。
 * 于是「实体改了、迁移忘了改」不在任何失败路径上：e2e 全绿，生产首迁却建出一个残缺库。
 * 而 M5-0 刚把 migrations glob 从 `*.ts` 修成 `*.{ts,js}`（见 #72）——「静默零迁移」
 * 于是升级为「**跑出一个残缺库**」，必须在首次真机部署前补掉。
 *
 * 实测缺口（`schema-parity` 机械对账，非人读）：**整表 2 张 + 列 9 个**。
 *
 * ## 为什么是「增量迁移」而不是「就地改 init」
 * init 从未在任何环境执行过，就地改它最干净 —— 但**若将来某个环境已把
 * `Init1700000000000` 记为已执行**，TypeORM 会**静默跳过**改动后的它，缺口依然存在。
 * 增量迁移对「已执行过 init 的环境」是**正确的**（会真的补上）。代价是多一支文件，
 * 换来的是**不再依赖「没人跑过」这个前提**。
 *
 * ## DDL 来源
 * **逐字取自《数据库 ER 设计 v2.1》**（§3.6.1 `ab_supplier_dish_center_daily` ·
 * §3.9 `ab_message_template` · §5.3 `ab_refund.order_status_before` ·
 * §5.5 `ab_supplier` 补 7 列 · §5.6 `ab_building` 增 `population` + 状态三态 + 索引），
 * 以保证「迁移 / 实体 / ER」三份表述重新对齐。两处刻意的偏差：
 *   ① 引用 id 的列统一写 `BIGINT UNSIGNED`（ER 里 `audited_by` 只写了 `bigint`）——
 *      与 `ab_supplier_dish_daily.supplier_id` 等既有引用列保持一致，且 id 域本无负数；
 *   ② ER §5.3 把 `order_status_before` 记作 `tinyint`，**是文档错误**：代码写入的是
 *      `order.status`（状态**字符串**，`refund.service.ts`），`refund-admin.service.ts`
 *      还会对它跑 `adminStatusText()`。故按 **`VARCHAR(16)`** 建列，并在 M5-2 同步更正 ER。
 *
 * ## 幂等与可重入
 * MySQL 8 **不支持** `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，
 * 故列与索引**逐项查 `information_schema` 后再加**；两张表用 `CREATE TABLE IF NOT EXISTS`。
 * 于是本迁移**可重复执行**（重跑不报错、不重复加），也不需要「只在空库上跑」这个前提。
 *
 * ## down()
 * 对称回退：删 9 列 / 删索引 / 删 2 表，并把 `ab_building.status` 的注释改回 init 里的原文案。
 */
const MISSING_TABLES: string[] = [
  // 《ER v2.1》§3.6.1 —— M3-8 S2 出餐确认明细（粒度：供应商 × 菜品 × 集散中心 × 出餐日）
  `CREATE TABLE IF NOT EXISTS \`ab_supplier_dish_center_daily\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`supplier_id\` BIGINT UNSIGNED NOT NULL,
    \`dish_id\` BIGINT UNSIGNED NOT NULL,
    \`produce_date\` DATE NOT NULL COMMENT '出餐日（= 套餐日 T，非确认操作日）',
    \`distribution_center_id\` BIGINT UNSIGNED NOT NULL COMMENT '送达目标集散中心',
    \`plan_quantity\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '应送份数（分中心）',
    \`actual_quantity\` INT UNSIGNED DEFAULT NULL COMMENT '实送份数；短送/多送都要留痕（对账依据）',
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending / confirmed',
    \`confirmed_at\` DATETIME(3) DEFAULT NULL,
    \`confirmed_by\` BIGINT UNSIGNED DEFAULT NULL COMMENT '确认操作账号（ab_admin_user.id）',
    \`remark\` VARCHAR(255) DEFAULT NULL COMMENT '备注（如短送原因）',
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uk_sddc\` (\`supplier_id\`,\`dish_id\`,\`produce_date\`,\`distribution_center_id\`),
    KEY \`idx_sddc_supplier\` (\`supplier_id\`),
    KEY \`idx_sddc_date_center\` (\`produce_date\`,\`distribution_center_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出餐确认明细（按集散中心逐项）'`,

  // 《ER v2.1》§3.9 —— M3-12 通知模板（D59/D60 的载体；场景定义留在代码里，本表只存可编辑部分）
  `CREATE TABLE IF NOT EXISTS \`ab_message_template\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`scene\` VARCHAR(64) NOT NULL COMMENT '场景键（取值来自 MESSAGE_TEMPLATE_SPECS，D60 不可改）',
    \`enabled\` TINYINT NOT NULL DEFAULT 0 COMMENT '总开关 1启用 0关闭 —— 真生效',
    \`wechat_template_id\` VARCHAR(64) DEFAULT NULL COMMENT '微信订阅消息模板 ID（微信公众平台创建）',
    \`group_content\` TEXT DEFAULT NULL COMMENT '微信群人工通知文案，变量须在该场景白名单内 —— 存档用途',
    \`updated_by\` BIGINT UNSIGNED DEFAULT NULL COMMENT '最近修改人（ab_admin_user.id）',
    \`version\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uk_msg_tpl_scene\` (\`scene\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知模板（5 场景 · 只存可编辑部分，场景定义留在代码里）'`,
];

/** 缺列：一项一条 `ALTER TABLE`（便于逐列查存在性，parser 也只认「一条 ALTER 一列」） */
const MISSING_COLUMNS: { table: string; column: string; ddl: string }[] = [
  {
    table: 'ab_building',
    column: 'population',
    ddl: `ALTER TABLE \`ab_building\` ADD COLUMN \`population\` INT DEFAULT NULL COMMENT '覆盖人数（运营估算，非实时统计）'`,
  },
  {
    table: 'ab_supplier',
    column: 'audit_status',
    ddl: `ALTER TABLE \`ab_supplier\` ADD COLUMN \`audit_status\` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending待审 / approved通过 / rejected驳回（D26 落点）'`,
  },
  {
    table: 'ab_supplier',
    column: 'audit_remark',
    ddl: `ALTER TABLE \`ab_supplier\` ADD COLUMN \`audit_remark\` VARCHAR(256) DEFAULT NULL COMMENT '审核意见（驳回必填，便于运营答复商家）'`,
  },
  {
    table: 'ab_supplier',
    column: 'audited_at',
    ddl: `ALTER TABLE \`ab_supplier\` ADD COLUMN \`audited_at\` DATETIME(3) DEFAULT NULL COMMENT '审核时间'`,
  },
  {
    table: 'ab_supplier',
    column: 'audited_by',
    ddl: `ALTER TABLE \`ab_supplier\` ADD COLUMN \`audited_by\` BIGINT UNSIGNED DEFAULT NULL COMMENT '审核人 ab_admin_user.id'`,
  },
  {
    table: 'ab_supplier',
    column: 'license_expire_at',
    ddl: `ALTER TABLE \`ab_supplier\` ADD COLUMN \`license_expire_at\` DATE DEFAULT NULL COMMENT '食品经营许可证有效期（123 号令核验项）'`,
  },
  {
    table: 'ab_supplier',
    column: 'invoice_title',
    ddl: `ALTER TABLE \`ab_supplier\` ADD COLUMN \`invoice_title\` VARCHAR(128) DEFAULT NULL COMMENT '发票抬头（C10 人工对公转账用，与展示名可能不同）'`,
  },
  {
    table: 'ab_supplier',
    column: 'takeout_links',
    ddl: `ALTER TABLE \`ab_supplier\` ADD COLUMN \`takeout_links\` JSON DEFAULT NULL COMMENT '外卖平台店铺链接（仅用户端溯源跳转，不参与结算）'`,
  },
  {
    table: 'ab_refund',
    column: 'order_status_before',
    ddl: `ALTER TABLE \`ab_refund\` ADD COLUMN \`order_status_before\` VARCHAR(16) DEFAULT NULL COMMENT '申请退款前的订单状态（C6 驳回时回退的目标状态）'`,
  },
];

/** 缺索引：《ER v2.1》§5.6 —— D13 列表按状态筛选 / P37 总览统计各状态楼栋数是高频路径 */
const MISSING_INDEXES: { table: string; index: string; ddl: string }[] = [
  {
    table: 'ab_building',
    index: 'idx_building_status',
    ddl: `ALTER TABLE \`ab_building\` ADD INDEX \`idx_building_status\` (\`status\`)`,
  },
];

/**
 * 注释对齐（M3-7 起 `ab_building.status` 是**三态**：1 营业中 / 2 待开通 / 3 已暂停）。
 *
 * ⚠️ 只改注释、**不改类型、不迁数据**：这是 `tinyint` 的**值域扩展**，`1` 的语义不变，
 * 旧值 `2` 归「待开通」（保守处理：合作状态未确认的按未开通算）。
 * 但 init 里的注释仍写「1合作中 2停用」—— 运营直接读库时会误判状态含义，故对齐。
 */
const STATUS_COMMENT_ALIGN = `ALTER TABLE \`ab_building\` MODIFY COLUMN \`status\` TINYINT NOT NULL DEFAULT 1 COMMENT '1营业中 2待开通 3已暂停'`;
const STATUS_COMMENT_ORIGINAL = `ALTER TABLE \`ab_building\` MODIFY COLUMN \`status\` TINYINT NOT NULL DEFAULT 1 COMMENT '1合作中 2停用'`;

/** 列是否存在（`information_schema` + `DATABASE()`：只查当前库，不串库） */
async function columnExists(qr: QueryRunner, table: string, column: string): Promise<boolean> {
  const rows: unknown[] = await qr.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [table, column],
  );
  return rows.length > 0;
}

/** 索引是否存在 */
async function indexExists(qr: QueryRunner, table: string, index: string): Promise<boolean> {
  const rows: unknown[] = await qr.query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [table, index],
  );
  return rows.length > 0;
}

export class ParityFix1700000000001 implements MigrationInterface {
  name = 'ParityFix1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    let tables = 0;
    let columns = 0;
    let indexes = 0;

    for (const sql of MISSING_TABLES) {
      // CREATE TABLE IF NOT EXISTS 天然幂等
      await queryRunner.query(sql);
      tables += 1;
    }

    for (const item of MISSING_COLUMNS) {
      if (await columnExists(queryRunner, item.table, item.column)) continue;
      await queryRunner.query(item.ddl);
      columns += 1;
    }

    for (const item of MISSING_INDEXES) {
      if (await indexExists(queryRunner, item.table, item.index)) continue;
      await queryRunner.query(item.ddl);
      indexes += 1;
    }

    // 注释对齐：MODIFY 本身幂等（重复设为同一注释无副作用），不需要守卫
    await queryRunner.query(STATUS_COMMENT_ALIGN);

    console.log(
      `   ↳ ParityFix：补表 ${tables} / 补列 ${columns} / 补索引 ${indexes}` +
        `（已存在而跳过的项不计入；重跑本迁移为幂等）`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const item of MISSING_INDEXES) {
      if (!(await indexExists(queryRunner, item.table, item.index))) continue;
      await queryRunner.query(`ALTER TABLE \`${item.table}\` DROP INDEX \`${item.index}\``);
    }
    // 反序删列（与 up 对称），逐列判存在
    for (const item of [...MISSING_COLUMNS].reverse()) {
      if (!(await columnExists(queryRunner, item.table, item.column))) continue;
      await queryRunner.query(`ALTER TABLE \`${item.table}\` DROP COLUMN \`${item.column}\``);
    }
    // 注释改回 init 原文案，保持「回退后与 init 执行完的状态一致」
    await queryRunner.query(STATUS_COMMENT_ORIGINAL);
    for (const sql of [...MISSING_TABLES].reverse()) {
      const table = /CREATE TABLE IF NOT EXISTS `([A-Za-z0-9_]+)`/.exec(sql)?.[1];
      if (table) await queryRunner.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
  }
}
