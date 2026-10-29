import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 代金券批量发放 + 回收兜底（2026-10-29）：`ab_user_coupon` 增加三列两个索引
 *
 * ## 缺口本身
 * 后台发券（`POST /admin/coupon/grant`）**一次只能发一个人**（入参是单个 `userId`
 * 或 `userPhone`）。要给全平台 73 个用户发一张补偿券，运营得把同一个弹窗填 73 遍 ——
 * 而「全员补偿」恰恰是最常见的发券场景（出餐事故、系统故障、配送延误）。
 * 更糟的是：**发错的券没有任何撤回手段**（券模块只有下单核销 `reserveForOrder`
 * 与退券 `releaseForOrder`，没有回收接口）。单人发券时填错金额只是损失一张券；
 * 一旦将来做了批量，一次误发就是几十张券同时出去且**收不回来**。
 *
 * ⇒ 故本次把「批量」与「回收」**绑在一起做**：先有兜底，再开闸。
 *
 * ## 三列各管什么
 * - **`grant_batch_no`**：批次号。批量发放时同一批券共用一个号，单人发放为 `NULL`。
 *   它是**幂等的锚**：重试 / 重复提交同一批次时，用它查出「这一批已经发过谁」并跳过，
 *   避免「点了两下发了两批」。也是事后追溯的锚：「10-29 那批补偿券都发给谁了」。
 * - **`revoked_at`**：回收时刻。`NULL` = 未回收。刻意**不用**「整行软删」表达回收 ——
 *   券是资产凭证，「这里曾经有过一张被撤掉的券」本身就是审计事实（与
 *   `ab_delivery_proof.deleted_at` 同口径：行保留、只打标记）。
 * - **`revoked_by`**：回收操作人（`ab_admin_user.id`）。回答「谁撤的」。
 *   ⚠️ 回收**原因**不占列：由 `@OperationLog` 的 `request_data` 落操作日志，
 *   与全工程「审计靠操作日志、不靠业务表冗余」的口径一致。
 *
 * ## ⭐ 为什么幂等用「唯一索引」而不是「先查再插」
 * 应用侧「先 SELECT 查重、再 INSERT」在并发下有个经典缺口：两个请求同时查到
 * 「还没发」，于是都去插 —— 而批量发券正是**并发最容易发生**的场景（运营双击、
 * 或运营 A 与运营 B 同时对同一批人发起）。唯一索引把判据下沉到数据库，
 * 让第二个 INSERT **必然失败**，配合服务层「忽略重复键」的处理做到真幂等。
 *
 * ⚠️ `uk_user_coupon_batch_user`（`grant_batch_no`, `user_id`）**不会误伤单人发放**：
 *    MySQL 唯一索引允许**多个 NULL**，单人发放时 `grant_batch_no IS NULL`，
 *    同一个人可以反复收到单人券，不受这条约束影响（这也正是选它而不是
 *    「新增一张批次表」的原因 —— 一次性发几千张的结构不该为偶发动作而建）。
 *
 * ## 与实体逐列一致
 * 列 / 类型 / 索引名须与 `entities/coupon.entity.ts` 的 `UserCoupon` 逐项一致，
 * 否则 `schema:parity` / `index:parity` 转红。本表只由迁移在**生产**建出，
 * 本地 sqlite 由实体 synchronize 建出 —— 两侧不齐会在两道门禁上同时转红。
 *
 * ## 幂等与可重入
 * `ADD COLUMN`：MySQL 8 不支持 `ADD COLUMN IF NOT EXISTS`，故先探测
 * `information_schema.COLUMNS`，已存在则跳过。索引重复 ADD 会报 Duplicate key，
 * 用 `.catch()` 忽略（索引名唯一，忽略是安全的）。
 */
export class CouponBatch1700000000021 implements MigrationInterface {
  name = 'CouponBatch1700000000021';

  private async columnExists(queryRunner: QueryRunner, column: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ab_user_coupon' AND COLUMN_NAME = ?`,
      [column],
    )) as Array<{ COLUMN_NAME: string }>;
    return rows.length > 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.columnExists(queryRunner, 'grant_batch_no'))) {
      await queryRunner.query(
        `ALTER TABLE \`ab_user_coupon\`
           ADD COLUMN \`grant_batch_no\` VARCHAR(32) DEFAULT NULL
           COMMENT '批量发放批次号（同一批共用；单人发券为 NULL）'`,
      );
      console.log('   ↳ CouponBatch：ab_user_coupon 增加 grant_batch_no');
    } else {
      console.log('   ↳ CouponBatch：grant_batch_no 已存在，跳过');
    }

    if (!(await this.columnExists(queryRunner, 'revoked_at'))) {
      await queryRunner.query(
        `ALTER TABLE \`ab_user_coupon\`
           ADD COLUMN \`revoked_at\` DATETIME(3) DEFAULT NULL
           COMMENT '回收时刻（NULL=未回收；行保留以备审计）'`,
      );
      console.log('   ↳ CouponBatch：ab_user_coupon 增加 revoked_at');
    } else {
      console.log('   ↳ CouponBatch：revoked_at 已存在，跳过');
    }

    if (!(await this.columnExists(queryRunner, 'revoked_by'))) {
      await queryRunner.query(
        `ALTER TABLE \`ab_user_coupon\`
           ADD COLUMN \`revoked_by\` BIGINT UNSIGNED DEFAULT NULL
           COMMENT '回收操作人 ab_admin_user.id'`,
      );
      console.log('   ↳ CouponBatch：ab_user_coupon 增加 revoked_by');
    } else {
      console.log('   ↳ CouponBatch：revoked_by 已存在，跳过');
    }

    // 按批次追溯用；NULL 行不进索引（MySQL 普通索引允许 NULL，但查询恒为 IS NOT NULL）
    await queryRunner
      .query(
        `ALTER TABLE \`ab_user_coupon\`
           ADD INDEX \`idx_user_coupon_batch\` (\`grant_batch_no\`)`,
      )
      .catch(() => {
        /* 索引已存在则忽略 */
      });

    // ⭐ 幂等锚：同一批次同一用户只允许一张（NULL 批次不受约束，见头注）
    await queryRunner
      .query(
        `ALTER TABLE \`ab_user_coupon\`
           ADD UNIQUE INDEX \`uk_user_coupon_batch_user\` (\`grant_batch_no\`, \`user_id\`)`,
      )
      .catch(() => {
        /* 索引已存在则忽略 */
      });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query(`ALTER TABLE \`ab_user_coupon\` DROP INDEX \`uk_user_coupon_batch_user\``)
      .catch(() => {
        /* 索引不存在则忽略 */
      });
    await queryRunner
      .query(`ALTER TABLE \`ab_user_coupon\` DROP INDEX \`idx_user_coupon_batch\``)
      .catch(() => {
        /* 索引不存在则忽略 */
      });
    for (const col of ['revoked_by', 'revoked_at', 'grant_batch_no']) {
      if (await this.columnExists(queryRunner, col)) {
        await queryRunner.query(`ALTER TABLE \`ab_user_coupon\` DROP COLUMN \`${col}\``);
      }
    }
  }
}
