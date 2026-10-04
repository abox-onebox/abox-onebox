import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 取消理由与取消来源：`ab_order` 增三列（2026-10-04）
 *
 * ## 这支迁移为什么存在
 * 系统里三条取消路径（用户自助 / 截单清未支付 / 团长代退）过去都只把订单置为
 * `cancelled`，**订单表上没有任何字段能区分是谁取消的**。于是「用户主动放弃」
 * 的流失信号被「忘付款被系统清掉」稀释 —— 后者量通常还更大，两者混算会得出
 * 与事实相反的结论。`cancel_source` 是这次的核心，理由只是它的补充。
 *
 * ## 三列的分工
 * - `cancel_source`  取消来源：user / system / leader —— **统计必须先按它分层**
 * - `cancel_reason`  取消理由（用户侧为预置选项枚举；系统侧固定 `timeout_unpaid`；
 *                    团长侧沿用其既有的 `RefundReasonType`，不强行合并 —— 详见
 *                    `shared-types/dto/cancel-reason.dto.ts` 头注）
 * - `cancel_note`    补充说明（仅在理由选「其他」时落库）
 *
 * ## 为什么全是 nullable
 * 理由**可跳过**（用户 2026-10-04 裁定），所以三列都可空；
 * 历史行（本迁移之前取消的订单）一律为 NULL —— 这是**已知且可接受**的：
 * 它们属于「未采集」而非「用户不愿说」，分析时按「来源未知」单列，不要混进占比。
 *
 * ## 为什么不加索引
 * `cancel_source` 只有 3 个取值，基数极低，单列索引几乎无用；
 * 常见查询是「某时间段的取消分布」，已由 `meal_date` 上的既有索引收敛。
 * 数据量到了需要单独优化时再按慢查询加 —— 现在加属于过度设计。
 *
 * ## 幂等与可重入
 * ⚠️ MySQL 的 `ALTER TABLE ADD COLUMN` **不支持 IF NOT EXISTS**（与 `CREATE TABLE`
 *    不同），直接跑第二遍会报 duplicate column。故先查 `information_schema` 判存，
 *    缺哪列补哪列 —— 服务器部署用 `git archive` 覆盖后重跑迁移是常态，必须可重入。
 */
const ADD_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  [
    'cancel_reason',
    "ALTER TABLE `ab_order` ADD COLUMN `cancel_reason` VARCHAR(32) DEFAULT NULL COMMENT '取消理由（用户侧预置选项 / 系统 timeout_unpaid）' AFTER `cancelled_at`",
  ],
  [
    'cancel_note',
    "ALTER TABLE `ab_order` ADD COLUMN `cancel_note` VARCHAR(128) DEFAULT NULL COMMENT '取消理由补充说明（仅理由=其他时落库）' AFTER `cancel_reason`",
  ],
  [
    'cancel_source',
    "ALTER TABLE `ab_order` ADD COLUMN `cancel_source` VARCHAR(16) DEFAULT NULL COMMENT '取消来源：user 用户自助 / system 系统截单 / leader 团长代退' AFTER `cancel_note`",
  ],
];

export class CancelReason1700000000004 implements MigrationInterface {
  name = 'CancelReason1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ COLUMN_NAME: string }> = await queryRunner.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      ['ab_order'],
    );
    const existing = new Set(rows.map((r) => r.COLUMN_NAME));

    let added = 0;
    for (const [col, sql] of ADD_COLUMNS) {
      if (existing.has(col)) continue;
      await queryRunner.query(sql);
      added++;
    }
    console.log(
      `   ↳ CancelReason：ab_order 三列检查完毕，本次新增 ${added} 列（已存在的跳过，重跑幂等）`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ COLUMN_NAME: string }> = await queryRunner.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      ['ab_order'],
    );
    const existing = new Set(rows.map((r) => r.COLUMN_NAME));

    for (const [col] of ADD_COLUMNS) {
      if (!existing.has(col)) continue;
      await queryRunner.query(`ALTER TABLE \`ab_order\` DROP COLUMN \`${col}\``);
    }
  }
}
