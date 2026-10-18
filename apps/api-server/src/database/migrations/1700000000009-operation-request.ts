import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 替操作「高危审批」申请单（阶段 3 · 2026-10-18）
 *
 * 新建 `ab_operation_request`，承载 admin 高危操作「申请 → 审批 → 执行」两步流。
 * 状态机：pending → approved → executed；pending → rejected（终态）。
 *
 * ⚠️ 生产部署 SOP 走 `docker cp` + 容器内 `tsc` + `restart`，不跑 `migration:run`
 *    （`DB_SYNCHRONIZE=false`）。本迁移仅作 schema 演进记录；实际建表由
 *    `_tmp/kb/create-operation-request-table.mjs` 直连生产库执行（同样幂等）。
 */
export class OperationRequestTable1700000000009 implements MigrationInterface {
  name = 'OperationRequestTable1700000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ab_operation_request'`,
    );
    if (Array.isArray(exists) && exists.length > 0) return;

    await queryRunner.query(`
      CREATE TABLE \`ab_operation_request\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`op_code\` VARCHAR(48) NOT NULL COMMENT 'OPS_CATALOG 的 op 代码',
        \`op_label\` VARCHAR(96) NOT NULL COMMENT '操作中文名（冗余存）',
        \`risk\` VARCHAR(16) NOT NULL DEFAULT 'admin' COMMENT 'operator/admin',
        \`params\` JSON NOT NULL COMMENT '校验后的真实参数（执行时即作为目标接口 body）',
        \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/approved/rejected/executed',
        \`submitter_kb\` VARCHAR(64) NULL DEFAULT NULL COMMENT '知识助手自报操作人（X-KB-Operator）',
        \`submitter_admin_id\` BIGINT NULL DEFAULT NULL COMMENT '后台手动建单/代为提交人',
        \`submitter_nl\` TEXT NULL COMMENT '自然语言原文（X-KB-NL）',
        \`submitter_op_block\` JSON NULL COMMENT '操作块 JSON（X-KB-OpBlock 原文）',
        \`approver_id\` BIGINT NULL DEFAULT NULL COMMENT '审批人 admin_user_id',
        \`approved_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '审批时间',
        \`reject_reason\` VARCHAR(255) NULL DEFAULT NULL COMMENT '驳回理由',
        \`snapshot\` JSON NULL COMMENT '执行回执（含 request_id 关联）',
        \`executed_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '执行时间',
        \`version\` INT NOT NULL DEFAULT 0,
        \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        KEY \`idx_opreq_status\` (\`status\`),
        KEY \`idx_opreq_submitter\` (\`submitter_admin_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='替操作高危审批申请单（阶段3）'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS \`ab_operation_request\``);
  }
}
