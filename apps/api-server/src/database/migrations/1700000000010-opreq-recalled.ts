import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 高危审批申请单：补充「撤回」能力（阶段 3 补刀 · 2026-10-19）
 *
 * 新增 3 列，支撑 `recall` 端点（仅 pending 可撤回，operator 仅能撤自己提交的）：
 *   - recalled_at    DATETIME(3) 撤回时间
 *   - recalled_by    BIGINT      撤回人 admin_user_id
 *   - recall_reason  VARCHAR(255) 撤回理由（选填）
 * 状态机新增终态：pending → recalled。
 *
 * ⚠️ 同 SOP：生产库不跑 migration:run，实际加列由
 *   `_tmp/kb/add-opreq-recalled-cols.mjs` 直连生产库执行（幂等：先查 information_schema）。
 */
export class OperationRequestRecalled1700000000010 implements MigrationInterface {
  name = 'OperationRequestRecalled1700000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const cols = await queryRunner.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ab_operation_request'
         AND COLUMN_NAME IN ('recalled_at','recalled_by','recall_reason')`,
    );
    const have = new Set((cols as Array<{ COLUMN_NAME: string }>).map((c) => c.COLUMN_NAME));
    if (!have.has('recalled_at'))
      await queryRunner.query(`ALTER TABLE \`ab_operation_request\`
        ADD COLUMN \`recalled_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '撤回时间' AFTER \`executed_at\``);
    if (!have.has('recalled_by'))
      await queryRunner.query(`ALTER TABLE \`ab_operation_request\`
        ADD COLUMN \`recalled_by\` BIGINT NULL DEFAULT NULL COMMENT '撤回人 admin_user_id' AFTER \`recalled_at\``);
    if (!have.has('recall_reason'))
      await queryRunner.query(`ALTER TABLE \`ab_operation_request\`
        ADD COLUMN \`recall_reason\` VARCHAR(255) NULL DEFAULT NULL COMMENT '撤回理由（选填）' AFTER \`recalled_by\``);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`ab_operation_request\`
      DROP COLUMN \`recalled_at\`, DROP COLUMN \`recalled_by\`, DROP COLUMN \`recall_reason\``);
  }
}
