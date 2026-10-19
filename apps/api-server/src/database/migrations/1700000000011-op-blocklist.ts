import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 知识助手禁止清单（P1-c - 2026-10-19）
 *
 * 新建 ab_op_blocklist：管理员把某些 op 列入禁止后，助手无论直执行还是提交审批都被服务端拦截。
 * 与前端 localStorage 自解禁无关，是服务端权威闸（见 OpBlocklistInterceptor 与 OperationRequestService）。
 *
 * 生产部署：随 db:migrate:dist 应用；或按既有 SOP 直连生产库执行本文件 up() 的 CREATE TABLE。
 */
export class OpBlocklistTable1700000000011 implements MigrationInterface {
  name = 'OpBlocklistTable1700000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ab_op_blocklist'`,
    );
    if (Array.isArray(exists) && exists.length > 0) return;

    await queryRunner.query(`
      CREATE TABLE \`ab_op_blocklist\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`op_code\` VARCHAR(48) NOT NULL COMMENT 'OPS_CATALOG 的 op 代码',
        \`note\` VARCHAR(255) NULL DEFAULT NULL COMMENT '禁止原因（管理员填写）',
        \`created_by\` BIGINT NULL DEFAULT NULL COMMENT '列入人 admin_user_id',
        \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_op_block_op\` (\`op_code\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='知识助手禁止清单（P1-c）'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS \`ab_op_blocklist\``);
  }
}
