/**
 * 密钥泄露扫描 + 日志脱敏核查（M5-3 安全自检 · 本地可执行部分）
 *
 * 对应《协作规范 v1.0》§五（环境与配置纪律）与里程碑 5.3 的两项：
 *   · **密钥泄露** —— 仓库（含**完整 git 历史**）里不得出现真实凭据
 *   · **日志脱敏** —— 日志不得整对象落敏感字段（手机号 / 身份证 / 卡号 / 令牌）
 *
 * ## 为什么必须扫 git 历史，而不只扫工作区
 * 「提交过又删掉」的密钥**仍然在历史里可检出**，而当前工作区看起来是干净的 ——
 * 只扫工作区会给出一个**看起来绿的结论**，这是最危险的一类安全报告。
 *
 * ## 占位与示例必须豁免，否则检查会被噪音淹没
 * 项目里有大量**刻意**的示例值（`.env.example` / 文档里的 `your-appid`）。
 * 判据：命中文本**同时**带占位标记（`your-` / `xxx` / `<...>` / `CHANGE_ME` …）时降级为
 * 「示例」不报 —— 但**真实形态的高熵串不受豁免**（见 `looksLikeRealSecret`）。
 *
 * ## 自证能力
 * 每次运行会构造**假的真密钥样本**（私钥块 / AWS key / 高熵 token）走同一套规则，
 * 必须全部被报出；也构造**占位样本**必须不被报出。任一条不符即自身失败 ——
 * 「恒绿的检查比没有检查更糟」。
 *
 * 运行：`gate.mjs security:scan`
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface Pattern {
  name: string;
  re: RegExp;
  level: 'FAIL' | 'WARN';
  hint: string;
  /**
   * 是否参与 **git 历史**扫描（缺省 true = 参与）。
   *
   * ⚠️ 为什么要有这个开关：两类规则的「历史命中」含义完全不同 ——
   *   · **真凭据形态**（连接串密码 / JWT 字面量）：提交过就是泄露，
   *     即使后来删掉，历史里也还在，**必须继续报**；
   *   · **代码形态**（危险默认值 / 写法问题）：它描述的是「此刻这段代码长什么样」，
   *     **改了就没有风险了**，历史命中只是噪音。
   * 若不给这个开关，新规则一旦加入，历史扫描会对**已修复**的旧提交永远报红 ——
   * 门禁变成不可通过，人就会去关掉整条规则（那才是真正的损失）。
   */
  history?: boolean;
}

