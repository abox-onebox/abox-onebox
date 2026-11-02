#!/usr/bin/env node
/**
 * 自检：`op-meta.ts` 里声明的参数名，与**真实 DTO / 路由**是否对得上。
 *
 * 为什么要有这一道（真实事故，2026-11-02 线上）：
 *   `QUERY_META.q_orders.optional` 写的是 `date`，而 `AdminOrdersQueryDto` 的字段叫 `mealDate`。
 *   后果不是报错，是**「今天多少单」一直是坏的**：后端 DTO 白名单挡下
 *   （`property date should not exist`），机器人把它转成「没查到：…」——
 *   从这句话完全看不出是字段名写错，而它还被抄进了帮助文案当示例。
 *   三次门禁全绿、单测全绿，功能是死的。
 *
 * 两个方向都查（缺一不可）：
 *   ① **声明了但端点不认**（`UNKNOWN_PARAM`）：传了会被 DTO 白名单挡下 ⇒ 永远「没查到」。
 *   ② **端点要但没声明**（`REQUIRED_NOT_ASKED`）：机器人永远不会问这个参数
 *      ⇒ 每次执行都 422，而且现象是「填完所有问题还是失败」。
 *   只查 ① 会漏掉「机器人根本不问」，只查 ② 会漏掉上面那次真实事故。
 *
 * 数据源：
 *   · 端点真值 = `op-catalog.generated.ts`（由 `gen-wecom-catalog.mjs` 从 controller/DTO 解析而来，
 *     与 `wecom:catalog` 门禁同源，不另写一份解析）。
 *   · 声明真值 = `op-meta.ts`（本文件解析，因为它是手写 TypeScript，没有编译产物可用）。
 *
 * 自证（`--selftest`，缺一不可）：
 *   · 必报样本：把真实的 `q_orders` 加上 `date` ⇒ **必须**报 `UNKNOWN_PARAM`；
 *   · 必报样本：让某个端点「必填但没声明」⇒ **必须**报 `REQUIRED_NOT_ASKED`；
 *   · 必不报样本：**真实未改动的数据**必须零违规（凭空构造的样本证明不了这一点，
 *     实测过两次「自检恒红」都是因为缺这一步）。
 *
 * 用法：
 *   node scripts/check-wecom-op-params.mjs            # 检查（门禁）
 *   node scripts/check-wecom-op-params.mjs --selftest # 自证
 *   node scripts/check-wecom-op-params.mjs --verbose  # 连通过项一起打
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'apps/api-server/src');
const CATALOG_TS = path.join(SRC, 'modules/wecom-kb/op-catalog.generated.ts');
const META_TS = path.join(SRC, 'modules/wecom-kb/op-meta.ts');

const VERBOSE = process.argv.includes('--verbose');

/** 从生成的目录里取出端点表（base64 内嵌，见文件头说明） */
export function loadCatalog(src = CATALOG_TS) {
  const text = fs.readFileSync(src, 'utf8');
  const m = /'([A-Za-z0-9+/=]{100,})'/.exec(text);
  if (!m) throw new Error('目录里找不到 base64 数据段：' + src);
  const json = Buffer.from(m[1], 'base64').toString('utf8');
  const catalog = JSON.parse(json);
  const n = Object.keys(catalog).length;
  if (n < 100) throw new Error(`目录只解析出 ${n} 个端点，明显不对（预期 >100）`);
  return catalog;
}

