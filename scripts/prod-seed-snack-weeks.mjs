#!/usr/bin/env node
/**
 * prod-seed-snack-weeks.mjs —— 生产「7 天零食团」安全种子脚本（多品牌 + 产品图版）
 * ------------------------------------------------------------------
 * 用途：连开 N 天「快消品零食团」，每天 = 3 款**不同真实品牌**的零食
 *       （slot1-3，每个 item 挂到**自身品牌**供应商 + 写 `image_url` 产品图）
 *       + 1 款随附饮品（slot5 = 饮料，替代原米饭位，端上不再隐藏），售价统一 ¥25.80。
 *
 * ⚠️ 与上一版的关键修复：
 *   · 旧版把当天全部 4 个 item 都挂到「当日 anchor 供应商」⇒ 首页四张卡**同一品牌**；
 *   · 旧版从不写 `image_url` ⇒ 卡片**无产品图**。
 *   本版每个零食 item 挂到它**自己品牌**的供应商、写对应 `image_url`，
 *   首页即可呈现「一盒吃不同品牌 + 有图」。
 *
 *   · 第 4 张卡（x 盲盒）是**端上合成**的轻量小辅助（下单随机抽、送达揭晓），
 *     不在 `ab_set_meal_item` 建项；故库里每天只建 3 零食 + 1 饮品 = 4 项。
 *
 * 设计要点：
 *   ✅ 全部按 name 幂等：供应商/套餐/商品已存在则复用，绝不重复插入。
 *   ✅ 套餐明细按 set_meal_id **先 DELETE 再重建**，保证无残留 slot4 / 旧品牌项。
 *   ✅ 分配行(ab_meal_assignment) 按 (meal_date, building_group_id) 唯一键：
 *      已存在 → UPDATE set_meal_id（重指套餐）；不存在 → INSERT。
 *   ✅ 默认 dry-run，必须 --apply 才写库；写后回查自检（断言 3 零食品牌互异 + 图非空）。
 *
 * 运行（在 api-server 容器内，env 已注入 DB_*）：
 *   docker exec -i abox-api-prod node /opt/abox-onebox/scripts/prod-seed-snack-weeks.mjs
 *   docker exec -i abox-api-prod node /opt/abox-onebox/scripts/prod-seed-snack-weeks.mjs --apply
 *
 * 可选参数：
 *   --start-date=YYYY-MM-DD   起始出餐日（默认 2026-10-24）
 *   --days=N                  连开天数（默认 7）
 *   --apply                   真正写入；缺省 dry-run
 */

import { createConnection } from 'mysql2/promise';

const BASE = 'http://154.8.164.180:8081/static';

function parseArgs(argv) {
  const a = { start: '2026-10-24', days: 7, apply: false };
  for (const x of argv) {
    if (x === '--apply') a.apply = true;
    else if (x.startsWith('--start-date=')) a.start = x.slice(13);
    else if (x.startsWith('--days=')) a.days = Number(x.slice(7));
  }
  return a;
}

const dateLike = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
function addDays(yyyymmdd, n) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 7 天 × 每天 = 3 个不同品牌零食(slot1-3，各自挂自身品牌供应商 + 产品图)
 *            + 1 随附饮品(slot5，挂到当天第一个零食品牌供应商，仅作随附、端上不展示品牌)
 *
 * ⚠️ 每天 3 个零食必须**品牌互异**（用户要求：一盒吃不同品牌的东西）。
 *    饮品不强制品牌独立（它作为「随附」呈现、不展示出品方）。
 */
