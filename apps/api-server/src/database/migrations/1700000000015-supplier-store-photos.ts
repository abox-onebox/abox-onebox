import { MigrationInterface, QueryRunner } from 'typeorm';
import { columnExists } from '../migration-utils';

/**
 * 供应商门店实拍 / 证照照片：ab_supplier 增 JSON 列 store_photos（2026-10-23 · 方案B 照片墙）
 *
 * ## 为什么是 JSON 列而非独立表
 * 照片是「一家供应商一组有序图（营业执照 / 门头 / 大厅 / 仓库 …）」，天然一对少、无聚合查询需求，
 * 与 `takeout_links` 同属「小结构、低频写」——独立表要连带 CRUD + parity 豁免，
 * JSON 列零额外表、直接复用实体读写。ref 合规文档 §8.4 也明确「要上证照图片 + 后厨环境照片
 * 才需新增 1 个 JSON 列」。
 *
 * ## 字段形态
 * `store_photos` = Array<{ url, category?, caption? }>，null 表示未配置。
 * 端上「有则显示、无则隐藏」，不强制每家都传。
 *
 * ## ⚠️ 合规（关键，动手前已核实）
 * 123 / 124 号令要求「公示证照 + 门店实拍」**小程序内公示** —— 本列是合规刚需的落地载体，非禁忌。
 * 但远程图能真正显示的前提：**域名完成 ICP 备案 + 小程序后台配置 `downloadFile` 合法域名白名单**
 * （`xunlizhinian.cn` 备案进行中）。仅写库、域名未配时，端上图片会 404。
 *
 * ## 幂等
 * `columnExists` 守护；down() 对称删除列。
 */

const ADD_COLUMN = `ALTER TABLE \`ab_supplier\`
  ADD COLUMN \`store_photos\` JSON NULL
  COMMENT '门店实拍/证照照片（JSON 数组 {url,category,caption}；null=未配置）'`;

export class SupplierStorePhotos1700000000015 implements MigrationInterface {
  name = 'SupplierStorePhotos1700000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await columnExists(queryRunner, 'ab_supplier', 'store_photos')) {
      console.log('   ↳ SupplierStorePhotos：store_photos 已存在，跳过');
      return;
    }
    await queryRunner.query(ADD_COLUMN);
    console.log('   ↳ SupplierStorePhotos：ab_supplier 增列 store_photos（JSON）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await columnExists(queryRunner, 'ab_supplier', 'store_photos')) {
      await queryRunner.query('ALTER TABLE `ab_supplier` DROP COLUMN `store_photos`');
      console.log('   ↳ SupplierStorePhotos：ab_supplier 删列 store_photos');
    }
  }
}
