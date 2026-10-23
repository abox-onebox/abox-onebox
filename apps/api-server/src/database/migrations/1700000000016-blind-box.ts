import { MigrationInterface, QueryRunner } from 'typeorm';
import { columnExists } from '../migration-utils';

/**
 * x 盲盒（轻量小辅助功能 · 2026-10-23）：ab_order 增 `blind_box_name` 列
 *
 * ## 功能定位（用户定调）
 * x 盲盒**不是主功能**，只是一个小辅助：每单自动附赠一份轻食惊喜，
 * 下单时不知道内容（不揭晓），送达后揭晓。作用：① 给三菜做补充（饭量大的一起吃，
 * 饭量小的当下午茶）；② 某菜有闪失（缺漏 / 延误 / 错单）时作为弥补；③ 给用户一点未知惊喜。
 *
 * ## 字段形态
 * `blind_box_name` = 抽到的内容文案（如「小粗粮」），下单时从 ab_config.blind_box_items 池随机定，
 * 送达后由端上按订单状态展示；null = 本单未含盲盒（功能关闭 / 池为空）。
 *
 * ## 幂等
 * `columnExists` 守护；down() 对称删除列。
 */

const ADD_COLUMN = `ALTER TABLE \`ab_order\`
  ADD COLUMN \`blind_box_name\` VARCHAR(64) NULL DEFAULT NULL
  COMMENT 'x 盲盒抽到的内容（下单时定，送达后揭晓；null=未含盲盒）'`;

export class BlindBoxOrder1700000000016 implements MigrationInterface {
  name = 'BlindBoxOrder1700000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await columnExists(queryRunner, 'ab_order', 'blind_box_name')) {
      console.log('   ↳ BlindBoxOrder：blind_box_name 已存在，跳过');
      return;
    }
    await queryRunner.query(ADD_COLUMN);
    console.log('   ↳ BlindBoxOrder：ab_order 增列 blind_box_name（VARCHAR 64）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await columnExists(queryRunner, 'ab_order', 'blind_box_name')) {
      await queryRunner.query('ALTER TABLE `ab_order` DROP COLUMN `blind_box_name`');
      console.log('   ↳ BlindBoxOrder：ab_order 删列 blind_box_name');
    }
  }
}
