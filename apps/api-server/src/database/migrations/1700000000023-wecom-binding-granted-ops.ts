import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 企微绑定表加「单独放权清单」列 `granted_ops`（2026-11-01）
 *
 * ## 为什么还需要这一列（`tier` 不是够了吗）
 *
 * `tier` 只有两档：owner 全通、staff 只能做 operator 角色那 69 项。
 * 但真实需求是「张三能批退款、李四不能」—— 一个人一件事，不是两档能表达的。
 * 没有这一列，唯一的替代做法是把同事直接设成 owner，等于把 131 项全给他。
 *
 * ## 语义：加号，不是减号
 *
 * `NULL` / `[]` = 没放权，同事保留 operator 角色本来的能力（行为与加这列之前完全一致）；
 * 有编码 = 这些端点**额外**允许他做。所以「清空清单」是安全动作，
 * 不会把他原本能做的事一起收走（这一点若做成减号，收回放权会把同事直接干废）。
 *
 * ## 有放权时执行身份会变
 *
 * 被放权的端点 `@Roles` 里通常没有 operator，用 operator 令牌打过去会被后台 403。
 * 故 `granted_ops` 非空时执行账号切到 owner；限制改由机器人层按这份清单逐条判
 * （执行入口 `op-proxy.execCatalog` 与展示层各判一次，收回立刻失效）。
 *
 * ## 幂等
 * 同 `1700000000022`：MySQL 8 无 `ADD COLUMN IF NOT EXISTS`，先查 information_schema。
 */
export class WecomBindingGrantedOps1700000000023 implements MigrationInterface {
  name = 'WecomBindingGrantedOps1700000000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ c: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ab_wecom_binding'
          AND COLUMN_NAME = 'granted_ops'`,
    );
    const exists = Number(rows?.[0]?.c ?? 0) > 0;

    if (exists) {
      console.log('   ↳ WecomBindingGrantedOps：列 granted_ops 已存在，跳过（重跑幂等）');
      return;
    }

    await queryRunner.query(
      `ALTER TABLE \`ab_wecom_binding\`
         ADD COLUMN \`granted_ops\` TEXT NULL
         COMMENT '单独放权的端点编码 JSON 数组（仅 staff 生效；NULL/[] = 未放权）'`,
    );
    console.log('   ↳ WecomBindingGrantedOps：已加列 granted_ops（默认 NULL = 未放权）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ c: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ab_wecom_binding'
          AND COLUMN_NAME = 'granted_ops'`,
    );
    if (Number(rows?.[0]?.c ?? 0) > 0) {
      await queryRunner.query('ALTER TABLE `ab_wecom_binding` DROP COLUMN `granted_ops`');
    }
  }
}
