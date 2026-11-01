import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 企微绑定表加「身份等级」列 `tier`（2026-11-01）
 *
 * ## 为什么需要这一列
 *
 * 机器人要能打到**全部 131 个后台端点**，但「谁能打哪些」必须按人区分：
 *   · 负责人（owner）→ 用后台 `admin` 角色的执行账号，131 个可达；
 *   · 同事（staff） → 用后台 `operator` 角色的执行账号，69 个可达，其余由后台
 *     @Roles 直接拒绝（这是代码之外的**第二道闸门**，不靠自觉）。
 *
 * 没有这一列，就只能全公司共用一个高权限账号 —— 那时「同事不能动钱」完全取决于
 * 应用层判据写没写对，一次手滑就变成真金白银的损失。
 *
 * ## 默认值为什么是 `staff` 而不是 `owner`
 *
 * 已有绑定行（若有）按最小权限补：宁可负责人第一次用发现「干不了」来找我加权限，
 * 也不能让一个历史遗留绑定突然获得 admin 能力。
 *
 * ## 幂等
 * MySQL 8 不支持 `ADD COLUMN IF NOT EXISTS`，故先查 `information_schema` 再决定。
 * 重跑安全：列已存在就跳过（只补默认值，不改已有值）。
 */
export class WecomBindingTier1700000000022 implements MigrationInterface {
  name = 'WecomBindingTier1700000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ c: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ab_wecom_binding'
          AND COLUMN_NAME = 'tier'`,
    );
    const exists = Number(rows?.[0]?.c ?? 0) > 0;

    if (exists) {
      console.log('   ↳ WecomBindingTier：列 tier 已存在，跳过（重跑幂等）');
    } else {
      await queryRunner.query(
        `ALTER TABLE \`ab_wecom_binding\`
           ADD COLUMN \`tier\` VARCHAR(16) NOT NULL DEFAULT 'staff'
           COMMENT '身份等级：owner=负责人(admin 角色) / staff=同事(operator 角色)'`,
      );
      console.log('   ↳ WecomBindingTier：已加列 tier（默认 staff，最小权限）');
    }

    // 把历史 NULL / 空串补齐（老行若由别的路径写入可能没有默认值）
    await queryRunner.query(
      `UPDATE \`ab_wecom_binding\` SET \`tier\` = 'staff' WHERE \`tier\` IS NULL OR \`tier\` = ''`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ c: number | string }> = await queryRunner.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ab_wecom_binding'
          AND COLUMN_NAME = 'tier'`,
    );
    if (Number(rows?.[0]?.c ?? 0) > 0) {
      await queryRunner.query('ALTER TABLE `ab_wecom_binding` DROP COLUMN `tier`');
    }
  }
}
