import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Q3 送达凭证：新建第 35 张表 `ab_delivery_proof`（2026-10-29）
 *
 * ## 缺口本身
 * `deliverProof` / `proofUrl` 全仓零命中 —— 配送单推进到 `arrived` 之后，
 * 「货确实送到了」这件事在系统里**没有任何证据**。用户投诉没收到、或团长与运营
 * 各执一词时，只能靠翻聊天记录举证。钱货两端都已可追溯，唯独**交付这一环没有落点**。
 *
 * ## ⭐ 为什么是独立表，而不是在 `ab_delivery_record` 上加一个 JSON 列
 *
 * 本项目有 JSON 列的先例：`ab_supplier.store_photos`（迁移 `...015`）就是 JSON，
 * 理由是「一对少、低频写、无聚合查询」。本表**三条都不成立**，故刻意不同：
 *
 * ① **凭证是举证材料，不是展示素材**。它的价值在于「什么时候、谁、传了什么」逐条可查。
 *    JSON 列是**整列覆盖写**：传第二张要读-改-写整列，第一张的上传时间与上传人随之消失。
 *    真到举证那天，被问的恰恰是「第一张谁传的」。
 * ② **并发上传会丢张**。团长端将来接入后，两端同时传 = 两个请求各读一次旧 JSON、各写一次，
 *    后写的覆盖先写的，且**不报任何错**。INSERT 天然没有这个问题。
 * ③ **要被聚合查询**。「某天哪些楼群还没传凭证」「这张配送单有几张凭证」是运营日常动作，
 *    JSON 列只能 `JSON_LENGTH` / `JSON_CONTAINS` 全表扫，索引完全用不上。
 *
 * 另：凭证允许**逐条撤销**（传错了重传），软删要逐行打标记 —— JSON 列里删一个元素
 * 同样是覆盖写，撤掉的那条连「曾经存在过」都看不出来。
 *
 * ## 为什么挂在配送单（`ab_delivery_record`）而不是订单（`ab_order`）
 * 举证粒度是「**某个楼群某出餐日**送到了没有」，而一个楼群一天**恰好一张**配送单
 * （`uk_delivery_date_group` 唯一索引保证）。挂订单的后果是：同一张现场照要跟几十笔订单
 * 各存一份，既冗余，又会出现「同一个楼群、同一天，A 订单有凭证、B 订单没有」的荒谬状态 ——
 * 而那份凭证描述的是**同一个物理事件**。
 *
 * ## 表设计要点
 * - **无外键**：既有约定 —— FK 只存在于文档，不进 DDL。
 * - **无唯一约束**：同一张配送单允许多张凭证（车厢全景 / 交接点 / 签收单）。
 * - **无 `version` 列**：本表是 append-only 插入 + 单行软删，不是并发争抢资源
 *   （与 `ab_sales_pause` 同口径）。
 * - **软删而非硬删**（`deleted_at`）：误传可撤，但**行保留** —— 「这里曾经有一张被撤掉的凭证」
 *   本身就是审计事实。硬删会让「传了又撤」在系统里彻底蒸发。
 * - **`uploaded_by` 一期只记 `admin_user_id`**：当前配送接口全是后台
 *   （`admin/deliveries` · AdminGuard），团长端上传口尚不存在。
 *   ⚠️ 刻意**不为假想需求预留** `uploader_role` + 多态 id —— 那种「按 role 解释 id」的列
 *   在没有第二个调用方之前只会造成误读。团长端真要接入，加一列是常规迁移（本目录已有 20 支）。
 * - **`kind` 只是分类标签，不是状态**：不做状态机、不校验转换 —— 一份凭证不会从
 *   「现场照」流转成「签收单」。
 *
 * ## ⚠️ 与实体逐列一致（schema:parity / index:parity 判据）
 *
 * 实体在 `entities/order.entity.ts` 的 `DeliveryProof`：
 *   · 列名 / 类型 / 长度 / 精度须逐项一致；
 *   · 索引名 `idx_delivery_proof_record` 与列 `delivery_record_id` 须逐名逐列一致。
 * 本表只由迁移在**生产**建出，本地 sqlite 由实体 synchronize 建出 ——
 * 两侧不齐会在两道 parity 门禁上转红。
 *
 * ## 幂等与可重入
 * `CREATE TABLE IF NOT EXISTS`（MySQL 8 天然幂等）；`down()` 对称 `DROP TABLE IF EXISTS`。
 */
const NEW_TABLE = `CREATE TABLE IF NOT EXISTS \`ab_delivery_proof\` (
   \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
   \`delivery_record_id\` BIGINT UNSIGNED NOT NULL COMMENT '所属配送单 ab_delivery_record.id（FK 仅文档约定）',
   \`url\` VARCHAR(512) NOT NULL COMMENT '凭证文件地址（本地 /static/... 或 CDN）',
   \`kind\` VARCHAR(16) NOT NULL DEFAULT 'photo' COMMENT 'photo 现场照 / sign 签收单 / other 其它',
   \`remark\` VARCHAR(255) DEFAULT NULL COMMENT '备注（运营可写一句说明）',
   \`uploaded_by\` BIGINT UNSIGNED DEFAULT NULL COMMENT '上传人 admin_user_id（一期仅后台上传）',
   \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
   \`deleted_at\` DATETIME(3) DEFAULT NULL COMMENT '软删时刻（误传可撤；行保留以备审计）',
   PRIMARY KEY (\`id\`),
   KEY \`idx_delivery_proof_record\` (\`delivery_record_id\`)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='配送送达凭证（Q3 · 举证材料 · append-only）'`;

export class DeliveryProof1700000000020 implements MigrationInterface {
  name = 'DeliveryProof1700000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(NEW_TABLE);
    console.log('   ↳ DeliveryProof：建表 ab_delivery_proof（IF NOT EXISTS，重跑幂等）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `ab_delivery_proof`');
  }
}
