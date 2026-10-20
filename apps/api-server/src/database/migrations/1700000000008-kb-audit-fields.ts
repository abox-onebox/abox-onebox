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
    /*
     * ⚠️ 2026-10-20 静态化改写（**语义完全不变**，生产零影响）：
     *
     * 原写法把列 DDL 放进 `cols` 数组、再以 `ADD COLUMN ${c.ddl}` 动态拼接 ——
     * `schema:parity` 的自检要求「源码里每条 ADD COLUMN 都能被静态解析」，
     * 动态拼接使解析条数 0 ≠ 源码条数 1 ⇒ 整道门禁抛错，而这**三列从未参与过
     * 「迁移 ↔ 实体」对账」（本地由实体 synchronize 建、生产由直连脚本加，
     * 两边都不经过迁移对账 —— 与 #76 同族的静默缺口）。
     *
     * 本迁移**未在任何环境跑过 `migration:run`**（见文件头：生产走
     * `_tmp/kb/add-oplog-columns.mjs` 直连执行，本地 sqlite 走 synchronize）——
     * 改写不改变任何已发生的结构变更，只是让「schema 演进记录」重新可被机械核对。
     * 改写前后逐列一致：同名、同类型（VARCHAR(64) / TEXT / TEXT）、同可空、同注释。
     */
    const adds: Array<{ name: string; sql: string }> = [
      {
        name: 'kb_operator',
        sql: `ALTER TABLE \`ab_operation_log\` ADD COLUMN \`kb_operator\` VARCHAR(64) NULL DEFAULT NULL COMMENT '知识助手自报操作人（X-KB-Operator）'`,
      },
      {
        name: 'kb_nl_intent',
        sql: `ALTER TABLE \`ab_operation_log\` ADD COLUMN \`kb_nl_intent\` TEXT NULL COMMENT '知识助手自然语言指令（X-KB-NL）'`,
      },
      {
        name: 'kb_op_block',
        sql: `ALTER TABLE \`ab_operation_log\` ADD COLUMN \`kb_op_block\` TEXT NULL COMMENT '知识助手生成的操作块JSON（X-KB-OpBlock）'`,
      },
    ];
    for (const c of adds) {
      if (!(await this.hasColumn(queryRunner, 'ab_operation_log', c.name))) {
        await queryRunner.query(c.sql);
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