/** 疑似真实凭据的形态（**不含真实密钥**，仅形态） */
const PATTERNS: Pattern[] = [
  {
    name: '私钥块',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    level: 'FAIL',
    hint: '私钥内容入库 —— 必须立即轮换并从历史移除（apiclient_key.pem 等）',
  },
  {
    name: 'AWS Access Key',
    re: /\bAKIA[0-9A-Z]{16}\b/,
    level: 'FAIL',
    hint: 'AWS 凭据形态',
  },
  {
    name: '高熵 API Key（sk-/ghp_/xox）',
    re: /\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{20,}\b/,
    level: 'FAIL',
    hint: '第三方平台令牌形态',
  },
  {
    name: '连接串含密码',
    re: /\b(?:mysql|postgres|postgresql|redis|mongodb|amqp):\/\/[^\s:@/]+:[^\s:@/]{6,}@/,
    level: 'FAIL',
    hint: '连接串内嵌明文密码 —— 应改为环境变量注入',
  },
  {
    name: '硬编码敏感赋值',
    re: /\b(?:password|passwd|secret|apiKey|api_key|accessKey|access_key|privateKey|private_key)\s*[:=]\s*['"]([^'"]{10,})['"]/,
    level: 'FAIL',
    hint: '敏感值以字面量写死在代码/配置里',
  },
  {
    name: '微信支付密钥形态',
    re: /\b(?:mch_?id|mchid)\s*[:=]\s*['"]?1[0-9]{9}['"]?/i,
    level: 'WARN',
    hint: '微信商户号（本身非密钥，但与 API 证书同目录时风险放大）',
  },
  {
    name: 'Bearer/JWT 字面量',
    re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./,
    level: 'FAIL',
    hint: 'JWT 字面量入库（可能是真实令牌或测试夹具，均不应出现在提交里）',
  },
  {
    /**
     * ⭐ M5-7 新增（缺陷 #83）。
     *
     * 前四条规则抓的是「**写死在代码里的真凭据**」。本条抓的是另一种形态，
     * 而且**危害相同**：**敏感配置的兜底默认值**。
     *
     * ```ts
     * jwtSecret: str(process.env.JWT_SECRET, 'change_me_before_go_live')
     *                                             ^ 生产漏配一个环境变量，
     *                                               就变成「用公开字符串签管理员令牌」
     * ```
     *
     * ⚠️ 实测：**旧扫描器对此完全无感** —— `secret` 规则带词边界、`jwtSecret` 是
     *    驼峰不匹配；`change_me` 只在 `PLACEHOLDER`（豁免表）里，而豁免表
     *    只在「已经有规则命中」之后才被询及。**没有规则命中 = 永远不会问到豁免。**
     *    （缺陷 #83 原写法是「被当作示例豁免」，实测后已更正为「压根没有规则」——
     *     两者都漏，但修法不同：前者改豁免、后者**必须加规则**。）
     *
     * 覆盖两种写法：`?? 'x'` / `|| 'x'` 与 `str(env, 'x')` 一类**取值包装函数**。
     * 抓的是「引号内出现危险词」，故 `'dev'` / `3` / `'mock_openid_'` 不会命中。
     */
    name: '敏感配置的危险默认值',
    // \u26a0\ufe0f **必须用 `new RegExp` 拼装，且各片段要拆成数组元素** —— 直接写正则字面量会被
    //    **自己**扫中（自污染）：字面量里 `\\|\\|` 与 `\\bstr\\(` 之间恰好构成
    //    `||` + `str(` + `change[-_]?me` 的完整自匹配序列。首跑实测就报了 1 条自己。
    //    拆开后各危险片段不再相邻，自污染消失（与 `selfTest` 里用 `P()` 拆字符串同一个道理）。
    re: new RegExp(
      '(?:' +
        ['\\?\\?', '\\|\\|', '\\bstr\\(', '\\bnum\\('].join('|') +
        ')[^\\n]{0,60}?[\'"][^\'"]*(?:' +
        ['chang' + 'e[-_]?me', '123456', 'default[-_]?password', 'secret'].join('|') +
        ')[^\'"]*[\'"]',
      'i',
    ),
    level: 'FAIL',
    // 代码形态问题（改了即无风险）\u2192 不进历史扫描，见 `Pattern.history` 的说明
    history: false,
    hint: '敏感配置的**兜底默认值**：生产漏配即静默降级为公开值，应在生产环境缺失时直接启动失败（开发默认值请加 `security-scan:allow` 并写明理由）',
  },
];

/** 占位 / 示例标记 —— **仅在注释内**视为示例而非真凭据（见 `isPlaceholderHit`） */
const PLACEHOLDER =
  /(your[-_]|xxx|placeholder|change[-_]?me|<[^>]{2,}>|\bexample\b|\bdummy\b|\bsample\b|\bfake\b|\.{3,}|0{8,}|1234567890|占位|示例|待填|待补|test[-_]?only|demo)/i;

/**
 * 显式豁免标记（M5-7 新增）
 *
 * 用法（两种位置都认）：
 *   · 同行：`jwtSecret: str(env, 'x'), // security-scan:allow <理由>`
 *   · **上一行**：`// security-scan:allow <理由>` 然后紧接被豁免的那一行
 *
 * ⚠️ 「上一行」不是可选项：`prettier` 会把长理由折行，同行写不下完整理由，
 *    于是实际写法必然是「上一行」（同 `eslint-disable-next-line` 的道理）。
 *    **首跑实测就栽在这里**：标记写在上一行、只检查当前行的实现静默失效 ——
 *    表现是「明明标了却不生效」，与「压根没标」长得一模一样。
 *
 * ⚠️⚠️ **必须紧邻**（同行，或紧接的上一行）—— **不跨行、不向上找**。
 *    第二轮实测又栽了一次：理由分两行写、标记放在注释块**第一行**，
 *    于是「上一行」是注释的第二行、不含标记 → 仍然不生效。
 *    故把标记放在注释块的**最后一行**（紧贴代码）。
 *    刻意不做「向上找 N 行」：豁免一旦有了需要心算的作用域，
 *    就退化回 #83 想消灭的那种模糊 —— 代价只是偶尔挪一下注释位置，值得。
 *
 * 为什么要有它：豁免本身是必要的（否则满屏噪音），但**隐式豁免**（凭内容猜）
 * 一定会猜错 —— 「注释里的 `your-xxx`」与「代码实参里的 `change_me`」
 * 内容同形、语义相反。（缺陷 #83 的完整判据：**豁免要按位置收窄，而不是往
 * 正则里再加几个词**。）
 *
 * 所以留**唯一**一条豁免通道：显式的、逐行的、**必须写理由**的。
 * 它会被记为 `NOTE` 打印出来（可见但不阻断），便于后人审计「为什么这行被放过」。
 */
const ALLOW_MARK = /security-scan:\s*allow\b/i;

/**
 * 求本行「注释起点」的下标（无注释返回 `-1`）
 *
 * ⚠️ 必须**跳过字符串字面量**：`const u = 'https://x'` 里的 `//` 不是注释。
 *    这是本函数存在的全部理由 —— 朴素地 `indexOf('//')` 会把含 URL 的行
 *    整行判成注释，于是同一行里后面的真实密钥被豁免掉。
 * ⚠️ 已知近似：不识别正则字面量里的 `/`（`/a\/b/` 这类）与多行模板串；
 *    对本用途（判断某个命中是否落在注释里）足够，且**错向安全**——
 *    识别不出注释时判为「不是注释」，即**宁可报、不可漏**。
 */
function commentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) return i;
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return i;
    if (ch === '<' && line.startsWith('<!--', i)) return i;
  }
  // 行首就是 `*`（JSDoc / 块注释延续行）—— 没有行内标记，单独兜一笔
  const jsdoc = /^\s*\*/.exec(line);
  return jsdoc ? jsdoc[0].length - 1 : -1;
}

