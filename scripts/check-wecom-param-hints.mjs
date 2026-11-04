#!/usr/bin/env node
/**
 * 自检：机器人问参数时，能不能把每个必填参数**说成人话**。
 *
 * 为什么要有这一道（2026-11-02 实测）：
 *   137 个端点里 49 个带必填参数（合计 94 个），其中 **17 个在目录里 hint 为空** ——
 *   机器人只会问「还需要：role」「还需要：opCode」，用户根本不知道该填什么。
 *
 *   查下去是三个叠加的原因，**没有一个是「忘了写注释」**（这点很关键，凭印象改会改错地方）：
 *     ① 描述写成模板字符串 `` `角色：${ROLE_HINT}` `` —— 为了和 `@IsIn` 共用一份取值、
 *        不重复维护，而生成器只认单引号字面量 ⇒ 20 处解析不到；
 *     ② 描述跨行（`description:` 换行、值落在下一行）⇒ 生成器按单行匹配，抓不到；
 *     ③ `@IsIn(ADMIN_ROLES)` 传的是**常量名**、`@ApiParam` 全仓 0 处
 *        ⇒ 枚举取值与路径参数压根没有来源。
 *   三者都已在 `gen-wecom-catalog.mjs` 里修好（三引号 + 跨行 + 常量内联 + `@ApiParam`），
 *   这道门禁防的是它悄悄退回去 —— 机器人「能问」和「问得懂」是两件事。
 *
 * 判据：必填参数（`required` 且 `name !== '*'`）必须带 **含中文** 的 hint。
 *   · 只判「非空」不够：`${ROLE_HINT}` 没内联成功时 hint 也非空，但那不是人话。
 *   · DTO 没解析出字段的端点（`*`）单列为「跳过」并**打印** —— 不许静默算通过。
 *
 * 自证（`--selftest`，缺一不可）：
 *   · 必不报样本：**真实未改动的数据**必须零违规（凭空构造证明不了恒绿，实测踩过）；
 *   · 必报样本一：去掉某个参数的 hint ⇒ 必须报；
 *   · 必报样本二：把 hint 换成**纯英文** ⇒ 必须报（证明「含中文」这条判据真的在跑）。
 *
 * 用法：
 *   node scripts/check-wecom-param-hints.mjs            # 检查（门禁）
 *   node scripts/check-wecom-param-hints.mjs --selftest # 自证
 *   node scripts/check-wecom-param-hints.mjs --verbose  # 连通过项一起打
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './check-wecom-op-params.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const VERBOSE = process.argv.includes('--verbose');

/** 含至少一个汉字 —— 英文残留不算「说人话」 */
function hasChinese(s) {
  return /[一-龥]/.test(String(s ?? ''));
}

/**
 * @returns {{violations: Array, skipped: Array, checked: number}}
 */
function scan(catalog) {
  const violations = [];
  const skipped = [];
  let checked = 0;

  for (const [code, entry] of Object.entries(catalog)) {
    const params = Array.isArray(entry?.params) ? entry.params : [];

    // DTO 没解析出字段：机器人只能收一整段 JSON，无法逐参数判
    //
    // ⚠️ 两种成因**症状完全一样**，这里把两种都写出来，否则后来人只会去猜：
    //   ① DTO 类忘了 `export` —— 生成器只认 `/^export\s+class\s+(\w+)\b/`；
    //      这种情况是**真缺陷**（参数本来能引导，被一个 `export` 挡住了）。
    //      2026-11-04 实测：`ai-insight` / `launch-draft` 共 3 个端点栽在这上面。
    //   ② 压根没写 DTO 类，`@Body()` 直接用内联对象类型（如 `{ opCode?: string }`）——
    //      当前仅 `post_admin_opblocklist` 一处，且两个字段全可选、无必填参数可引导，
    //      故判定为**可接受**，不为它硬造一个 DTO。
    //    分辨方法：去控制器看 `@Body()` 的类型是不是 `XxxDto` 类名。
    if (params.some((p) => p.name === '*')) {
      skipped.push({
        code,
        detail:
          `${entry.method} ${entry.path} 的入参 DTO 未解析出字段（*）` +
          ` —— 查控制器：DTO 类是否漏了 \`export\`，或 \`@Body()\` 用了内联对象类型`,
      });
      continue;
    }

    for (const p of params) {
      if (!p.required) continue;
      checked += 1;
      if (!hasChinese(p.hint)) {
        violations.push({
          kind: 'NO_HINT',
          code,
          detail:
            `${entry.method} ${entry.path} 的必填参数 \`${p.name}\` 提示为空或非中文` +
            (p.hint ? `（当前是：${String(p.hint).slice(0, 40)}）` : ''),
        });
      }
    }
  }
  return { violations, skipped, checked };
}

