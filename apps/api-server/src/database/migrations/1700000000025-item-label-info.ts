import { MigrationInterface, QueryRunner } from 'typeorm';
import { columnExists } from '../migration-utils';

/**
 * 单品预包装标签信息：`ab_item` 增 JSON 列 `label_info`（2026-11-10 · 124 号令第二十条）
 *
 * ## 缺口本身
 *
 * 124 号令第二十条要求「销售食品主页面展示标签信息」。此前 `ab_item` 只有
 * name / image_url / category / description / cost_price，**一个标签字段都没有**；
 * 端上「关于我们」页只列了 GB 7718 的 8 个**字段名**，没有逐品具体值 ——
 * 审核或监管点开首页单品弹窗，看不到净含量 / 配料 / 保质期等真实标签内容。
 *
 * ## 为什么是 JSON 列而非独立表
 *
 * 标签是「一个单品一组键值对」，字段随品类有差异（饮料有「产品标准代号」、
 * 饼干有「致敏物质提示」），且只读展示、无聚合查询。与既有 `ab_supplier.store_photos`
 * 同口径：一对少、低频写、端上「有值才展示」。JSON 列零额外表、不进 parity 表数。
 *
 * ## 字段形态
 *
 * `label_info` = `Record<string, string>`，例如：
 * ```
 * { "品名":"康师傅冰红茶", "净含量":"500mL", "配料表":"水、白砂糖…",
 *   "保质期":"12个月", "贮存条件":"常温避光", "生产者名称":"…",
 *   "生产许可证编号":"SC…", "产品标准代号":"GB/T 21733" }
 * ```
 * `NULL` = 未登记。`fmcg`（独立预包装单品）应逐个补齐；`meal`（现做菜）留空 ——
 * 于是「以后不改代码开盒饭」天然成立：饭类没有这列值，端上整段自动隐藏。
 *
 * ## ⚠️ 与实体逐列一致（schema:parity 判据）
 *
 * 实体在 `entities/supplier.entity.ts` 的 `Item`：`type:'json'`, `nullable:true`,
 * 列名 `label_info`。本地 sqlite 由实体 synchronize 建表，生产由本迁移加列，
 * 两侧不齐 `schema:parity` 会转红。
 *
 * ## 幂等
 *
 * `columnExists` 守护；`down()` 对称删除列。MySQL 8 不支持 `IF NOT EXISTS` 形式，
 * 故必须逐项查 `information_schema`。
 */

const ADD_COLUMN = `ALTER TABLE \`ab_item\`
  ADD COLUMN \`label_info\` JSON NULL
  COMMENT '预包装食品标签（GB 7718）键值对 JSON；NULL=未登记，meal 类单品留空'`;

export class ItemLabelInfo1700000000025 implements MigrationInterface {
  name = 'ItemLabelInfo1700000000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await columnExists(queryRunner, 'ab_item', 'label_info')) {
      console.log('   ↳ ItemLabelInfo：label_info 已存在，跳过');
      return;
    }
    await queryRunner.query(ADD_COLUMN);
    console.log('   ↳ ItemLabelInfo：ab_item 增列 label_info（JSON）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await columnExists(queryRunner, 'ab_item', 'label_info')) {
      await queryRunner.query('ALTER TABLE `ab_item` DROP COLUMN `label_info`');
      console.log('   ↳ ItemLabelInfo：ab_item 删列 label_info');
    }
  }
}
