#!/usr/bin/env node
/**
 * prod-update-supplier-snack-media.mjs —— 7 天零食团供应商图片/资质回填（幂等）
 * ------------------------------------------------------------------
 * 用途：把 AI 生成的「标品化零售包装」实拍风图 + 许可证示例图回填到
 *       ab_supplier(id 14-20) 的 store_photos（照片墙）与
 *       business_license / food_license（资质编号，DEMO 标记，非真实证照）。
 *
 * 幂等性：按 supplier name 定位 id；UPDATE 直接整组覆盖（可反复执行）。
 * 图片托管：http://154.8.164.180:8081/static/（容器 /app/data/uploads，api-uploads 卷）。
 *
 * 运行（在 api-server 容器内，env 已注入 DB_*）：
 *   docker exec abox-api-prod node /app/scripts/prod-update-supplier-snack-media.mjs          # dry-run
 *   docker exec abox-api-prod node /app/scripts/prod-update-supplier-snack-media.mjs --apply  # 写入
 */

import { createConnection } from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const BASE = 'http://154.8.164.180:8081/static';

// 7 品牌 → 标品图（均为密封零售包装，非餐饮摆盘）
const PLAN = [
  { name: '康师傅',   photos: [{ file: 'snack-01-kangshifu.png',      caption: '桶装泡面 · 零售标品' }] },
  { name: '三只松鼠', photos: [{ file: 'snack-02-sanzhisongshu.png',  caption: '每日坚果包 · 零售标品' }] },
  { name: '良品铺子', photos: [{ file: 'snack-03-liangpinpuzi.png',   caption: '夏威夷果袋装 · 零售标品' }] },
  { name: '旺旺',     photos: [{ file: 'snack-04-wangwang.png',       caption: '仙贝雪饼 · 零售标品' }] },
  { name: '卫龙',     photos: [{ file: 'snack-05-weilong.png',        caption: '辣条袋装 · 零售标品' }] },
  { name: '达利园',   photos: [
      { file: 'snack-06-daliyuan.png',       caption: '蛋黄派盒装 · 零售标品' },
      { file: 'snack-06b-daliyuan-bread.png', caption: '小面包袋装 · 零售标品' },
  ] },
  { name: '伊利',     photos: [{ file: 'snack-07-yili.png',           caption: '纯牛奶+酸奶 · 零售标品' }] },
];

async function main() {
  const cfg = {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'abox_onebox',
    connectTimeout: 10000,
  };
  console.log(`=== 供应商零食团图片/资质回填（${APPLY ? 'APPLY' : 'DRY-RUN'}）===`);

  const conn = await createConnection(cfg);
  const results = [];
  try {
    for (const p of PLAN) {
      const [rows] = await conn.query('SELECT id, name, store_photos FROM ab_supplier WHERE name = ? AND deleted_at IS NULL', [p.name]);
      if (!rows.length) {
        console.error(`[缺失] 供应商「${p.name}」不存在，跳过（请先跑 prod-seed-snack-weeks.mjs --apply）`);
        results.push({ name: p.name, ok: false });
        continue;
      }
      const id = Number(rows[0].id);
      const photos = [
        ...p.photos.map((x) => ({ url: `${BASE}/${x.file}`, category: 'product', caption: x.caption })),
        { url: `${BASE}/license-food-01.png`, category: 'license', caption: '食品经营许可证' },
      ];
      const bizCode = `91110105DEMO${String(id).padStart(8, '0')}`;
      const foodCode = `JY1110105DEMO${String(id).padStart(8, '0')}`;

      console.log(`[${p.name}] id=${id}`);
      console.log(`  store_photos(${photos.length}): ${photos.map((x) => x.caption).join(' / ')}`);
      console.log(`  资质编号: 营业执照=${bizCode}  食品经营=${foodCode}`);

      if (APPLY) {
        await conn.query(
          `UPDATE ab_supplier SET store_photos = ?, business_license = ?, food_license = ?, updated_at = NOW(3)
           WHERE id = ? AND name = ?`,
          [JSON.stringify(photos), bizCode, foodCode, id, p.name],
        );
      }
      results.push({ name: p.name, id, ok: true });
    }

    if (!APPLY) {
      console.log('\n[DRY-RUN] 未写入。确认后加 --apply 执行。');
      return;
    }

    // 自检：回读并断言
    console.log('\n--- 自检（回读） ---');
    let allOk = true;
    for (const p of PLAN) {
      const [rows] = await conn.query('SELECT id, name, store_photos, business_license, food_license FROM ab_supplier WHERE name = ?', [p.name]);
      const s = rows[0];
      const ph = typeof s.store_photos === 'string' ? JSON.parse(s.store_photos) : s.store_photos;
      const urls = (ph ?? []).map((x) => x.url);
      const expect = p.photos.map((x) => `${BASE}/${x.file}`).concat(`${BASE}/license-food-01.png`);
      const missing = expect.filter((u) => !urls.includes(u));
      const bizOk = s.business_license === `91110105DEMO${String(Number(s.id)).padStart(8, '0')}`;
      const foodOk = s.food_license === `JY1110105DEMO${String(Number(s.id)).padStart(8, '0')}`;
      const ok = missing.length === 0 && bizOk && foodOk;
      if (!ok) allOk = false;
      console.log(`[${s.name}] id=${Number(s.id)} 照片${(ph ?? []).length}张 ${ok ? '✓' : `✗ 缺:${missing} biz:${bizOk} food:${foodOk}`}`);
    }
    console.log(allOk ? '\n全部回填成功 ✓' : '\n存在失败项 ✗（见上）');
    if (!allOk) process.exit(1);
  } finally {
    await conn.end();
  }
}

main().catch((e) => { console.error(`\n[失败] ${e.message}`); process.exit(1); });