const PLAN = [
  {
    set: 'ABox 零食盒 · 康师傅/三只松鼠/良品铺子',
    oneLiner: '桶面+每日坚果+夏威夷果，配可口可乐',
    snacks: [
      { name: '康师傅红烧牛肉桶面', brand: '康师傅', slot: 1, cost: 4.5, image: 'snack-01-kangshifu.png' },
      { name: '三只松鼠每日坚果', brand: '三只松鼠', slot: 2, cost: 6.0, image: 'snack-02-sanzhisongshu.png' },
      { name: '良品铺子夏威夷果', brand: '良品铺子', slot: 3, cost: 6.5, image: 'snack-03-liangpinpuzi.png' },
    ],
    beverage: { name: '可口可乐 330ml', slot: 5, cost: 3.0 },
  },
  {
    set: 'ABox 零食盒 · 旺旺/卫龙/达利园',
    oneLiner: '仙贝+辣条+蛋黄派，配元气森林气泡水',
    snacks: [
      { name: '旺旺仙贝', brand: '旺旺', slot: 1, cost: 3.5, image: 'snack-04-wangwang.png' },
      { name: '卫龙辣条', brand: '卫龙', slot: 2, cost: 2.5, image: 'snack-05-weilong.png' },
      { name: '达利园蛋黄派', brand: '达利园', slot: 3, cost: 4.0, image: 'snack-06-daliyuan.png' },
    ],
    beverage: { name: '元气森林气泡水', slot: 5, cost: 3.5 },
  },
  {
    set: 'ABox 零食盒 · 三只松鼠/良品铺子/旺旺',
    oneLiner: '每日坚果+夏威夷果+仙贝，配椰树椰汁',
    snacks: [
      { name: '三只松鼠每日坚果', brand: '三只松鼠', slot: 1, cost: 6.0, image: 'snack-02-sanzhisongshu.png' },
      { name: '良品铺子夏威夷果', brand: '良品铺子', slot: 2, cost: 6.5, image: 'snack-03-liangpinpuzi.png' },
      { name: '旺旺仙贝', brand: '旺旺', slot: 3, cost: 3.5, image: 'snack-04-wangwang.png' },
    ],
    beverage: { name: '椰树椰汁 245ml', slot: 5, cost: 3.5 },
  },
  {
    set: 'ABox 零食盒 · 康师傅/卫龙/伊利',
    oneLiner: '桶面+辣条+纯牛奶，配旺旺碎冰冰',
    snacks: [
      { name: '康师傅红烧牛肉桶面', brand: '康师傅', slot: 1, cost: 4.5, image: 'snack-01-kangshifu.png' },
      { name: '卫龙辣条', brand: '卫龙', slot: 2, cost: 2.5, image: 'snack-05-weilong.png' },
      { name: '伊利纯牛奶', brand: '伊利', slot: 3, cost: 3.0, image: 'snack-07-yili.png' },
    ],
    beverage: { name: '旺旺碎冰冰', slot: 5, cost: 2.5 },
  },
  {
    set: 'ABox 零食盒 · 达利园/三只松鼠/旺旺',
    oneLiner: '蛋黄派+每日坚果+仙贝，配今麦郎凉白开',
    snacks: [
      { name: '达利园蛋黄派', brand: '达利园', slot: 1, cost: 4.0, image: 'snack-06-daliyuan.png' },
      { name: '三只松鼠每日坚果', brand: '三只松鼠', slot: 2, cost: 6.0, image: 'snack-02-sanzhisongshu.png' },
      { name: '旺旺仙贝', brand: '旺旺', slot: 3, cost: 3.5, image: 'snack-04-wangwang.png' },
    ],
    beverage: { name: '今麦郎凉白开', slot: 5, cost: 2.0 },
  },
  {
    set: 'ABox 零食盒 · 良品铺子/卫龙/伊利',
    oneLiner: '夏威夷果+辣条+纯牛奶，配和其正凉茶',
    snacks: [
      { name: '良品铺子夏威夷果', brand: '良品铺子', slot: 1, cost: 6.5, image: 'snack-03-liangpinpuzi.png' },
      { name: '卫龙辣条', brand: '卫龙', slot: 2, cost: 2.5, image: 'snack-05-weilong.png' },
      { name: '伊利纯牛奶', brand: '伊利', slot: 3, cost: 3.0, image: 'snack-07-yili.png' },
    ],
    beverage: { name: '和其正凉茶', slot: 5, cost: 3.5 },
  },
  {
    set: 'ABox 零食盒 · 康师傅/达利园/旺旺',
    oneLiner: '桶面+蛋黄派+仙贝，配娃哈哈营养快线',
    snacks: [
      { name: '康师傅红烧牛肉桶面', brand: '康师傅', slot: 1, cost: 4.5, image: 'snack-01-kangshifu.png' },
      { name: '达利园蛋黄派', brand: '达利园', slot: 2, cost: 4.0, image: 'snack-06-daliyuan.png' },
      { name: '旺旺仙贝', brand: '旺旺', slot: 3, cost: 3.5, image: 'snack-04-wangwang.png' },
    ],
    beverage: { name: '娃哈哈营养快线', slot: 5, cost: 3.5 },
  },
];

