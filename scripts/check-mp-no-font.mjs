#!/usr/bin/env node
/**
 * ⛔ mp 端不得有任何字体二进制进包 —— γ「楷体死资源」的**防复发闸门**
 *
 * 为什么需要它（2026-10-07 实测，别凭印象改）：
 *   `ab-kaiti.woff2` 曾以「零引用」的姿态在主包里躺了 597 KB（换开源字体后 851 KB，
 *   占主包 1.4 MB 的 **42%**）—— `@font-face` 被 `#ifdef H5` 排除 ⇒ **wxss 里根本没人引用它**，
 *   但 vite 收集 CSS 里的 `url()` 发生在条件编译**之前** ⇒ 字体照样被当成 asset 产出。
 *   现在由 `apps/miniprogram/vite.config.ts` 的 `abox:mp-no-font-asset` 插件在出包时剔除；
 *   本闸门负责**复核插件真的剔干净了**：插件失效、或有人把字体挪回 `static/`
 *   （uni 会全量复制 static、不看有没有人引用）⇒ 立刻转红。
 *
 * 为什么可以无差别判红：**wxss 的 `src` 只接受网络地址或 base64**
 * （依据见 `apps/miniprogram/src/styles/icons.scss`）⇒ 本地字体文件在 mp 端**永远不会被引用**。
 * 图标字体 ABoxIcons 是 base64 内嵌在 CSS 里的，**不是独立文件**，不受影响。
 *
 * 判据（唯一真源 `scanFontFiles`；自证与主流程**共用同一个函数**，禁止各写一份）：
 *   返回 `null`      = 产物目录不存在
 *   返回 `{fonts,total}` = 字体清单 + 扫描到的文件总数
 *   ⚠️ 这个区分是本闸门的关键：把「目录不存在」当成「0 个字体」正是典型的**恒绿陷阱**
 *      （记忆：恒绿 / 恒红 / 恒 N/A 三种都等于没有检查）。
 *
 * 退出码：0 通过 · 1 有违规 · 2 自证失败或产物缺失（**不静默放行**）
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MP_OUT = join(ROOT, 'apps', 'miniprogram', 'dist', 'build', 'mp-weixin');
const FONT_EXT = /\.(woff2?|ttf|otf)$/i;

/**
 * 递归扫描字体二进制。
 * @returns {null|{fonts: Array<{rel:string,size:number}>, total:number}}
 *   `null` 表示目录不存在；其余情况返回清单（空数组 = 扫到了文件但没有字体）。
 */
function scanFontFiles(dir) {
  if (!existsSync(dir)) return null;
  const fonts = [];
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const name of readdirSync(cur)) {
      const abs = join(cur, name);
      if (statSync(abs).isDirectory()) {
        stack.push(abs);
        continue;
      }
      total += 1;
      if (FONT_EXT.test(name)) fonts.push({ rel: relative(dir, abs), size: statSync(abs).size });
    }
  }
  return { fonts, total };
}

// ── 自证（无条件前置跑：恒绿的检查比没有检查更糟）────────────────────────────
function selftest() {
  const cases = [];
  const base = join(tmpdir(), `abox-mp-no-font-${Date.now()}`);
  const mk = (name) => {
    const d = join(base, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  try {
    // ① 必报：根目录直躺一个 woff2
    const d1 = mk('root-font');
    writeFileSync(join(d1, 'ab-kaiti.woff2'), 'x');
    writeFileSync(join(d1, 'app.js'), 'x');
    cases.push(['① 必报：根目录 woff2', scanFontFiles(d1)?.fonts?.length === 1]);

    // ② 必报：嵌套子目录里的 ttf（防「只扫一层」）
    const d2 = mk('nested');
    mkdirSync(join(d2, 'static', 'fonts'), { recursive: true });
    writeFileSync(join(d2, 'static', 'fonts', 'x.ttf'), 'x');
    cases.push(['② 必报：嵌套子目录 ttf', scanFontFiles(d2)?.fonts?.length === 1]);

    // ③ 必不报：真实且未改动的源码目录（纯样式，无字体二进制）
    const d3 = join(ROOT, 'apps', 'miniprogram', 'src', 'styles');
    const r3 = scanFontFiles(d3);
    cases.push(['③ 必不报：真实目录 src/styles', Array.isArray(r3?.fonts) && r3.fonts.length === 0 && r3.total > 0]);

    // ④ 判据：目录不存在 ⇒ `null`（绝不能被当成「0 个字体」放行）
    cases.push(['④ 判据：目录不存在返回 null', scanFontFiles(join(base, 'no-such-dir')) === null]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  const pass = cases.filter(([, ok]) => ok).length;
  for (const [name, ok] of cases) console.log(`  ${ok ? '✔' : '✘'} ${name}`);
  console.log(`[自证] 汇总 ${pass}/${cases.length}`);
  if (pass !== cases.length) {
    console.log('✘ 自证失败：检查器自身判据已坏，门禁不可用（不静默放行）');
    process.exit(2);
  }
}

selftest();

// ── 主流程 ────────────────────────────────────────────────────────────────
const result = scanFontFiles(MP_OUT);
if (result === null) {
  console.log(
    `✘ 找不到 mp 产物目录：${relative(ROOT, MP_OUT)}\n` +
      `  请先跑 \`node scripts/gate.mjs build:mp\`（或 \`uni build -p mp-weixin\`）再验本闸门 ——\n` +
      `  产物缺失时不许报「通过」，否则本闸门等于没跑。`,
  );
  process.exit(2);
}

if (result.fonts.length > 0) {
  console.log(`✘ mp 产物含字体二进制 ${result.fonts.length} 个（` + `共扫描 ${result.total} 个文件）：`);
  for (const f of result.fonts) {
    console.log(`  - ${f.rel}  ${(f.size / 1024).toFixed(0)} KB`);
  }
  console.log(
    '  ⛔ wxss 的 src 只接受网络地址或 base64 ⇒ 这些文件**永远不会被引用**，是纯死资源。\n' +
      '     修法：`vite.config.ts` 的 `abox:mp-no-font-asset` 插件应已剔除；' +
      '若仍出现，多半是字体被挪回了 `src/static/`（uni 全量复制 static，不看引用）。',
  );
  process.exit(1);
}

console.log(`✔ mp 产物字体二进制 0 个（扫描 ${result.total} 个文件）`);
console.log(`③ 覆盖面：${result.total} 个产物文件 · 判据 woff/woff2/ttf/otf`);