/** 从 `op-meta.ts` 源码解析一个 `export const X: Record<string, OpMeta>` 表 */
export function parseMetaTable(text, constName) {
  const head = text.indexOf(`export const ${constName}`);
  if (head < 0) throw new Error('找不到常量：' + constName);
  const end = text.indexOf('\n};', head);
  if (end < 0) throw new Error('找不到常量结尾：' + constName);
  const body = text.slice(head, end);

  const out = {};
  // 顶层条目固定缩进两格；字段块内部缩进四格，所以 `\n  },` 正好是「条目结束」
  const re = /\n {2}(\w+): \{([\s\S]*?)\n {2}\},/g;
  let m;
  while ((m = re.exec(body))) {
    const [, code, block] = m;
    const method = /method:\s*'(\w+)'/.exec(block)?.[1];
    const endpoint = /endpoint:\s*'([^']+)'/.exec(block)?.[1];
    if (!method || !endpoint) continue; // 不是 OpMeta 条目（注释块等）
    const arr = (key) => {
      const mm = new RegExp(key + String.raw`:\s*\[([^\]]*)\]`).exec(block);
      if (!mm) return [];
      return [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    out[code] = {
      code,
      method,
      endpoint,
      required: arr('required'),
      optional: arr('optional'),
    };
  }
  if (Object.keys(out).length === 0) throw new Error(`常量 ${constName} 一条都没解析出来`);
  return out;
}

/**
 * 纯比较函数（自证靠它，不依赖文件系统）。
 *
 * @returns {{violations: Array, skipped: Array, checked: number}}
 */
export function compare(metas, catalog) {
  const violations = [];
  const skipped = [];
  let checked = 0;

  for (const meta of Object.values(metas)) {
    const key = `${meta.method} ${meta.endpoint}`;
    const hit = Object.entries(catalog).filter(
      ([, e]) => e.method === meta.method && e.path === meta.endpoint,
    );

    if (hit.length === 0) {
      violations.push({
        kind: 'NO_ENDPOINT',
        code: meta.code,
        detail: `声明指向 ${key}，但目录里没有这个端点（路由改名或拼错）`,
      });
      continue;
    }

    const [catCode, entry] = hit[0];
    const params = Array.isArray(entry.params) ? entry.params : [];
    const star = params.some((p) => p.name === '*');
    if (star) {
      // DTO 没解析出字段：无法逐字段比对。**显式打出来**，不许静默算通过。
      skipped.push({ code: meta.code, detail: `${catCode} 的入参 DTO 未解析出字段（*）` });
      continue;
    }
    checked += 1;

    // 路径参数（`:id` / `:orderNo`）不在目录的 `params` 里 —— 它们是路径占位符，
    // 由 `op-proxy.fill()` 替换。漏了这一步会把 8 条声明全误报成 `UNKNOWN_PARAM`，
    // 真缺陷就被噪音埋掉了（实测首版就是这样：11 条里 8 条是误报）。
    const pathNames = [...entry.path.matchAll(/:(\w+)/g)].map((x) => x[1]);
    const names = new Set([...params.map((p) => p.name), ...pathNames]);
    for (const name of [...meta.required, ...meta.optional]) {
      if (!names.has(name)) {
        violations.push({
          kind: 'UNKNOWN_PARAM',
          code: meta.code,
          detail: `声明了 \`${name}\`，但 ${catCode}（${key}）的参数里没有它 —— 传了会被白名单挡下`,
          hint: names.size ? `端点实际参数：${[...names].join(' / ')}` : '端点不接受任何参数',
        });
      }
    }

    for (const p of params) {
      if (!p.required || p.name === '*') continue;
      if (!meta.required.includes(p.name)) {
        violations.push({
          kind: 'REQUIRED_NOT_ASKED',
          code: meta.code,
          detail: `${catCode} 把 \`${p.name}\` 标为必填，但这里没声明 ⇒ 机器人永远不会问你，每次都失败`,
        });
      }
    }
  }

  return { violations, skipped, checked };
}