function selftest() {
  const catalog = loadCatalog();
  const base = scan(catalog);

  const fail = (msg) => {
    console.error('[自证失败] ' + msg);
    process.exit(1);
  };

  // ① 必不报样本：真实未改动的数据必须零违规
  if (base.violations.length > 0) {
    fail(
      '真实数据本身就有 ' +
        base.violations.length +
        ' 条违规 —— 先修数据或修判据，别带着红跑自证：\n' +
        base.violations.map((v) => `   · [${v.kind}] ${v.code} ${v.detail}`).join('\n'),
    );
  }
  if (base.checked === 0) fail('受检参数为 0 —— 判据等于没跑（集合是空的）');
  if (base.checked < 50) fail(`受检参数只有 ${base.checked} 条，明显偏少（预期 >50）`);

  // ② 必报样本一：把首个带 hint 的必填参数的 hint 抹掉
  const sample = findFirstRequired(catalog);
  if (!sample) fail('目录里找不到任何必填参数，无法自证');
  const noHint = cloneWith(catalog, sample, { ...sample.param, hint: undefined });
  const r1 = scan(noHint);
  if (!r1.violations.some((v) => v.kind === 'NO_HINT')) {
    fail('把 hint 抹掉竟然没报 —— 这条检查抓不到「问得看不懂」');
  }

  // ③ 必报样本二：hint 换成纯英文（证明「含中文」判据真的在跑，不是只看非空）
  const enHint = cloneWith(catalog, sample, { ...sample.param, hint: 'target user id' });
  const r2 = scan(enHint);
  if (!r2.violations.some((v) => v.kind === 'NO_HINT')) {
    fail('hint 是纯英文竟然没报 —— 「含中文」这条判据等于没跑');
  }

  console.log(
    `[自证通过] 真实数据 0 违规（受检 ${base.checked} 个必填参数、跳过 ${base.skipped.length} 个端点）；` +
      '两个必报样本都报了；必不报样本没报',
  );
}

/**
 * 找第一个带中文 hint 的必填参数（作为注入缺陷的样本）。
 *
 * ⚠️ **必须与 `scan()` 的跳过条件完全一致**（`params.some(p => p.name === '*')`）。
 *    被跳过的端点整段不参与检查，拿它当注入样本 ⇒ 抹掉 hint 也不会报 ⇒
 *    自证恒假红，且报的是「这条检查抓不到问得看不懂」这种**指向错误**的结论。
 *
 *    2026-11-04 实测踩到：新增的 `post_admin_aiinsight_id_decide` 因 DTO 未 `export`
 *    而被标成入参 `*`，恰好排在目录第一位 —— 旧版取样命中它的 `id` 参数，
 *    抹掉 hint 后 `scan()` 直接跳过整端点，自证失败。
 *    （同批根因还导致 3 个端点「入参未解析」，已在控制器 DTO 上补 `export` 修掉。）
 */
function findFirstRequired(catalog) {
  for (const [code, entry] of Object.entries(catalog)) {
    // 与 scan() 同步：入参未解析（`*`）的端点会被整段跳过，不可作为样本
    if ((entry?.params ?? []).some((p) => p.name === '*')) continue;
    for (const p of entry?.params ?? []) {
      if (p.required && p.name !== '*' && hasChinese(p.hint)) {
        return { code, param: p };
      }
    }
  }
  return null;
}

function cloneWith(catalog, sample, newParam) {
  const out = {};
  for (const [code, entry] of Object.entries(catalog)) {
    out[code] =
      code === sample.code
        ? {
            ...entry,
            params: (entry.params ?? []).map((p) =>
              p === sample.param || p.name === sample.param.name ? newParam : p,
            ),
          }
        : entry;
  }
  return out;
}

function main() {
  if (process.argv.includes('--selftest')) {
    selftest();
    return;
  }

  const catalog = loadCatalog();
  const { violations, skipped, checked } = scan(catalog);

  console.log(
    `[企微参数提示自检] 受检 ${checked} 个必填参数 · 跳过 ${skipped.length} 个端点 · ` +
      `违规 ${violations.length} 条`,
  );
  for (const s of skipped) console.log(`  [跳过] ${s.code}：${s.detail}`);
  if (VERBOSE) console.log(`  [通过] ${checked - violations.length} 个参数都有中文提示`);

  if (checked === 0) {
    console.error('\n[FAIL] 受检参数为 0 —— 判据等于没跑');
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error('\n[FAIL] 下列必填参数机器人问出来是看不懂的（用户不知道填什么）：');
    for (const v of violations) console.error(`  · ${v.code}：${v.detail}`);
    console.error(
      '\n修法：给 DTO 字段补 `@ApiProperty({ description })`、给路径参数补 `@ApiParam`。',
    );
    console.error('（描述写中文，别再写成模板字符串之外的东西 —— 生成器已支持模板与跨行。）');
    process.exit(1);
  }
  console.log('OK 每个必填参数都能说成人话');
}

void ROOT;
void fs;
main();
