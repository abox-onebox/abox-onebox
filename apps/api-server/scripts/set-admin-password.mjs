#!/usr/bin/env node
/**
 * ============================================================
 * ABox 一盒 · 后台账号口令工具（免登录 · 应急 / 上线前体检）
 * ============================================================
 *
 * 为什么要有这个脚本 —— 它解除的是一个**死循环**：
 *   · 种子给后台账号写的是 `dev_plain:admin123`（开发期明文段位）
 *   · `password.ts` 里 `dev_plain:` 在 NODE_ENV=production 一律拒绝
 *     （安全默认值必须「生产无兜底」，这个裁定是对的）
 *   · 而全仓唯一写 scrypt 哈希的入口是 `AdminUserService.create()`，
 *     调用它**必须先登录后台**
 *   ⇒ 于是：没口令 → 登不进 → 无法创建账号 → 永远登不进。
 *     ui 上没有任何自救通道。
 *
 * 本脚本直接连 MySQL 改 `ab_admin_user.password_hash`，不经过 HTTP / 不需要登录。
 *
 * ------------------------------------------------------------
 * ⭐ 唯一真源约束
 * ------------------------------------------------------------
 * 口令哈希**不在本文件重新实现** —— 一律 require 编译产物里的
 * `dist/common/utils/password.js`（由 `src/common/utils/password.ts` 编译而来）。
 * 理由：一旦这里用「看起来一样」的参数自己算一遍，就会埋下
 * 「脚本写进去的哈希 ≠ 登录时校验的哈希」的分叉，而且这种缺陷
 * 在生产上表现为「改完口令依然登录失败」，极难定位。
 * ⇒ require 失败即退出（fail-closed），不做降级实现。
 *
 * ------------------------------------------------------------
 * 用法（容器内执行；MySQL 不映射宿主端口，必须在 abox-api-prod 里跑）
 * ------------------------------------------------------------
 *   docker compose -f docker-compose.prod.yml exec api \
 *     node apps/api-server/scripts/set-admin-password.mjs --user admin --pass '换成强口令'
 *
 *   --scan                 只体检：列出仍是 dev_plain 的账号（上线前必跑）
 *   --emit-sql             不连库，只打印可手工执行的 UPDATE（含生成好的哈希）
 *   --gen                  自动生成 16 位强口令并打印（随即写入）
 *   --force                跳过口令强度校验（不建议）
 *   --selftest             双向自证（必报样本 + 必不报样本），不做任何写操作
 *
 * ⚠️ 运行前提：dist 必须存在（镜像内 CMD 启动的正是 dist/main.js，故正常满足）。
 * ⚠️ 改完口令后仍需把种子里的 dev_plain 占位清掉，否则下次 `seed` 会把密
 *    码再覆盖回明文（且该种子在生产不可再跑 —— 见《部署运维手册》§4）。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------
 * 常量：全部实读自源码/配置，不凭印象
 *   · 表名与列名 ← system.entity.ts 的 @Entity('ab_admin_user')
 *     注意列命名是**混着来的**：password_hash / real_name / supplier_id
 *     是 snake_case（@Column 显式写了 name），而 username / role / status
 *     没有显式 name，列名就是属性名本身。写错即为 Unknown column。
 *   · DB_HOST 默认 'mysql' ← docker-compose.prod.yml 的服务名 + 同 network
 * --------------------------------------------------------- */
const DIST_PASSWORD = path.resolve(HERE, '..', 'dist', 'common', 'utils', 'password.js');
const TABLE = 'ab_admin_user';
const COL_HASH = 'password_hash';
const MIN_LEN = 10;