function selfTest() {
  const catalog = loadCatalog();
  const metaText = fs.readFileSync(META_TS, 'utf8');
  const real = {
    ...parseMetaTable(metaText, 'OP_META'),
    ...parseMetaTable(metaText, 'QUERY_META'),
  };

  const fail = (msg) => {
    console.error('[自证失败] ' + msg);
    process.exit(1);
  };

  // ① 必不报样本：真实未改动的数据必须零违规（这条最能证明「检查器没有恒红」）
  const base = compare(real, catalog);
  if (base.violations.length > 0) {
    fail(
      '真实数据本身就有 ' +
        base.violations.length +
        ' 条违规 —— 先修数据或修判据，别带着红跑自证：\n' +
        base.violations.map((v) => `   · [${v.kind}] ${v.code} ${v.detail}`).join('\n'),
    );
  }
  if (base.checked === 0) fail('受检条目为 0 —— 判据等于没跑（集合是空的）');

  // ② 必报样本：历史真实事故 `date` vs `mealDate`
  const withDate = {
    ...real,
    q_orders: { ...real.q_orders, optional: [...real.q_orders.optional, 'date'] },
  };
  const r1 = compare(withDate, catalog);
  const hit1 = r1.violations.find((v) => v.kind === 'UNKNOWN_PARAM' && v.code === 'q_orders');
  if (!hit1) fail('把 `date` 加进 q_orders 竟然没报 —— 这条检查抓不到真事故');

  // ③ 必报样本：端点标必填但没声明（模拟「机器人永远不问」）
  const dropRequired = { ...real };
  if (!dropRequired.q_orders) fail('数据集里没有 q_orders，无法自证');
  const catEntry = Object.values(catalog).find(
    (e) => e.method === 'GET' && e.path === '/admin/orders',
  );
  const someRequired = (catEntry?.params ?? []).filter((p) => p.required && p.name !== '*');
  if (someRequired.length === 0) {
    // 换个样本：正向构造一个「目录说必填、我方没声明」的假端点，直接打 compare
    const fakeCatalog = {
      ...catalog,
      __fake: {
        method: 'POST',
        path: '/admin/__fake',
        params: [{ name: 'needMe', required: true, type: 'string', in: 'body' }],
      },
    };
    const fakeMeta = {
      f: { code: 'f', method: 'POST', endpoint: '/admin/__fake', required: [], optional: [] },
    };
    const r2 = compare(fakeMeta, fakeCatalog);
    if (!r2.violations.some((v) => v.kind === 'REQUIRED_NOT_ASKED')) {
      fail('构造的「必填但没声明」样本没报 —— 第二个方向等于没查');
    }
  } else {
    const broken = {
      ...real,
      q_orders: { ...real.q_orders, required: [] },
    };
    const r2 = compare(broken, catalog);
    if (!r2.violations.some((v) => v.kind === 'REQUIRED_NOT_ASKED')) {
      fail('清空 q_orders 的 required 竟然没报 —— 第二个方向等于没查');
    }
  }

  console.log(
    `[自证通过] 真实数据 0 违规（受检 ${base.checked} 条、跳过 ${base.skipped.length} 条）；` +
      '两个必报样本都报了；两个必不报样本都没报',
  );
}

function main() {
  if (process.argv.includes('--selftest')) {
    selfTest();
    return;
  }

  const catalog = loadCatalog();
  const metaText = fs.readFileSync(META_TS, 'utf8');
  const metas = {
    ...parseMetaTable(metaText, 'OP_META'),
    ...parseMetaTable(metaText, 'QUERY_META'),
  };

  const { violations, skipped, checked } = compare(metas, catalog);

  console.log(
    `[企微参数名自检] 受检 ${checked} 条（共声明 ${Object.keys(metas).length} 条）` +
      ` · 跳过 ${skipped.length} 条 · 违规 ${violations.length} 条`,
  );
  for (const s of skipped) console.log(`  [跳过] ${s.code}：${s.detail}`);
  if (VERBOSE) for (const k of Object.keys(metas)) console.log(`  [通过] ${k}`);

  if (violations.length) {
    console.error('\n发现参数名对不上（机器人会「没查到」或永远填不完）：');
    for (const v of violations) {
      console.error(`  · [${v.kind}] ${v.code}：${v.detail}`);
      if (v.hint) console.error(`      ${v.hint}`);
    }
    process.exit(1);
  }
  console.log('OK 全部对得上');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
