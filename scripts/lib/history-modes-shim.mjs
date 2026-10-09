/**
 * `security:scan` 三态取证的**伪造与执行**侧（`scripts/probes/security-history-modes.mjs` 用）
 *
 * 拆出来的理由与 `lib/frozen-sync-rules.mjs` 相同：单文件 ≤300 行，
 * 且「怎么造假 git / 怎么起子进程」与「判据是什么」是两件事，分开后判据可被复用。
 *
 * ⛔ 全程只用 `spawnCapture`：本机 `stdio:'pipe'` 一律 EBUSY
 *    （`exit=null` = 环境故障伪装成测试失败，手册 §6.3①）。
 */
import { existsSync, linkSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { spawnCapture } from './spawn-capture.mjs';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const API_DIR = join(ROOT, 'apps', 'api-server');
export const SCAN_REL = 'src/common/security/security-scan.ts';
export const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/**
 * ts-node 的**真实入口**，用 `node` 直接跑它、**不经 shell**
 *
 * ⚠️ 为什么不写 `spawnCapture('ts-node', …, { shell: true })`：走 shell 就要过 cmd.exe
 *    的命令行解析，实测两连坑 —— ① 脚本里的**换行**会被当成两条命令；
 *    ② 脚本里的 **`|`**（字面量联合类型 `'a'|'b'`）会被当成**管道符**。
 *    「判据脚本里不许出现某个字符」是一条会咬人的隐藏约束 ⇒ 绕开 shell，约束就消失了。
 */
export const TSNODE_BIN = (() => {
  try {
    return createRequire(join(ROOT, 'package.json')).resolve('ts-node/dist/bin.js');
  } catch {
    return null;
  }
})();

/** 子进程环境：把各包 `node_modules/.bin` 与 node 目录塞进 PATH（与 `gate.mjs` 同一套路） */
export function childEnv(extraPathDirs = []) {
  return {
    ...process.env,
    PATH: [
      ...extraPathDirs,
      join(API_DIR, 'node_modules', '.bin'),
      join(ROOT, 'node_modules', '.bin'),
      dirname(process.execPath),
      process.env.PATH,
    ].join(PATH_SEP),
  };
}

/**
 * 假 git 的载荷（`git.exe` 其实是 node.exe 的硬链接，靠 `NODE_OPTIONS` 预载这段来作答）
 *
 * ⚠️ **必须做成 `.exe`**：本机实测 `spawnSync('git', args)` **不带 shell** 时 libuv 只探测
 *    `.exe`，`.cmd` 与 `PATHEXT` 都无效 ⇒ 写 `.cmd` 会命中**真** git.exe，
 *    三态于是退化成同一个态（κ-7 实测踩过，那是最糟的假绿）。
 */
const PAYLOAD = (variant, logPath) => `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const LOG = ${JSON.stringify(logPath)};
const VARIANT = ${JSON.stringify(variant)};
const argv = process.argv.slice(1);
const base = path.basename(argv[0] || '');
try { fs.appendFileSync(LOG, 'CALL base=' + base + '\\n'); } catch (e) {}
const GITISH = new Set(['rev-parse', 'log', 'ls-files']);
if (GITISH.has(base)) {
  try { fs.appendFileSync(LOG, 'HIT\\n'); } catch (e) {}
  if (VARIANT === 'unavailable') process.exit(1);
  if (base === 'rev-parse') { fs.writeSync(1, (VARIANT === 'shallow' ? 'true' : 'false') + '\\n'); process.exit(0); }
  if (base === 'log') {
    if (argv.slice(1).includes('--name-only')) { fs.writeSync(1, 'src/a.ts\\nsrc/b.ts\\n'); process.exit(0); }
    fs.writeSync(1, 'commit:0000000000000000000000000000000000000000\\n+const PORT = 3000;\\n');
    process.exit(0);
  }
  fs.writeSync(1, '');
  process.exit(0);
}
`;

/** 造一个假 git；返回 `{ exe, logPath }` */
export function buildFakeGit(dir, variant) {
  const logPath = join(dir, 'called.log');
  writeFileSync(join(dir, 'payload.cjs'), PAYLOAD(variant, logPath), 'utf8');
  writeFileSync(logPath, '', 'utf8');
  const exe = join(dir, process.platform === 'win32' ? 'git.exe' : 'git');
  try {
    linkSync(process.execPath, exe); // 硬链接：0 额外磁盘
  } catch {
    copyFileSync(process.execPath, exe);
  }
  return { exe, logPath };
}

/** 假 git 被命中几次（0 ⇒ 没生效 ⇒ 三态其实是同一个态） */
export function hitCount(logPath) {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim() === 'HIT').length;
  } catch {
    return 0;
  }
}

/** 跑一次 `security-scan.ts`，把完整 stdout+stderr 取回 */
export function runScan(shimDir) {
  const r = spawnCapture(process.execPath, [TSNODE_BIN, '-r', 'tsconfig-paths/register', SCAN_REL], {
    cwd: API_DIR,
    env: { ...childEnv([shimDir]), NODE_OPTIONS: `--require ${join(shimDir, 'payload.cjs')}` },
  });
  return { text: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

/** 跑一段 TS 判据脚本（用于从真源取映射），返回 `{ text, status }` */
export function runTsNodeScript(script) {
  const r = spawnCapture(process.execPath, [TSNODE_BIN, '-r', 'tsconfig-paths/register', '-e', script], {
    cwd: API_DIR,
    env: childEnv(),
  });
  return { text: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}