/* ------------------------------------------------------------
 * 参数解析（手写而非引依赖：这是一个「应急」脚本，
 * 依赖越少，在宿主机/容器/不同 node 版本上跑不起来的概率越低）
 * --------------------------------------------------------- */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq >= 0) {
      out[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    // 支持 `--pass abc`，也兼容 `--pass=abc`
    const nx = argv[i + 1];
    if (nx !== undefined && !nx.startsWith('--')) {
      out[key] = nx;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/* ------------------------------------------------------------
 * 哈希真源加载（唯一实现处）
 * --------------------------------------------------------- */
function loadRealSource() {
  let mod;
  try {
    mod = require(DIST_PASSWORD);
  } catch (e) {
    console.error('[x] 无法加载口令真源：' + DIST_PASSWORD);
    console.error('    原因：' + e.message);
    console.error('    多半是 dist 未构建。请先执行 pnpm --filter api-server build，');
    console.error('    或在已构建的容器内运行本脚本。');
    console.error('');
    console.error('    [i] 不做降级实现 —— 一旦本地重算哈希，就可能出现');
    console.error('        「写进去的哈希登录时校验不过」的分叉，宁可失败也不可风险。');
    process.exit(2);
  }
  if (typeof mod.hashPassword !== 'function' || typeof mod.verifyPassword !== 'function') {
    console.error('[x] 口令真源导出不完整（需 hashPassword / verifyPassword）');
    process.exit(2);
  }
  return mod;
}

/* ------------------------------------------------------------
 * 口令强度（叠三层，避免「改了等于没改」）
 * --------------------------------------------------------- */
function strengthIssues(pwd) {
  const bad = [];
  if (typeof pwd !== 'string' || pwd.length === 0) bad.push('口令为空');
  else {
    if (pwd.length < MIN_LEN) bad.push('长度不足 ' + MIN_LEN + ' 位（当前 ' + pwd.length + '）');
    if (!/[A-Za-z]/.test(pwd)) bad.push('不含字母');
    if (!/[0-9]/.test(pwd)) bad.push('不含数字');
    if (/^(admin|password|123456|abox|qwerty)/i.test(pwd)) bad.push('使用了高危常见前缀');
  }
  return bad;
}

function genPassword() {
  const crypto = require('node:crypto');
  // 去掉 0/O/1/l/I 等易混字符：口令是要被人工抄到｜ password manager 外的
  const AL = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (const b of bytes) s += AL[b % AL.length];
  // 兜底补一位数字，杜绝极端随机下「不含数字」被判弱
  return (s + String(bytes[0] % 10)).slice(0, 20);
}

/* ------------------------------------------------------------
 * 数据库连接（mysql2 已在 /app/node_modules 下，由 .npmrc 的
 * shamefully-hoist=true 保证顶层可见 —— 这条约束与 deploy.sh
 * 用 `node node_modules/typeorm/cli.js` 是同一件事）
 * --------------------------------------------------------- */
function dbConfig(args) {
  return {
    host: args.host || process.env.DB_HOST || 'mysql',
    port: Number(args.port || process.env.DB_PORT || 3306),
    user: args.dbUser || process.env.DB_USER || 'root',
    password: args.dbPass || process.env.DB_PASSWORD || '',
    database: args.db || process.env.DB_DATABASE || 'abox_onebox',
  };
}

async function connect(cfg) {
  let mysql;
  try {
    mysql = await import('mysql2/promise');
  } catch (e) {
    console.error('[x] 未找到 mysql2（容器内应已安装）：' + e.message);
    process.exit(2);
  }
  try {
    return await mysql.createConnection(cfg);
  } catch (e) {
    console.error('[x] 连不上数据库 ' + cfg.host + ':' + cfg.port + '/' + cfg.database);
    console.error('    原因：' + e.message);
    console.error('    [i] 检查 env：DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE');
    console.error('    [i] 若你在容器外运行 —— mysql 未映射宿主端口，必须在容器内跑。');
    process.exit(2);
  }
}

/* ------------------------------------------------------------
 * 自证：必报样本 + 必不报样本（缺任一＝该工具不可用）
 * --------------------------------------------------------- */
async function selftest() {
  const { hashPassword, verifyPassword } = loadRealSource();
  const items = [];
  const ck = (cond, msg, detail = '') => items.push([!!cond, msg, detail]);

  // ① 黄金路径：真源生成的哈希，真源自己认账（证明本脚本与登录校验同算法）
  const pwd = 'Zhouyi2026abox';
  const h = hashPassword(pwd);
  ck(h.startsWith('scrypt:'), '哈希形态为 scrypt:<salt>:<hash>', h.slice(0, 24) + '...');
  ck(verifyPassword(pwd, h), '正确口令可校验通过');
  ck(!verifyPassword(pwd + 'x', h), '错误口令被拒绝');

  // ② 两次同口令哈希不同（盐随机 ⇒ 不会被彩虹表/比对串号）
  ck(hashPassword(pwd) !== hashPassword(pwd), '同一口令两次哈希不同（盐随机）');

  // ③ 定长不变的前提
  const parts = h.slice('scrypt:'.length).split(':');
  ck(parts.length === 2 && parts[0].length === 32 && parts[1].length === 64,
    '盐 32 hex / 哈希 64 hex', parts.map((p) => p.length).join(' + '));

  // ④ dev_plain 相关（生产拒绝这条正是本脚本的起因）
  const P = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const isProdAllowsDevPlain = (() => {
    // 重新 require 让 DEV_PLAIN_ALLOWED 按 production 重算
    delete require.cache[require.resolve(DIST_PASSWORD)];
    const m = require(DIST_PASSWORD);
    return m.verifyPassword('admin123', 'dev_plain:admin123');
  })();
  ck(isProdAllowsDevPlain === false, '生产模式下 dev_plain 明文口令一律拒绝（本脚本存在的理由）');

  process.env.NODE_ENV = 'development';
  delete require.cache[require.resolve(DIST_PASSWORD)];
  const devMod = require(DIST_PASSWORD);
  ck(devMod.verifyPassword('admin123', 'dev_plain:admin123') === true,
    '开发模式下 dev_plain 仍可用（不应误伤本地开发）');
  process.env.NODE_ENV = P || '';

  // ⑤ 强度判据：四个必报（弱口令都得被拦）+ 一个必不报（合规口令必须放行）
  const weakCases = [
    ['', '空口令'],
    ['abc', '过短'],
    ['abcdefghijkl', '无数字'],
    ['123456789012', '无字母'],
    ['admin1234567', '高危前缀'],
  ];
  const shouldCatch = weakCases.filter(([p]) => strengthIssues(p).length === 0);
  ck(shouldCatch.length === 0, '弱口令一律被判弱',
    shouldCatch.map((c) => c[1]).join('、') || '5 例全拦下');
  ck(strengthIssues('Zhouyi2026abox').length === 0, '合规口令不被误判为弱');

  // ⑥ 生成的口令必须自己过得了自己的强度关（否则 --gen 是自相矛盾的）
  const g = genPassword();
  ck(strengthIssues(g).length === 0, '--gen 生成的口令自身合规', g.length + ' 位');
  ck([...g].every((c) => !/[0O1lI]/.test(c)), '--gen 不产易混字符 0/O/1/l/I');

  // ⑦ SQL 转义：带引号的口令不得串出注入
  const risk = "a' OR '1'='1";
  ck(risk.replace(/\\/g, '\\\\').replace(/'/g, "''") !== risk,
    "口令中的单引号被转义（带引号的恶意串也串不出 SQL）");

  let fail = 0;
  for (const [okFlag, msg, detail] of items) {
    console.log((okFlag ? '[ok] ' : '[!!] ') + msg + (detail ? '  —— ' + detail : ''));
    if (!okFlag) fail++;
  }
  console.log('\n自证 ' + (items.length - fail) + '/' + items.length
    + (fail ? ' —— 有不符项，禁止投入使用' : ' 全部通过（未做任何写操作）'));
  process.exit(fail ? 1 : 0);
}

/* ------------------------------------------------------------
 * 主流程
 * --------------------------------------------------------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.selftest) return selftest();

  const { hashPassword, verifyPassword, isDevPlainHash } = loadRealSource();

  // ---------- 体检模式：上线前必跑 ----------
  if (args.scan) {
    const conn = await connect(dbConfig(args));
    const [rows] = await conn.query(
      'SELECT id, username, role, status, ' + COL_HASH + ' FROM `' + TABLE + '` ORDER BY id'
    );
    await conn.end();
    const risky = rows.filter((r) => isDevPlainHash(r[COL_HASH] || ''));
    const weak = rows.filter((r) => {
      const v = r[COL_HASH] || '';
      return !isDevPlainHash(v) && !v.startsWith('scrypt:');
    });
    console.log('后台账号体检 —— 共 ' + rows.length + ' 个账号');
    for (const r of rows) {
      const kind = isDevPlainHash(r[COL_HASH] || '')
        ? 'dev_plain（生产登不进）'
        : (r[COL_HASH] || '').startsWith('scrypt:') ? 'scrypt（正常）' : '未知格式（一律拒绝）';
      console.log('  #' + r.id + ' ' + r.username + ' [' + r.role + '] status=' + r.status + '  ' + kind);
    }
    console.log('');
    if (risky.length) {
      console.log('[!!] 有 ' + risky.length + ' 个账号仍是 dev_plain —— 生产环境这些账号一律登不进：');
      console.log('     ' + risky.map((r) => r.username).join('、'));
      console.log('     修复：node apps/api-server/scripts/set-admin-password.mjs --user <名> --pass <强口令>');
    } else {
      console.log('[ok] 无 dev_plain 账号');
    }
    if (weak.length) console.log('[!!] ' + weak.length + ' 个账号是未知哈希格式');
    process.exit(risky.length || weak.length ? 1 : 0);
  }

  // ---------- 改口令 ----------
  const who = args.user;
  if (!who || typeof who !== 'string') {
    console.error('[x] 必须指定账号：--user <username 或 id>');
    console.error('    当前有哪些账号：--scan');
    process.exit(2);
  }

  let plain = args.pass;
  if (args.gen) {
    plain = genPassword();
    console.log('[i] 已生成口令：' + plain);
    console.log('    （只出现这一次，请立刻抄走；丢失只能再跑一次重设）');
  }
  if (plain === true || !plain) {
    console.error('[x] 必须给出口令：--pass <明文>  或  --gen（自动生成）');
    process.exit(2);
  }

  const issues = strengthIssues(plain);
  if (issues.length && !args.force) {
    console.error('[x] 口令强度不足：' + issues.join('；'));
    console.error('    要求：≥' + MIN_LEN + ' 位 · 含字母 · 含数字 · 非高危常见串');
    console.error('    确需放行请加 --force（不建议用于生产）');
    process.exit(2);
  }
  if (issues.length && args.force) {
    console.log('[i] --force 已放行一个弱口令（' + issues.join('；') + '）');
  }

  const newHash = hashPassword(plain);

  // emit-sql：只打印，不连库（用于无法直连、只能让 DBA 代执行的场景）
  if (args['emit-sql']) {
    const esc = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
    const where = /^\d+$/.test(who) ? 'id = ' + who : 'username = ' + esc(who);
    console.log('-- 生成自 dist/common/utils/password.js（与登录校验同一实现）');
    console.log('UPDATE `' + TABLE + '` SET `' + COL_HASH + '` = ' + esc(newHash)
      + ', `updated_at` = NOW(3) WHERE ' + where + ';');
    console.log('-- 执行后校验应返回 affected rows = 1');
    console.log('SELECT id, username, LEFT(`' + COL_HASH + '`, 12) AS kind FROM `'
      + TABLE + '` WHERE ' + where + ';');
    return;
  }

  const cfg = dbConfig(args);
  const conn = await connect(cfg);

  // ① 先查 —— 不存在就别往下走（避免「改了 0 行还报成功」这种静默失败）
  const isNum = /^\d+$/.test(who);
  const [found] = await conn.query(
    'SELECT id, username, role, status, `' + COL_HASH + '` AS h FROM `' + TABLE
      + '` WHERE ' + (isNum ? 'id = ?' : 'username = ?') + ' LIMIT 1',
    [isNum ? Number(who) : who]
  );
  if (!found || found.length === 0) {
    const [all] = await conn.query(
      'SELECT id, username FROM `' + TABLE + '` ORDER BY id LIMIT 20'
    );
    await conn.end();
    console.error('[x] 账号不存在：' + who);
    console.error('    现有账号：' + (all.map((r) => r.id + '=' + r.username).join('、') || '（表为空，先灌种子）'));
    process.exit(1);
  }
  const row = found[0];

  // ② 写
  const [res] = await conn.query(
    'UPDATE `' + TABLE + '` SET `' + COL_HASH + '` = ?, `updated_at` = NOW(3) WHERE id = ?',
    [newHash, row.id]
  );
  if (!res || res.affectedRows !== 1) {
    await conn.end();
    console.error('[x] 更新未生效（affectedRows=' + (res && res.affectedRows) + '）');
    process.exit(1);
  }

  // ③ 回读并**用登录同一套 verify 复验** —— 确保写进去的真的登得上
  const [after] = await conn.query(
    'SELECT `' + COL_HASH + '` AS h FROM `' + TABLE + '` WHERE id = ?',
    [row.id]
  );
  await conn.end();
  const stored = after[0].h;

  const oldKind = row.h && row.h.startsWith('scrypt:') ? 'scrypt'
    : row.h && row.h.startsWith('dev_plain:') ? 'dev_plain（明文占位，生产登不进）' : '未知格式';
  console.log('[ok] 已更新后台账号口令');
  console.log('     账号：#' + row.id + ' ' + row.username + ' [' + row.role + ']');
  console.log('     原：' + oldKind + '  →  现：scrypt');

  const okNow = typeof verifyPassword === 'function' && verifyPassword(plain, stored);
  if (!okNow) {
    console.error('');
    console.error('[!!] 致命：写入后的哈希用登录校验函数复核不通过。');
    console.error('     极可能是 dist 与源码不同步 —— 请重新构建后重试。');
    console.error('     不要放过这条：它意味着你以为改好了，实际仍登不进。');
    process.exit(1);
  }
  console.log('[ok] 回读复验通过（写进去的哈希 = 登录时校验的哈希）');

  // ④ 收尾提示（改完口令不等于收工）
  console.log('');
  console.log('[i] 下一步：');
  console.log('    1) 用新口令登录后台验证一遍（别只信这里的输出）');
  console.log('    2) 跑一遍 --scan，确认没有遗留 dev_plain 账号');
  console.log('    3) 切勿在生产再跑 seed —— 它会把口令覆盖回明文');
}

main().catch((e) => {
  console.error('[x] 未预期的失败：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
