import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 补 `ab_commission` 的**日期打头**索引 —— `idx_commission_meal (meal_date)`
 *
 * ## 为什么这支迁移存在（全面检查报告 §二 P1-3）
 * 报告原句：「`ab_commission` 缺 `mealDate` 索引，佣金月查询与结算按 `meal_date`
 * 过滤走全表」。**方向对，但表述需要更正**：迁移里其实**有**含 `meal_date` 的索引
 * （`idx_commission_leader_date (team_leader_id, meal_date)`、
 * `idx_commission_status (status, meal_date)`）——
 * 审阅者是**读实体装饰器**得出的结论，而那两份表述当时并不一致（见下）。
 *
 * 真正的缺口是：**没有任何索引以 `meal_date` 打头**。
 * ⚠️ 复合索引的第二列接不住「第一列缺席」的谓词 —— 于是下列三处**只能全表扫**，
 * 而 `ab_commission` 是**永续增长**表（每单一行 × 佣金类型），全表扫的成本逐月上升：
 *   · `commission.service.ts#listCommissionsForAdmin` —— 运营后台「某日佣金列表」
 *     （`meal_date = ?`，`status` 可不给 → `idx_commission_status` 用不上）
 *   · `finance.service.ts#loadCommissionRows` —— 后台财务逐日分桶（`BETWEEN`）
 *   · `stats.service.ts#loadCommissionFen`     —— 首屏看板佣金净额（`BETWEEN`）
 * 已覆盖、**不需要**新索引的：`settlePending`（`status='pending' AND meal_date = ?`
 * 恰好是 `idx_commission_status` 的前缀）与 `monthOrdersOf`
 * （`team_leader_id = ? AND meal_date BETWEEN`，恰为 `idx_commission_leader_date` 前缀）。
 *
 * ## 为什么是 `(meal_date)` 单列而不是 `(meal_date, status)`
 * 上列三处里两处是第一列上的**范围**谓词 —— MySQL 对范围之后的部分不做索引下推定位，
 * 第二列只能当覆盖列，收益有限却让索引变宽。而按日等值那处，单日行数本来就不大。
 * 单列是与「一条索引对应一个**打头谓词**」这一原则一致的**最小**形状。
 *
 * ## 为什么是「增量迁移」而不是就地改 init
 * 同 `1700000000001-parity-fix.ts` 的理由：若某个环境已把 `Init1700000000000` /
 * `ParityFix1700000000001` 记为**已执行**，TypeORM 会**静默跳过**改动后的它们。
 * 新增一支文件，换来的是**不再依赖「没人跑过」这个前提**。
 *
 * ## 幂等与可重入
 * MySQL 8 **不支持** `CREATE INDEX IF NOT EXISTS`，故**先查 `information_schema.STATISTICS`
 * 再建**（`TABLE_SCHEMA = DATABASE()`：只查当前库，不串库）。重跑不报错、不重复建。
 *
 * ## 与实体的关系
 * `finance.entity.ts` 的 `Commission` 类已**同步**声明同名同类级索引。
 * 两侧必须逐名逐列一致 —— 这是 `index:parity` 门禁的判据；
 * 也是本批发现的**25 处「实体单列 / 迁移复合」漂移**的防复发手段。
 */
const NEW_INDEXES: { table: string; index: string; ddl: string }[] = [
  {
    table: 'ab_commission',
    index: 'idx_commission_meal',
    ddl: 'ALTER TABLE `ab_commission` ADD INDEX `idx_commission_meal` (`meal_date`)',
  },
];

/** 索引是否存在（`information_schema`，MySQL 8 无 `CREATE INDEX IF NOT EXISTS` 的替身） */
async function indexExists(qr: QueryRunner, table: string, index: string): Promise<boolean> {
  const rows: unknown[] = await qr.query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [table, index],
  );
  return rows.length > 0;
}

export class IndexCommissionMeal1700000000002 implements MigrationInterface {
  name = 'IndexCommissionMeal1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    let added = 0;
    for (const item of NEW_INDEXES) {
      if (await indexExists(queryRunner, item.table, item.index)) continue;
      await queryRunner.query(item.ddl);
      added += 1;
    }
    console.log(`   ↳ IndexCommissionMeal：补索引 ${added}（已存在而跳过的不计入；重跑幂等）`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const item of [...NEW_INDEXES].reverse()) {
      if (!(await indexExists(queryRunner, item.table, item.index))) continue;
      await queryRunner.query(`ALTER TABLE \`${item.table}\` DROP INDEX \`${item.index}\``);
    }
  }
}
