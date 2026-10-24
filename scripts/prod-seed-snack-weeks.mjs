#!/usr/bin/env node
/**
 * prod-seed-snack-weeks.mjs —— 生产「7 天零食团」安全种子脚本
 * ------------------------------------------------------------------
 * 用途：连开 N 天「快消品零食团」，每天一个不同的品牌商（供应商），
 *       每套 = 4 款不同品牌零食 + 1 款随附饮品（slot 5 = 饮料，替代原米饭位，
 *       端上不再隐藏），售价统一 ¥25.80。
 *
 * 设计要点：
 *   ✅ 全部按 name 幂等：供应商/套餐/商品已存在则复用，绝不重复插入。
 *   ✅ 分配行(ab_meal_assignment) 按 (meal_date, building_group_id) 唯一键：
 *      已存在 → UPDATE set_meal_id（重指套餐，即「重定义当日团」）；不存在 → INSERT。
 *   ✅ 默认 dry-run，必须 --apply 才写库；写后回查自检。
 *   ✅ 门店图(store_photos) / 资质(business_license/food_license) 本批留 NULL，
 *      由后续图片脚本单独回填（保持本脚本纯数据、可反复跑）。
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

// 7 天 × 不同品牌商；每套 4 零食(slot1-4) + 1 随附饮品(slot5)
const PLAN = [
  {
    supplier: '康师傅', set: '康师傅宵夜泡面包', oneLiner: '桶面+肠+鱼罐头+凤爪，配可乐',
    items: [
      ['康师傅红烧牛肉桶面', 1, 4.5], ['双汇王中王鸡腿肠', 2, 3.0],
      ['鹰金钱豆豉鲮鱼罐头', 3, 8.0], ['有友泡椒凤爪', 4, 4.5],
      ['可口可乐 330ml', 5, 3.0],
    ],
  },
  {
    supplier: '三只松鼠', set: '三只松鼠坚果解馋包', oneLiner: '坚果+肉脯+芒果干+仙贝，配气泡水',
    items: [
      ['三只松鼠每日坚果', 1, 6.0], ['良品铺子猪肉脯', 2, 5.0],
      ['百草味芒果干', 3, 4.5], ['旺旺仙贝', 4, 3.5],
      ['元气森林气泡水', 5, 3.5],
    ],
  },
  {
    supplier: '良品铺子', set: '良品铺子午后茶点包', oneLiner: '夏威夷果+辣条+海苔+小面包，配椰汁',
    items: [
      ['良品铺子夏威夷果', 1, 6.5], ['三只松鼠辣条', 2, 2.5],
      ['波力海苔', 3, 2.0], ['达利园小面包', 4, 3.0],
      ['椰树椰汁 245ml', 5, 3.5],
    ],
  },
  {
    supplier: '旺旺', set: '旺旺童年回忆包', oneLiner: '仙贝+雪饼+八宝粥+养乐多，配碎冰冰',
    items: [
      ['旺旺仙贝', 1, 3.5], ['旺旺雪饼', 2, 3.5],
      ['银鹭八宝粥', 3, 4.0], ['养乐多', 4, 3.0],
      ['旺旺碎冰冰', 5, 2.5],
    ],
  },
  {
    supplier: '卫龙', set: '卫龙麻辣过瘾包', oneLiner: '辣条+亲嘴烧+方便面+豆豉，配凉白开',
    items: [
      ['卫龙辣条', 1, 2.5], ['卫龙亲嘴烧', 2, 2.5],
      ['白象多半袋方便面', 3, 4.0], ['老干妈风味豆豉', 4, 4.5],
      ['今麦郎凉白开', 5, 2.0],
    ],
  },
  {
    supplier: '达利园', set: '达利园早餐饱腹包', oneLiner: '蛋黄派+小面包+薯片+纯牛奶，配凉茶',
    items: [
      ['达利园蛋黄派', 1, 4.0], ['达利园小面包', 2, 3.0],
      ['可比克薯片', 3, 3.5], ['伊利纯牛奶', 4, 3.0],
      ['和其正凉茶', 5, 3.5],
    ],
  },
  {
    supplier: '伊利', set: '伊利营养元气包', oneLiner: '纯牛奶+酸奶+面包+沙琪玛，配营养快线',
    items: [
      ['伊利纯牛奶', 1, 3.0], ['伊利安慕希酸奶', 2, 4.5],
      ['桃李醇熟面包', 3, 3.5], ['徐福记沙琪玛', 4, 3.5],
      ['娃哈哈营养快线', 5, 3.5],
    ],
  },
];

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
  console.log(`=== 7 天零食团种子（ABox 一盒）===`);
  console.log(`起始 ${args.start}  天数 ${args.days}  日期 ${dates.join(', ')}`);
  console.log(`模式 ${args.apply ? 'APPLY' : 'DRY-RUN'}  DB ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  const conn = await createConnection(cfg);
  const W = args.apply;
  const run = async (sql, params) => {
    if (!W) return { affectedRows: 0, insertId: -1, _dry: true };
    return conn.query(sql, params);
  };

  // 5 个楼群 + 集散中心 1（与现有分配一致）
  const groups = [1, 2, 3, 4, 5];
  const dc = 1;

  const log = [];
  try {
    for (let di = 0; di < PLAN.length; di++) {
      const day = PLAN[di];
      const date = dates[di];
      if (!date) { console.warn(`[跳过] 计划第 ${di + 1} 天无对应日期（days 不足）`); continue; }

      // 1) 供应商（按 name 幂等）
      let [rows] = await conn.query('SELECT id FROM ab_supplier WHERE name = ?', [day.supplier]);
      let supplierId;
      if (rows.length) {
        supplierId = Number(rows[0].id);
      } else {
        const r = await run(
          `INSERT INTO ab_supplier (name, contact_name, contact_phone, status, audit_status, version, created_at, updated_at)
           VALUES (?, 'ABox', '', 1, 'approved', 0, NOW(3), NOW(3))`,
          [day.supplier],
        );
        supplierId = Number(r.insertId);
        log.push(`供应商 新建 ${day.supplier} id=${supplierId}`);
      }

      // 2) 套餐（fmcg，按 name 幂等）
      const costSum = day.items.reduce((s, it) => s + it[2], 0).toFixed(2);
      [rows] = await conn.query('SELECT id FROM ab_set_meal WHERE name = ?', [day.set]);
      let setId;
      if (rows.length) {
        setId = Number(rows[0].id);
      } else {
        const r = await run(
          `INSERT INTO ab_set_meal (name, kind, price, cost_price, status, one_liner, description, meal_date, version, created_at, updated_at)
           VALUES (?, 'fmcg', '25.80', ?, 1, ?, ?, ?, 0, NOW(3), NOW(3))`,
          [day.set, costSum, day.oneLiner, day.oneLiner, date],
        );
        setId = Number(r.insertId);
        log.push(`套餐 新建 ${day.set} id=${setId} 供价合计=${costSum}`);
      }

      // 3) 商品（按 name+supplier 幂等）+ 套餐商品明细
      for (const [name, slot, cost] of day.items) {
        [rows] = await conn.query('SELECT id FROM ab_item WHERE name = ? AND supplier_id = ?', [name, supplierId]);
        let itemId;
        if (rows.length) {
          itemId = Number(rows[0].id);
        } else {
          const r = await run(
            `INSERT INTO ab_item (supplier_id, name, category, cost_price, status, rating, sale_count, version, created_at, updated_at)
             VALUES (?, ?, NULL, ?, 1, '0.00', 0, 0, NOW(3), NOW(3))`,
            [supplierId, name, cost.toFixed(2)],
          );
          itemId = Number(r.insertId);
        }
        // 明细幂等（INSERT IGNORE）
        await run(
          `INSERT IGNORE INTO ab_set_meal_item (set_meal_id, item_id, supplier_id, slot, share_amount, created_at)
           VALUES (?, ?, ?, ?, NULL, NOW(3))`,
          [setId, itemId, supplierId, slot],
        );
      }

      // 4) 分配行（按 meal_date+building_group_id 唯一键；存在则重指套餐）
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

    console.log('\n--- 执行摘要 ---');
    log.forEach((l) => console.log(l));

    if (!W) {
      console.log('\n[DRY-RUN] 未写入任何数据。确认无误后加 --apply 执行。');
      return;
    }

    // 5) 自检
    for (const date of dates) {
      const [n] = await conn.query(
        `SELECT COUNT(*) c, GROUP_CONCAT(DISTINCT set_meal_id) sm FROM ab_meal_assignment WHERE meal_date = ?`,
        [date],
      );
      console.log(`[自检] ${date}: 分配行 ${Number(n[0].c)}，套餐集 {${n[0].sm}}`);
    }
    console.log('\n完成。前端需展示 slot5=随附饮品（已随后端 fmcg 改造生效）。');
  } finally {
    await conn.end();
  }
}

main().catch((e) => { console.error(`\n[失败] ${e.message}`); process.exit(1); });