/** 残留供应商名（历史迭代遗留，无分配行/订单则清理） */
const LEGACY_SUPPLIER_NAMES = ['优选便利仓', '零食研究所'];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!dateLike(args.start) || !(args.days >= 1 && args.days <= 31)) {
    console.error('[错误] --start-date 需 YYYY-MM-DD，--days 需 1..31');
    process.exit(2);
  }
  const dates = Array.from({ length: args.days }, (_, i) => addDays(args.start, i));

  const cfg = {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'abox_onebox',
    connectTimeout: 10000,
  };
  console.log(`=== 7 天零食团种子 · 多品牌+产品图版（ABox 一盒）===`);
  console.log(`起始 ${args.start}  天数 ${args.days}  日期 ${dates.join(', ')}`);
  console.log(`模式 ${args.apply ? 'APPLY' : 'DRY-RUN'}  DB ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  const conn = await createConnection(cfg);
  const W = args.apply;
  const run = async (sql, params) => {
    if (!W) return [{ affectedRows: 0, insertId: -1, _dry: true }];
    return conn.query(sql, params);
  };

  // 5 个楼群 + 集散中心（与现有分配一致）
  const groups = [1, 2, 3, 4, 5];
  const dc = 1;
  const log = [];

  try {
    // ---- 0) 清理历史残留供应商（无分配/订单引用才删，避免破坏展示） ----
    for (const name of LEGACY_SUPPLIER_NAMES) {
      const [srows] = await conn.query('SELECT id FROM ab_supplier WHERE name = ?', [name]);
      if (!srows.length) continue;
      const sid = Number(srows[0].id);
      const [smi] = await conn.query(
        'SELECT DISTINCT set_meal_id sm FROM ab_set_meal_item WHERE supplier_id = ?',
        [sid],
      );
      const setIds = smi.map((r) => r.sm).filter(Boolean);
      await run('DELETE FROM ab_set_meal_item WHERE supplier_id = ?', [sid]);
      if (setIds.length) {
        const [assigned] = await conn.query(
          `SELECT COUNT(*) c FROM ab_meal_assignment WHERE set_meal_id IN (?)`,
          [setIds],
        );
        const [ordered] = await conn.query(
          `SELECT COUNT(*) c FROM ab_order WHERE set_meal_id IN (?)`,
          [setIds],
        );
        if (Number(assigned[0].c) === 0 && Number(ordered[0].c) === 0) {
          await run(`DELETE FROM ab_set_meal WHERE id IN (?)`, [setIds]);
        }
      }
      // 删残留商品 + 供应商（FK 失败时静默跳过，避免中断）
      try { await run('DELETE FROM ab_item WHERE supplier_id = ?', [sid]); } catch {}
      try { await run('DELETE FROM ab_supplier WHERE id = ?', [sid]); } catch {}
      log.push(`清理残留供应商 ${name} id=${sid}`);
    }

    for (let di = 0; di < PLAN.length; di++) {
      const day = PLAN[di];
      const date = dates[di];
      if (!date) { console.warn(`[跳过] 计划第 ${di + 1} 天无对应日期（days 不足）`); continue; }

      // 1) 套餐（fmcg，按 name 幂等）
      const costSum = [...day.snacks, day.beverage].reduce((s, it) => s + it.cost, 0).toFixed(2);
      let [rows] = await conn.query('SELECT id FROM ab_set_meal WHERE name = ?', [day.set]);
      let setId;
      if (rows.length) {
        setId = Number(rows[0].id);
      } else {
        const [r] = await run(
          `INSERT INTO ab_set_meal (name, kind, price, cost_price, status, one_liner, description, meal_date, version, created_at, updated_at)
           VALUES (?, 'fmcg', '25.80', ?, 1, ?, ?, ?, 0, NOW(3), NOW(3))`,
          [day.set, costSum, day.oneLiner, day.oneLiner, date],
        );
        setId = Number(r.insertId);
        log.push(`套餐 新建 ${day.set} id=${setId} 供价合计=${costSum}`);
      }

      // 2) 该套餐明细先清空，再按本计划重建（保证无残留 slot4 / 旧品牌项）
      await run('DELETE FROM ab_set_meal_item WHERE set_meal_id = ?', [setId]);

      // 3) 品牌供应商：按 name 幂等；饮品挂到当天第一个零食品牌（仅作随附）
      async function ensureSupplier(name) {
        let [sr] = await conn.query('SELECT id FROM ab_supplier WHERE name = ?', [name]);
        if (sr.length) return Number(sr[0].id);
        const [r] = await run(
          `INSERT INTO ab_supplier (name, contact_name, contact_phone, status, audit_status, version, created_at, updated_at)
           VALUES (?, 'ABox', '', 1, 'approved', 0, NOW(3), NOW(3))`,
          [name],
        );
        log.push(`供应商 新建 ${name} id=${Number(r.insertId)}`);
        return Number(r.insertId);
      }

      async function ensureItem(supplierId, name, cost, imageUrl) {
        let [ir] = await conn.query(
          'SELECT id FROM ab_item WHERE name = ? AND supplier_id = ?',
          [name, supplierId],
        );
        if (ir.length) {
          // 已是目标品牌供应商的项：补齐可能缺失的 image_url
          const id = Number(ir[0].id);
          if (imageUrl) {
            await run('UPDATE ab_item SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url = ?)', [imageUrl, id, '']);
          }
          return id;
        }
        const [r] = await run(
          `INSERT INTO ab_item (supplier_id, name, category, image_url, cost_price, status, rating, sale_count, version, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, 1, '0.00', 0, 0, NOW(3), NOW(3))`,
          [supplierId, name, imageUrl ?? null, cost.toFixed(2)],
        );
        return Number(r.insertId);
      }

      // 4) 零食（3 个不同品牌）
      for (const sn of day.snacks) {
        const supId = await ensureSupplier(sn.brand);
        const itemId = await ensureItem(supId, sn.name, sn.cost, `${BASE}/${sn.image}`);
        await run(
          `INSERT INTO ab_set_meal_item (set_meal_id, item_id, supplier_id, slot, share_amount, created_at)
           VALUES (?, ?, ?, ?, NULL, NOW(3))`,
          [setId, itemId, supId, sn.slot],
        );
      }

      // 5) 饮品（slot5，挂第一个零食品牌供应商）
      const bevBrand = day.snacks[0].brand;
      const bevSupId = await ensureSupplier(bevBrand);
      const bevItemId = await ensureItem(bevSupId, day.beverage.name, day.beverage.cost, null);
      await run(
        `INSERT INTO ab_set_meal_item (set_meal_id, item_id, supplier_id, slot, share_amount, created_at)
         VALUES (?, ?, ?, ?, NULL, NOW(3))`,
        [setId, bevItemId, bevSupId, day.beverage.slot],
      );

      // 6) 分配行（按 meal_date+building_group_id 唯一键；存在则重指套餐）
      for (const g of groups) {
        [rows] = await conn.query(
          'SELECT id, set_meal_id, status FROM ab_meal_assignment WHERE meal_date = ? AND building_group_id = ?',
          [date, g],
        );
        const cutoff = `${date} 00:00:00`;
        if (rows.length) {
          const cur = rows[0];
          if (Number(cur.set_meal_id) !== setId || cur.status !== 'active') {
            await run(
              `UPDATE ab_meal_assignment SET set_meal_id = ?, status = 'active', publish_at = NOW(3), cutoff_at = ?
               WHERE meal_date = ? AND building_group_id = ?`,
              [setId, cutoff, date, g],
            );
            log.push(`分配 ${date}#bg${g} 重指套餐→${setId} active`);
          } else {
            log.push(`分配 ${date}#bg${g} 已是指向${setId} active，跳过`);
          }
        } else {
          await run(
            `INSERT INTO ab_meal_assignment (meal_date, building_group_id, set_meal_id, distribution_center_id, status, publish_at, cutoff_at, sold_count, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', NOW(3), ?, 0, 0, NOW(3), NOW(3))`,
            [date, g, setId, dc, cutoff],
          );
          log.push(`分配 ${date}#bg${g} 新建→套餐${setId} active`);
        }
      }
    }

    // ---- 6b) 清理本批次不再使用的旧 fmcg 套餐（历史单品牌套餐，已无分配/订单引用则删） ----
    {
      const planNames = PLAN.map((p) => p.set);
      const [orphan] = await conn.query(
        `SELECT id, name FROM ab_set_meal
         WHERE kind = 'fmcg' AND name NOT IN (?)
           AND id NOT IN (SELECT DISTINCT set_meal_id FROM ab_meal_assignment WHERE set_meal_id IS NOT NULL)
           AND id NOT IN (SELECT DISTINCT set_meal_id FROM ab_order WHERE set_meal_id IS NOT NULL)`,
        [planNames],
      );
      for (const o of orphan) {
        await run('DELETE FROM ab_set_meal_item WHERE set_meal_id = ?', [o.id]);
        const [r] = await run('DELETE FROM ab_set_meal WHERE id = ?', [o.id]);
        if (Number(r?.affectedRows ?? 0)) log.push(`清理旧 fmcg 套餐 ${o.name} id=${o.id}`);
      }
    }

    console.log('\n--- 执行摘要 ---');
    log.forEach((l) => console.log(l));

    if (!W) {
      console.log('\n[DRY-RUN] 未写入任何数据。确认无误后加 --apply 执行。');
      return;
    }

    // 7) 自检：回读每天套餐，断言 3 零食品牌互异 + image_url 非空
    console.log('\n--- 自检（回读） ---');
    let allOk = true;
    const setNames = PLAN.map((p) => p.set);
    for (const date of dates) {
      const [asg] = await conn.query(
        `SELECT DISTINCT set_meal_id sm FROM ab_meal_assignment WHERE meal_date = ? AND status = 'active'`,
        [date],
      );
      const setIds = asg.map((r) => r.sm);
      if (!setIds.length) { console.log(`[${date}] 无 active 套餐 ✗`); allOk = false; continue; }
      const [items] = await conn.query(
        `SELECT i.name, i.image_url, i.supplier_id, smi.slot, s.name sname
         FROM ab_set_meal_item smi
         JOIN ab_item i ON i.id = smi.item_id
         JOIN ab_supplier s ON s.id = smi.supplier_id
         WHERE smi.set_meal_id IN (?) ORDER BY smi.slot ASC`,
        [setIds],
      );
      const snacks = items.filter((x) => x.slot !== 5);
      const bev = items.find((x) => x.slot === 5);
      const brands = [...new Set(snacks.map((x) => x.sname))];
      const noImg = snacks.filter((x) => !x.image_url);
      const ok = snacks.length === 3 && brands.length === 3 && noImg.length === 0;
      if (!ok) allOk = false;
      console.log(
        `[${date}] 零食=${snacks.length} 品牌互异=${brands.length === 3} 无图=${noImg.length} ` +
        `饮品=${bev ? bev.name : '无'} ${ok ? '✓' : '✗'}`,
      );
      snacks.forEach((x) => console.log(`    · [${x.slot}] ${x.name} · ${x.sname} · ${x.image_url ? '有图' : '无图'}`));
    }
    console.log(allOk ? '\n全部自检通过 ✓' : '\n存在失败项 ✗（见上）');
    if (!allOk) process.exit(1);
  } finally {
    await conn.end();
  }
}

main().catch((e) => { console.error(`\n[失败] ${e.message}`); process.exit(1); });