/** 扫描范围：只扫这些扩展名的文本文件 */
const TEXT_EXT = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.sh',
  '.ps1',
  '.html',
  '.vue',
  '.css',
  '.conf',
  '.sql',
  '.example',
  '.env',
]);

/** 不扫的目录 */
const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '_stale-build',
  '.turbo',
  'unpackage',
]);

/** 历史里出现即需检查内容的敏感文件名 */
const SENSITIVE_FILE = /(^|\/)(\.env(\..+)?|.+\.(pem|key|p12|pfx|crt|jks))$/i;

interface Hit {
  /**
   * `NOTE` = **显式豁免**记录（`security-scan:allow`）。
   *
   * 它与 `WARN` 的区别：`WARN` 是「机器怀疑、等人确认」，`NOTE` 是
   * 「人已确认、机器记账」—— 必须**可见**（否则「显式」二字失去意义），
   * 但不参与退出码判定。
   */
  level: 'FAIL' | 'WARN' | 'NOTE';
  pattern: string;
  where: string;
  line?: number;
  hint: string;
  snippet: string;
}

/** 去掉首尾空白并把命中片段截断（**不回显整段密钥**，只留可定位的前缀） */
const redact = (s: string): string => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > 72 ? `${t.slice(0, 72)}…` : t;
};

/**
 * 该命中是否可以放过 —— 三道闸门，**依次**判定
 *
 * 1. **显式豁免**：本行带 `security-scan:allow` → 放过（会被记成 `NOTE`）；
 * 2. **位置闸门**（M5-7 新增）：命中片段必须落在**注释内** —— 这是本函数的
 *    核心修正。旧版只看「整行内容里有没有占位词」，于是同一行里
 *    `// 示例：JWT_SECRET=change_me` （该放过）与
 *    `jwtSecret: str(env, 'change_me')` （**必须报**）被判成同一类。
 *    判据是**位置**而不是**内容**：占位词出现在注释里才是「示例」，
 *    出现在代码实参里就是「真的把兜底值写进了代码」。
 * 3. **真凭据闸门**：捕获组里若是 ≥32 位的高熵串，一律不放过
 *    （防止用注释里的 `your-xxx` 掩盖一个真值）。
 */
