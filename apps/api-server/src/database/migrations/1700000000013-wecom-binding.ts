import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';

/**
 * 阶段：企业微信对话机器人（KB 助手移动化 · 路线 B）
 * 新增 ab_wecom_binding（userid ↔ 预签发令牌 映射表）
 *
 * 幂等：up 先 hasTable 判定；down 删表。
 */
export class WecomBinding1700000000013 implements MigrationInterface {
  name = 'WecomBinding1700000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('ab_wecom_binding')) return;
    await queryRunner.createTable(
      new Table({
        name: 'ab_wecom_binding',
        columns: [
          new TableColumn({ name: 'userid', type: 'varchar', length: '64', isPrimary: true, isNullable: false }),
          new TableColumn({ name: 'operator_name', type: 'varchar', length: '64', isNullable: false }),
          new TableColumn({ name: 'operator_token', type: 'varchar', length: '512', isNullable: true }),
          new TableColumn({ name: 'approver_token', type: 'varchar', length: '512', isNullable: true }),
          new TableColumn({ name: 'created_at', type: 'datetime', default: 'CURRENT_TIMESTAMP', isNullable: true }),
          new TableColumn({
            name: 'updated_at',
            type: 'datetime',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
            isNullable: true,
          }),
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('ab_wecom_binding')) {
      await queryRunner.dropTable('ab_wecom_binding');
    }
  }
}
