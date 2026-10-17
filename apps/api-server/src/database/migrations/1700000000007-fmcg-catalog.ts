import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 去餐化 · 快消品套餐目录（2026-10-15）
 *
 * ① 给 `ab_set_meal` 补 `kind` 列（meal 饭类 / fmcg 快消品）；
 * ② 写入 2 个快消品供应商、8 个快消品商品、2 个快消品套餐模板及明细。
 *
 * 幂等：列已存在则跳过 ALTER；fmcg 供应商已存在则整段跳过（本地 seed 已写入时不会重复）。
 * 下游「试投脚本」只需按 name/kind 找到这些模板即可，不依赖此处写死的 id。
 */
export class FmcgCatalog1700000000007 implements MigrationInterface {
  name = 'FmcgCatalog1700000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- ① 补列（幂等）----
    const col = await queryRunner.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ab_set_meal' AND COLUMN_NAME = 'kind'`,
    );
    if (!Array.isArray(col) || col.length === 0) {
      await queryRunner.query(
        `ALTER TABLE ab_set_meal ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'meal'
         COMMENT 'meal 饭类套餐 / fmcg 快消品套餐（去餐化·2026-10-15）'`,
      );
    }

    // ---- ② 目录（幂等：本地 seed 已写入则跳过）----
    const existing = await queryRunner.query(
      `SELECT id FROM ab_supplier WHERE name IN ('优选便利仓','零食研究所') LIMIT 1`,
    );
    if (Array.isArray(existing) && existing.length > 0) return;

    const supConvenience = await this.insertSupplier(queryRunner, '优选便利仓');
    const supSnack = await this.insertSupplier(queryRunner, '零食研究所');

    const items: Array<{ sid: number; name: string; cost: string }> = [
      { sid: supConvenience, name: '红烧牛肉面', cost: '4.50' },
      { sid: supConvenience, name: '鲜虾鱼板面', cost: '4.50' },
      { sid: supConvenience, name: '冰镇酸梅汤', cost: '2.00' },
      { sid: supConvenience, name: '手冲挂耳咖啡', cost: '3.00' },
      { sid: supSnack, name: '海盐薯片', cost: '3.00' },
      { sid: supSnack, name: '每日坚果', cost: '4.00' },
      { sid: supSnack, name: '乳酸菌小软糖', cost: '2.50' },
      { sid: supSnack, name: '手工曲奇', cost: '3.50' },
    ];
    const itemMap = new Map<string, { id: number; cost: string }>();
    for (const it of items) {
      const id = await this.insertItem(queryRunner, it.sid, it.name, it.cost);
      itemMap.set(it.name, { id, cost: it.cost });
    }

    await this.insertTemplate(
      queryRunner,
      '泡面宵夜包',
      '夜宵也能很讲究',
      [
        { name: '红烧牛肉面', slot: 1 },
        { name: '鲜虾鱼板面', slot: 2 },
        { name: '手冲挂耳咖啡', slot: 3 },
        { name: '冰镇酸梅汤', slot: 4 },
      ],
      itemMap,
      supConvenience,
    );

    await this.insertTemplate(
      queryRunner,
      '零食能量包',
      '办公室的能量补给站',
      [
        { name: '海盐薯片', slot: 1 },
        { name: '每日坚果', slot: 2 },
        { name: '乳酸菌小软糖', slot: 3 },
        { name: '手工曲奇', slot: 4 },
      ],
      itemMap,
      supSnack,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM ab_set_meal_item WHERE set_meal_id IN (SELECT id FROM ab_set_meal WHERE kind = 'fmcg')`,
    );
    await queryRunner.query(`DELETE FROM ab_set_meal WHERE kind = 'fmcg'`);
    await queryRunner.query(
      `DELETE FROM ab_item WHERE supplier_id IN
       (SELECT id FROM ab_supplier WHERE name IN ('优选便利仓','零食研究所'))`,
    );
    await queryRunner.query(`DELETE FROM ab_supplier WHERE name IN ('优选便利仓','零食研究所')`);
    const col = await queryRunner.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ab_set_meal' AND COLUMN_NAME = 'kind'`,
    );
    if (Array.isArray(col) && col.length > 0) {
      await queryRunner.query(`ALTER TABLE ab_set_meal DROP COLUMN kind`);
    }
  }

  private async insertSupplier(qr: QueryRunner, name: string): Promise<number> {
    await qr.query(
      `INSERT INTO ab_supplier
       (name, contact_name, contact_phone, type, audit_status, payee_type, status, total_served, share_rate, version, created_at, updated_at)
       VALUES (?, 'ABox便利店', '13800000000', 'dish', 'approved', 'corporate', 1, 0, 0, 0, NOW(), NOW())`,
      [name],
    );
    const r = await qr.query(`SELECT LAST_INSERT_ID() AS id`);
    return r[0].id;
  }

  private async insertItem(
    qr: QueryRunner,
    supplierId: number,
    name: string,
    cost: string,
  ): Promise<number> {
    await qr.query(
      `INSERT INTO ab_item
       (supplier_id, name, cost_price, status, sale_count, rating, version, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, '0.00', 0, NOW(), NOW())`,
      [supplierId, name, cost],
    );
    const r = await qr.query(`SELECT LAST_INSERT_ID() AS id`);
    return r[0].id;
  }

  private async insertTemplate(
    qr: QueryRunner,
    name: string,
    oneLiner: string,
    lines: Array<{ name: string; slot: number }>,
    itemMap: Map<string, { id: number; cost: string }>,
    supplierId: number,
  ): Promise<void> {
    const cost = lines.reduce((s, l) => s + Number(itemMap.get(l.name)?.cost ?? 0), 0).toFixed(2);
    await qr.query(
      `INSERT INTO ab_set_meal
       (name, price, cost_price, one_liner, status, version, kind, created_at, updated_at)
       VALUES (?, '25.80', ?, ?, 1, 0, 'fmcg', NOW(), NOW())`,
      [name, cost, oneLiner],
    );
    const smId = (await qr.query(`SELECT LAST_INSERT_ID() AS id`))[0].id;
    for (const l of lines) {
      const ref = itemMap.get(l.name)!;
      await qr.query(
        `INSERT INTO ab_set_meal_item
         (set_meal_id, item_id, supplier_id, slot, share_amount, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [smId, ref.id, supplierId, l.slot, ref.cost],
      );
    }
  }
}
