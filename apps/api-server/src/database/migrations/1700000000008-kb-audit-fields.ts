import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 知识助手「替操作」审计三字段（B3 · 2026-10-18）
 *
 * 在 `ab_operation_log` 增加三列，承接 `OperationLogInterceptor` 从请求头
 * `X-KB-Operator` / `X-KB-NL` / `X-KB-OpBlock` 捕获的审计信息：
 *   · `kb_operator`  —— 知识助手自报操作人（区别于登录账号 `admin_user_id`）
 *   · `kb_nl_intent` —— 同事输入的自然语言指令
 *   · `kb_op_block`  —— 知识助手生成的操作块 JSON
 *
 * 三列均可空：普通后台操作不带这些头 → 恒为 NULL，向后兼容。
 *
 * ⚠️ 生产部署 SOP 走 `docker cp` + 容器内 `tsc` + `restart`，不跑 `migration:run`
 *    （`DB_SYNCHRONIZE=false`）。本迁移仅作 schema 演进记录；实际加列由
 *    `_tmp/kb/add-oplog-columns.mjs` 直连生产库执行（同样幂等）。
 */
export class KbAuditFields1700000000008 implements MigrationInterface {
  name = 'KbAuditFields1700000000008';

  private async hasColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows = await queryRunner.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const cols: Array<{ name: string; ddl: string }> = [
      {
        name: 'kb_operator',
        ddl: "`kb_operator` VARCHAR(64) NULL DEFAULT NULL COMMENT '知识助手自报操作人（X-KB-Operator）'",
      },
      {
        name: 'kb_nl_intent',
        ddl: "`kb_nl_intent` TEXT NULL COMMENT '知识助手自然语言指令（X-KB-NL）'",
      },
      {
        name: 'kb_op_block',
        ddl: "`kb_op_block` TEXT NULL COMMENT '知识助手生成的操作块JSON（X-KB-OpBlock）'",
      },
    ];
    for (const c of cols) {
      if (!(await this.hasColumn(queryRunner, 'ab_operation_log', c.name))) {
        await queryRunner.query(`ALTER TABLE \`ab_operation_log\` ADD COLUMN ${c.ddl}`);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const c of ['kb_operator', 'kb_nl_intent', 'kb_op_block']) {
      if (await this.hasColumn(queryRunner, 'ab_operation_log', c)) {
        await queryRunner.query(`ALTER TABLE \`ab_operation_log\` DROP COLUMN \`${c}\``);
      }
    }
  }
}
