import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 推荐关系扩展（2026-10-23）：ab_leader_invite 增加 `inviter_user_id`
 *
 * ## 为什么新增一列而不是复用 `inviter_leader_id`
 * 新规则：普通注册用户（非团长）也能推荐别人当团长，且只有非团长推荐才返代金券。
 * 邀请人身份因此分两类：
 *   · 在职团长（LDR 码）→ 落 `inviter_leader_id`（历史既有列，沿用）；
 *   · 普通用户（USR 码）→ 落本列 `inviter_user_id`。
 * 两列互斥并存，既满足新规则，又不破坏「团长推荐 → 晋级审计」的既有链路与历史数据。
 *
 * ## 与实体逐列一致
 * 列名 / 类型 / 索引名须与 `entities/leader.entity.ts` 的 `LeaderInvite.inviterUserId`
 * 逐项一致，否则 `schema:parity` 转红。
 *
 * ## 幂等
 * `ADD COLUMN` 用 `IF NOT EXISTS` 思路：MySQL 8 不支持 `ADD COLUMN IF NOT EXISTS`，
 * 故 `up()` 先探测 information_schema，已存在则跳过，保证重跑幂等。
 */
export class ReferralUser1700000000018 implements MigrationInterface {
  name = 'ReferralUser1700000000018';

  private async columnExists(queryRunner: QueryRunner, column: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ab_leader_invite' AND COLUMN_NAME = ?`,
      [column],
    )) as Array<{ COLUMN_NAME: string }>;
    return rows.length > 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'inviter_user_id'))) {
      await queryRunner.query(
        `ALTER TABLE \`ab_leader_invite\`
           ADD COLUMN \`inviter_user_id\` BIGINT UNSIGNED DEFAULT NULL
           COMMENT '真实推荐人用户 id（非团长也可推荐；与 inviter_leader_id 互斥并存）'
           AFTER \`inviter_leader_id\``,
      );
      console.log('   ↳ ReferralUser：ab_leader_invite 增加 inviter_user_id（已存在则跳过）');
    } else {
      console.log('   ↳ ReferralUser：inviter_user_id 已存在，跳过');
    }

    await queryRunner
      .query(
        `ALTER TABLE \`ab_leader_invite\`
         ADD INDEX \`idx_invite_inviter_user\` (\`inviter_user_id\`, \`is_formal\`)`,
      )
      .catch(() => {
        // 索引已存在则忽略（索引名唯一，重复 ADD 会报 Duplicate key）
      });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query(`ALTER TABLE \`ab_leader_invite\` DROP KEY \`idx_invite_inviter_user\``)
      .catch(() => {
        /* 索引不存在则忽略 */
      });
    if (await this.columnExists(queryRunner, 'inviter_user_id')) {
      await queryRunner.query(`ALTER TABLE \`ab_leader_invite\` DROP COLUMN \`inviter_user_id\``);
    }
  }
}
