import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 强制首登改密（P2 · 2026-10-19）
 *
 * 在 `ab_admin_user` 增加 `must_change_password` 列：
 *   · 口令被运维轮转（set-admin-password.mjs --gen）后，应置 1，
 *     使该账号下次登录后**被系统卡死**，必须先改密才能做任何业务操作。
 *   · `POST /api/v1/auth/change-password` 成功后清除为 0。
 *
 * ⚠️ 生产部署 SOP 同 B3：本迁移记录 schema 演进；实际加列由运维在容器内
 *    直连生产库执行（DB_SYNCHRONIZE=false，不跑 migration:run）。
 */
export class MustChangePassword1700000000012 implements MigrationInterface {
  name = 'MustChangePassword1700000000012';

  private async hasColumn(qr: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows = await qr.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  public async up(qr: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(qr, 'ab_admin_user', 'must_change_password'))) {
      await qr.query(
        `ALTER TABLE \`ab_admin_user\` ADD COLUMN \`must_change_password\` TINYINT NOT NULL DEFAULT 0 COMMENT '强制改密标记（P2）：1=必须改密'`,
      );
    }
  }

  public async down(qr: QueryRunner): Promise<void> {
    if (await this.hasColumn(qr, 'ab_admin_user', 'must_change_password')) {
      await qr.query(`ALTER TABLE \`ab_admin_user\` DROP COLUMN \`must_change_password\``);
    }
  }
}
