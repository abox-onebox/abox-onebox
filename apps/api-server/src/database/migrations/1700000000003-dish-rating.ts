import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1-U2 口味评价：新建第 28 张表 `ab_dish_rating`（只增表）
 *
 * ## 这支迁移为什么存在
 * U2「口味评价与菜品迭代闭环」需要**按菜品聚合**（红黑榜 / 本月投诉计数），
 * 该事实此前在任何表里都没有 —— `ab_dish.rating` 是菜品库的静态展示列（无写点、
 * 无逐餐明细），撑不住「哪个菜、哪顿饭、被谁评了几分」。
 *
 * ## 表设计要点（与实体 `DishRating` 逐列一致 —— schema:parity / index:parity 判据）
 * - 一单一菜一行：`uk_dish_rating_order_dish (order_id, dish_id)` 唯一键
 *   —— 「一次提交即定稿、不可改」由「无 UPDATE 路径 + 唯一键」共同保证；
 * - `dish_name` / `supplier_name` 是**落库时快照**：菜品/供应商事后改名、下架、软删，
 *   红黑榜历史行保持「当时吃到的那个名字」（聚合不回查主数据）；
 * - `meal_date` = 出餐日（红黑榜按「吃到的日子」切区间）；
 * - `rating` TINYINT：1 好吃 / 2 一般 / 3 不好（「不好」= 投诉，红线分子）；
 * - 只增表（同 `ab_message`）：无 `version`、无 `updated_at` —— 写上反而暗示「会改」。
 *
 * ## 幂等与可重入
 * `CREATE TABLE IF NOT EXISTS`（MySQL 8 天然幂等）；`down()` 对称 `DROP TABLE IF EXISTS`。
 *
 * ## 与实体的关系
 * `order.entity.ts` 的 `DishRating` 已同步声明同名同类级索引（名称 + 列序 + 唯一性
 * 逐项一致 —— `index:parity` 判据）。本地 sqlite 由实体 synchronize 建表、
 * 生产由本迁移建表，两侧不齐会在两道 parity 门禁上转红。
 */
const NEW_TABLE = `CREATE TABLE IF NOT EXISTS \`ab_dish_rating\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`order_id\` BIGINT UNSIGNED NOT NULL COMMENT '订单（ab_order.id）',
    \`order_no\` VARCHAR(32) NOT NULL COMMENT '业务订单号（冗余，便于直查）',
    \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '评价人（ab_user.id）',
    \`meal_date\` DATE NOT NULL COMMENT '出餐日（红黑榜按吃到的日子切区间）',
    \`dish_id\` BIGINT UNSIGNED NOT NULL COMMENT '菜品（ab_dish.id；按 id 定位，name 无唯一约束）',
    \`dish_name\` VARCHAR(64) NOT NULL COMMENT '菜品名快照（落库时，改名不改史）',
    \`supplier_id\` BIGINT UNSIGNED NOT NULL COMMENT '供应商（ab_supplier.id）',
    \`supplier_name\` VARCHAR(64) NOT NULL COMMENT '供应商名快照（落库时）',
    \`slot\` TINYINT NOT NULL COMMENT '档位快照：1主荤 2半荤 3素菜 4汤 5主食',
    \`rating\` TINYINT NOT NULL COMMENT '1好吃 2一般 3不好（不好=投诉，红线分子）',
    \`reason\` VARCHAR(128) DEFAULT NULL COMMENT '可选原因（自由文本）',
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uk_dish_rating_order_dish\` (\`order_id\`,\`dish_id\`),
    KEY \`idx_dish_rating_dish_date\` (\`dish_id\`,\`meal_date\`),
    KEY \`idx_dish_rating_user\` (\`user_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='口味评价（P1-U2 · 逐菜三键 · 只增 · 一次提交定稿）'`;

export class DishRating1700000000003 implements MigrationInterface {
  name = 'DishRating1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(NEW_TABLE);
    console.log('   ↳ DishRating：建表 ab_dish_rating（IF NOT EXISTS，重跑幂等）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `ab_dish_rating`');
  }
}
