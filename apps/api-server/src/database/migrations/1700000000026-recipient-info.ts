import { MigrationInterface, QueryRunner } from 'typeorm';
import { columnExists } from '../migration-utils';

/**
 * 取餐人称呼 + 工位（2026-11-18）：双表加列
 *
 * ## 缺口本身
 *
 * 此前用户下单只有「份数」，团长端只显示 `u.nickname`（微信昵称，恒「微信用户」）
 * 与脱敏手机号（恒 null），送工位时认不出下单人。本迁移为两张表各加两列：
 *   · `ab_user`  —— 用户档案，下单时回写，下次预填免填；
 *   · `ab_order` —— 每单快照，定格下单那刻的称呼/工位，团长照单送，
 *                   用户事后改档案不影响历史订单。
 *
 * ## 为什么双写而非只存一处
 *
 * 只存 user：用户改档案后，历史订单的称呼/工位跟着变，团长送错。
 * 只存 order：用户每次下单都要重填，体验差。双写兼顾「免填」与「历史定格」。
 *
 * ## 与实体逐列一致（schema:parity 判据）
 *
 * 列名 / 类型 / nullable 须与 `entities/user.entity.ts` 与 `entities/order.entity.ts`
 * 逐项一致，否则 `schema:parity` 转红。本地 sqlite 由实体 synchronize 建表，
 * 生产 MySQL 由本迁移加列。
 *
 * ## 幂等
 *
 * `columnExists` 守护四列；`down()` 对称删除。MySQL 8 不支持 `IF NOT EXISTS` 形式，
 * 故必须逐项查 information_schema。
 *
 * ⚠️ 以下四条 SQL 必须写成**完整字面量**（不要抽成变量/数组）——
 *    `schema:parity` 用正则静态扫源码里的列定义，并做「源码出现次数 == 解析条数」
 *    自检；抽成模板变量会让它解析到 0 条而报「有语句被漏读」。
 */

const ADD_USER_RECIPIENT = `ALTER TABLE \`ab_user\`
  ADD COLUMN \`recipient_name\` VARCHAR(32) NULL
  COMMENT '取餐人称呼（下单回写档案，团长认人）'`;

const ADD_USER_WORKSTATION = `ALTER TABLE \`ab_user\`
  ADD COLUMN \`workstation\` VARCHAR(64) NULL
  COMMENT '工位/取餐点（下单回写档案）'`;

const ADD_ORDER_RECIPIENT = `ALTER TABLE \`ab_order\`
  ADD COLUMN \`recipient_name\` VARCHAR(32) NULL
  COMMENT '取餐人称呼快照（下单定格）'`;

const ADD_ORDER_WORKSTATION = `ALTER TABLE \`ab_order\`
  ADD COLUMN \`workstation\` VARCHAR(64) NULL
  COMMENT '工位/取餐点快照（下单定格）'`;

export class RecipientInfo1700000000026 implements MigrationInterface {
  name = 'RecipientInfo1700000000026';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await columnExists(queryRunner, 'ab_user', 'recipient_name'))) {
      await queryRunner.query(ADD_USER_RECIPIENT);
    } else {
      console.log('   ↳ RecipientInfo：ab_user.recipient_name 已存在，跳过');
    }
    if (!(await columnExists(queryRunner, 'ab_user', 'workstation'))) {
      await queryRunner.query(ADD_USER_WORKSTATION);
    } else {
      console.log('   ↳ RecipientInfo：ab_user.workstation 已存在，跳过');
    }
    if (!(await columnExists(queryRunner, 'ab_order', 'recipient_name'))) {
      await queryRunner.query(ADD_ORDER_RECIPIENT);
    } else {
      console.log('   ↳ RecipientInfo：ab_order.recipient_name 已存在，跳过');
    }
    if (!(await columnExists(queryRunner, 'ab_order', 'workstation'))) {
      await queryRunner.query(ADD_ORDER_WORKSTATION);
    } else {
      console.log('   ↳ RecipientInfo：ab_order.workstation 已存在，跳过');
    }
    console.log('   ↳ RecipientInfo：ab_user / ab_order 各补 recipient_name、workstation');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of [
      ['ab_user', 'recipient_name'],
      ['ab_user', 'workstation'],
      ['ab_order', 'recipient_name'],
      ['ab_order', 'workstation'],
    ]) {
      if (await columnExists(queryRunner, table, column)) {
        await queryRunner.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
      }
    }
  }
}