function isPlaceholderHit(line: string, m: RegExpMatchArray, prevLine = ''): boolean {
  if (ALLOW_MARK.test(line) || ALLOW_MARK.test(prevLine)) return true;
  if (!PLACEHOLDER.test(line)) return false;
  const cs = commentStart(line);
  const idx = m.index ?? 0;
  if (cs < 0 || idx < cs) return false;
  // 捕获组里若已有明显的真凭据特征则**不豁免**（避免用注释里的 your-xxx 掩盖真值）
  const captured = m[1] ?? '';
  return !/^[A-Za-z0-9+/_-]{32,}$/.test(captured);
}

function findRepoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error('未找到仓库根（pnpm-workspace.yaml）—— 检查器必须在仓库内运行');
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        visit(path.join(dir, e.name));
      } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) || e.name.startsWith('.env')) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  visit(root);
  return out;
}

// ---------------------------------------------------------------------------
// 一、工作区扫描
// ---------------------------------------------------------------------------

function scanWorkspace(root: string): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(root)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 二进制 / 无权限，跳过
    }
    if (text.includes('\u0000')) continue; // 含 NUL 视为二进制

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // 豁免标记可以写在上一行（prettier 折行后这是唯一可行形态，见 ALLOW_MARK 注释）
      const prevLine = i > 0 ? lines[i - 1] : '';
      for (const p of PATTERNS) {
        const m = line.match(p.re);
        if (!m) continue;
        if (ALLOW_MARK.test(line) || ALLOW_MARK.test(prevLine)) {
          // 显式豁免：不阻断，但**必须可见** —— 否则「显式」二字没有意义
          hits.push({
            level: 'NOTE',
            pattern: '显式豁免',
            where: path.relative(root, file),
            line: i + 1,
            hint: '本行以 `security-scan:allow` 显式豁免，理由见行内注释',
            snippet: redact(m[0]),
          });
          continue;
        }
        if (isPlaceholderHit(line, m, prevLine)) continue;
        hits.push({
          level: p.level,
          pattern: p.name,
          where: path.relative(root, file),
          line: i + 1,
          hint: p.hint,
          snippet: redact(m[0]),
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 二、git 历史扫描（「提交过又删掉」的仍然算泄露）
// ---------------------------------------------------------------------------

function scanGitHistory(root: string): Hit[] {
  const hits: Hit[] = [];
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  // 2a. 历史里出现过的敏感文件名（哪怕已删除）
  let names = '';
  try {
    names = git('log', '--all', '--pretty=format:', '--name-only', '--diff-filter=AD');
  } catch {
    return []; // 非 git 环境（如解包副本）—— 由调用方记录「历史未扫」
  }
  const seen = new Set<string>();
  for (const n of names.split(/\r?\n/)) {
    const f = n.trim();
    if (!f || seen.has(f) || !SENSITIVE_FILE.test(f)) continue;
    seen.add(f);
    // 排除刻意提交的示例文件（.env.example 等）
    if (/\.example$/i.test(f)) continue;
    hits.push({
      level: 'FAIL',
      pattern: '敏感文件入库',
      where: `${f}（历史记录）`,
      hint: '密钥/证书类文件曾进入版本库 —— 确认内容是否真实，必要时轮换',
      snippet: f,
    });
  }

  // 2b. 全历史内容扫描 —— 只对「提交信息 + 变更行」跑 FAIL 级模式
  let patch = '';
  try {
    patch = git('log', '--all', '-p', '--format=commit:%H');
  } catch {
    return hits;
  }
  for (const raw of patch.split(/\r?\n/)) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    for (const p of PATTERNS) {
      if (p.history === false) continue; // 代码形态规则不查历史，见 `Pattern.history`
      const m = line.match(p.re);
      if (!m || isPlaceholderHit(line, m)) continue;
      hits.push({
        level: p.level,
        pattern: `${p.name}（历史）`,
        where: 'git 历史变更行',
        hint: p.hint,
        snippet: redact(m[0]),
      });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 三、日志脱敏核查
// ---------------------------------------------------------------------------

/**
 * 敏感字段名 —— 仅当它出现在**插值**里才算「值被打印」。
 *
 * ⚠️ 判据必须区分「打印了值」与「文案提到了字段名」：
 *    `'WX_MINI_APPID / WX_MINI_SECRET 未配置'` 只是**文案**，不含任何值；
 *    而 `` `openid=${openid}` `` 才是**真的把值写进日志**。
 *    第一版只匹配词表，于是把前一类误报成 WARN —— 误报多了，真命中就没人看了。
 */
const LOG_INTERP =
  /\$\{[^}]*\b(phone|mobile|telephone|openid|unionid|idCard|id_card|cardNo|token|secret|password)\w*\b[^}]*\}/i;

/** 疑似真实敏感值**字面量**（手机号 / 身份证）—— 出现在日志调用里即是问题 */
const LOG_LITERAL = /\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b/;

/** 整对象落日志（尤其请求体 / 用户实体）*/
const LOG_WHOLE_OBJECT =
  /logger\.\w+\([^)]*JSON\.stringify\(\s*(?:req|request|body|payload|user|admin|dto)\b/i;

/** 判定单行日志调用的风险等级（**纯函数**，供扫描与自证共用） */
function classifyLogLine(line: string): { level: 'FAIL' | 'WARN'; why: string } | null {
  if (!/logger\.\w+\(/.test(line)) return null;

  if (LOG_WHOLE_OBJECT.test(line)) {
    return {
      level: 'FAIL',
      why: 'logger 打印整个请求体/实体 —— 会连带手机号、令牌等敏感字段，请改打字段白名单',
    };
  }
  const interp = line.match(LOG_INTERP);
  if (interp) {
    return {
      level: 'WARN',
      why: `日志插值打印了敏感字段 ${interp[1]} —— 确认是否已脱敏（手机号应中间四位打码，openid 应截断）`,
    };
  }
  const literal = line.match(LOG_LITERAL);
  if (literal) {
    return {
      level: 'WARN',
      why: `日志中出现敏感值字面量 ${redact(literal[0])} —— 确认是否为真实数据（禁止把真人手机号/身份证写进代码）`,
    };
  }
  return null;
}

function scanLogs(root: string): Hit[] {
  const hits: Hit[] = [];
  const apiSrc = path.join(root, 'apps', 'api-server', 'src');
  if (!fs.existsSync(apiSrc)) return hits;

  for (const file of walk(apiSrc)) {
    if (!file.endsWith('.ts')) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const verdict = classifyLogLine(lines[i]);
      if (!verdict) continue;
      hits.push({
        level: verdict.level,
        pattern: verdict.level === 'FAIL' ? '日志整对象落库' : '日志含敏感值',
        where: path.relative(root, file),
        line: i + 1,
        hint: verdict.why,
        snippet: redact(lines[i]),
      });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 自证
// ---------------------------------------------------------------------------

/**
 * 造样本走同一套规则：真凭据必报、占位必不报。
 *
 * ⚠️ 样本**必须拼接构造**，不能以完整形态出现在本文件里 —— 否则本文件会被
 *    `scanWorkspace()` 自己扫到，**检查器污染自己的检查结果**（实测确实会全红）。
 *    这也是「检查器不得比它检查的对象更特殊」的具体体现。
 */
function selfTest(): void {
  const P = (...xs: string[]): string => xs.join('');

  const samples: Array<[string, boolean, string?]> = [
    // 真凭据形态 → 必须报
    [P('const k = "-----BEGIN RSA ', 'PRIVATE KEY-----";'), true],
    [P('aws = "AKIA', 'IOSFODNN7REALKEY";'), true],
    [P('const t = "sk-', 'abcdefghijklmnopqrstuvwxyz0123456789";'), true],
    [P('db = "mysql://root:', 'Pa55w0rd!x@10.0.0.1:3306/abox"'), true],
    [P('pass', 'word = "S3cretP@ssw0rd"'), true],
    // ⭐ 占位 / 示例 —— **只有落在注释里才放过**（M5-7 · 缺陷 #83 回归）
    // ⚠️ 旧样本 `[P('const appid = "your-', 'appid-here";'), false]` 等三条
    //    是**空转**的：根本没有规则命中它们，所以 `got` 恒为 false，
    //    「豁免逻辑坏了」这件事压根测不出来 —— 换成下面这三对。
    [P('// const password = "', 'CHANGE_ME_now";'), false], // 注释内的占位 → 放过
    [P('const secret = "', 'change_me_before_go_live";'), true], // 代码实参里的占位 → **必须报**
    [P('// const secret = "', 'change_me_before_go_live";'), false], // 同一串字符挪进注释 → 放过
    [
      P('const secret = "', 'change_me_before_go_live"; // security-scan:', 'allow 开发默认值'),
      false,
    ], // 同行豁免
    // ⭐ 豁免标记写在**上一行**（prettier 折行后的真实形态）—— 只查当前行的实现会静默放过它
    [
      P('const secret = "', 'change_me_before_go_live";'),
      false,
      P('// security-scan:', 'allow 开发默认值'),
    ],
    // ⭐ 这条专测「字符串里的 `//` 不是注释起点」：朴素 `indexOf('//')` 会把整行判成注释
    //    而放过它 —— 那正是「一行里既有 URL 又有真密钥」时最危险的漏报形态。
    [P('const u = "https://x.com"; const secret = "', 'change_me_before_go_live";'), true],
  ];

  const missed: string[] = [];
  for (const [line, shouldHit, prevLine] of samples) {
    const got = PATTERNS.some((p) => {
      const m = line.match(p.re);
      return !!m && !isPlaceholderHit(line, m, prevLine);
    });
    if (got !== shouldHit) {
      missed.push(`${shouldHit ? '漏报' : '误报'}：${redact(line)}`);
    }
  }

  // 日志规则的自证：插值/字面量必报，**纯文案提及字段名必不报**
  // ⚠️ 同样必须拆开 `logger` 二字 —— 否则这些样本行会被 `scanLogs()` 自己扫到（自污染）
  const LOG = P('this.log', 'ger.');
  const logCases: Array<[string, 'FAIL' | 'WARN' | null]> = [
    [P(LOG, 'info(`user=${JSON.stringify(', 'req.body)}`)'), 'FAIL'],
    [P(LOG, 'debug(`openid=${', 'openid}`)'), 'WARN'],
    [P(LOG, 'debug("', '138', '00138000");'), 'WARN'],
    [P(LOG, 'warn("WX_MINI_APPID / WX_MINI_', 'SECRET 未配置");'), null],
    [P(LOG, 'info(`订单 ${orderNo} 创建成功`);'), null],
  ];
  for (const [line, want] of logCases) {
    const got = classifyLogLine(line)?.level ?? null;
    if (got !== want) {
      missed.push(
        `日志规则${want === null ? '误报' : '漏报'}（期望 ${want}，实得 ${got}）：${redact(line)}`,
      );
    }
  }

  if (missed.length) {
    throw new Error(
      `自证失败（${missed.length} 项）—— 检查器失效时必须自己失败：\n    ${missed.join('\n    ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export function run(): { workspace: Hit[]; history: Hit[]; logs: Hit[] } {
  const root = findRepoRoot(__dirname);
  selfTest();
  return { workspace: scanWorkspace(root), history: scanGitHistory(root), logs: scanLogs(root) };
}

function main(): void {
  const root = findRepoRoot(__dirname);
  const { workspace, history, logs } = run();
  const all = [...workspace, ...history, ...logs];
  const fail = all.filter((h) => h.level === 'FAIL');
  const warn = all.filter((h) => h.level === 'WARN');
  const note = all.filter((h) => h.level === 'NOTE');

  const ICON: Record<Hit['level'], string> = { FAIL: '✘', WARN: '△', NOTE: '·' };

  const show = (title: string, list: Hit[]): void => {
    console.log(`\n【${title}】${list.length ? '' : ' 无命中'}`);
    for (const h of list) {
      console.log(
        `  ${ICON[h.level]} [${h.pattern}] ${h.where}${h.line ? `:${h.line}` : ''}\n` +
          `      ${h.snippet}\n      → ${h.hint}`,
      );
    }
  };

  console.log(`仓库：${root}`);
  show('一 · 工作区密钥扫描', workspace);
  show('二 · git 历史扫描', history);
  show('三 · 日志脱敏核查', logs);

  console.log(
    `\n合计命中 ${all.length} 项（FAIL ${fail.length} / WARN ${warn.length} / 显式豁免 ${note.length}）` +
      ` —— 工作区 ${workspace.length} · 历史 ${history.length} · 日志 ${logs.length}`,
  );

  if (fail.length) {
    console.log(`\n✘ 安全扫描未通过：${fail.length} 项阻断（必须处理，不可带病上线）`);
    process.exit(1);
  }
  console.log(
    `\n✔ 安全扫描通过：无 FAIL 级命中${warn.length ? `（${warn.length} 项 WARN 待人工确认）` : ''}`,
  );
}

if (require.main === module) main();
