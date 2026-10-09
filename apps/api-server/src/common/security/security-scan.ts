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
 * ## 「有没有真扫描过」必须自己说出口（2026-10-09 κ-2）
 *
 * 本文件曾经的形状是：**git 不可用 ⇒ 历史未扫 ⇒ 返回 0 命中 ⇒ 门禁绿**。
 * 也就是「全历史密钥扫描」一次都没跑，而结论是「无 FAIL 级命中」——
 * 恒绿比恒红更难发现，因为它连「我失效了」都不会说一句。
 * （CI 侧同源：`actions/checkout` 默认 `fetch-depth: 1` 时历史近乎为空，
 *   表现完全相同——安静地绿，不报错。）
 *
 * 现在的判据是 `requireHistory`，且**刻意不问结果、只问选择**：
 *   · 不问「扫到几个提交」—— 解包副本 / 浅 clone 这些**合法**场景会恒红，
 *     而恒红和真缺陷在汇总里长得一模一样，人照样学不到东西；
 *   · 只问「**有没有人做出过明确选择**」—— 未声明 / `true` ⇒ 历史不完整即 **FAIL**；
 *     显式 `false` ⇒ 放过但**必须可见**（记 `NOTE`）。
 * ⇒ 「既没声明、也没扫到」当场变红；合法场景在调用处写一次 `requireHistory: false` 就绿。
 *
 * 「历史不完整」有两个入口，**共用同一条等级规则**（`incompleteHistoryHit`）：
 *   ① git 跑不起来（解包副本 / 没装 git）；
 *   ② **浅 clone** —— CI `actions/checkout` 缺 `fetch-depth: 0` 的直接后果。
 * ② 是硬约束而非可选检查：那条 yaml 配置若只写在注释里，改回 1 就回到「安静地绿」，
 *   而「一个正确性前提只有注释、没有门禁」正是本项目的复发模式。
 *   ⚠️ ② **必须单独问 `--is-shallow-repository`**：浅仓库里 `git log -p` 照样 exit 0，
 *      靠「git 跑没跑成功」永远发现不了它（本机实测见 `isShallowRepository` 注释）。
 *
 * 运行：`gate.mjs security:scan`
 * 无 git 历史时显式放行：`ABOX_SECURITY_SCAN_REQUIRE_HISTORY=0 gate.mjs security:scan`
 *                      或 `… security-scan.ts --require-history=false`
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
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

/**
 * 不扫的目录
 *
 * ⛔ **禁忌（可判定，不是「审慎」这种模糊措辞）**：本表**只许**放「按项目定义
 *    **就不是源码**」的目录 —— 判据是硬的：该目录在 `.gitignore` 里，且
 *    `git ls-files` 查不到**任何**被跟踪的文件（实测 2026-10-09：本表现在 7 个
 *    目录逐个查，`git ls-files` 命中数**全为 0**）。
 *
 *    **任何一个真源码目录进这张表 = 给密钥扫描开一个永久盲区，而且这个盲区
 *    永远不报错** —— 漏报比误报安静得多，这正是本项目反复踩的形状。
 *    ⇒ 上面这条由 `assertSkipDirsAreNotSource()` **机械看住**（新增一项即自动验一次），
 *      不靠后人读注释自觉：「正确性前提只写在注释里」就是 κ-2 这一轮在治的病。
 *
 * ⚠️ `_tmp` 为什么**必须**进：它是门禁与取证脚本的工作目录，实测放过过整份源码副本
 *    —— κ-2 构造浅 clone 样本时把副本放在 `_tmp/`，真仓库的工作区扫描**把副本又扫了
 *    一遍**（工作区命中 2→4、显式豁免 2→4）。重复计数是**已发生**的，不是理论风险。
 *    `.gitignore` 也早已把它定为「临时/验证产物、严禁入库」，与 `dist` 同类。
 *
 * ⚠️ `dist` / `build` / `coverage` 同为**构建或验证产物**，同样 0 个被跟踪文件。
 */
const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '_stale-build',
  '_tmp',
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

/**
 * 遍历文本文件，**并**回报被 `SKIP_DIR` 跳过的目录（后者供自校验用）
 *
 * ⚠️ 刻意只遍历**一次**并同时产出两份结果 —— 分成两个函数就是「同一份遍历两份表述」，
 *    而两份表述迟早会不一致（本项目的横向根因）。
 */
function walk(root: string): { files: string[]; skippedDirs: string[] } {
  const files: string[] = [];
  const skippedDirs: string[] = [];
  const visit = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) {
          skippedDirs.push(path.join(dir, e.name));
          continue;
        }
        visit(path.join(dir, e.name));
      } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) || e.name.startsWith('.env')) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  visit(root);
  return { files, skippedDirs };
}

// ---------------------------------------------------------------------------
// 一、工作区扫描
// ---------------------------------------------------------------------------

/**
 * 用 `git ls-files` **机械**看住「真源码目录不许进 `SKIP_DIR`」这条禁忌
 *
 * 判据：被跳过的目录里只要存在**任何一个被 git 跟踪的文件**，就说明这条 SKIP 把
 * 真源码挡在了扫描之外 ⇒ 永久盲区，**且不会报错**（漏报永远比误报安静）。
 *
 * ⚠️ 只在 git 可用时验 —— git 不可用 ⇒ **放弃本检查**，绝不允许凭空造出一个 FAIL：
 *    那会把「这台机器没有 git」伪装成「有人误把源码目录加进了 SKIP_DIR」，
 *    而后者需要人来改、前者只需要换台机器，两者被混为一谈就是新的假红。
 */
function assertSkipDirsAreNotSource(root: string, dirs: string[]): Hit[] {
  if (!dirs.length) return [];
  let tracked: string[] = [];
  try {
    tracked = gitOut(root, ['ls-files', '--', ...dirs])
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return []; // git 不可用 ⇒ 放弃（理由见上）
  }
  if (!tracked.length) return [];
  return [
    {
      level: 'FAIL',
      pattern: 'SKIP_DIR 挡住了真源码',
      where: 'security:scan 自校验',
      hint: '被 SKIP_DIR 跳过的目录里存在 **git 跟踪的文件** ⇒ 该目录是真源码，跳过它等于给密钥扫描开永久盲区。请删掉这一项，或改用更窄的路径 —— `SKIP_DIR` 只许放「按项目定义就不是源码」的产物目录（判据见该常量注释）。',
      snippet:
        tracked.slice(0, 5).join(' | ') +
        (tracked.length > 5 ? ` …（共 ${tracked.length} 个被跟踪文件）` : ''),
    },
  ];
}

function scanWorkspace(root: string): { hits: Hit[]; skippedDirs: string[] } {
  const hits: Hit[] = [];
  const { files, skippedDirs } = walk(root);
  for (const file of files) {
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
  return { hits, skippedDirs };
}

// ---------------------------------------------------------------------------
// 二、git 历史扫描（「提交过又删掉」的仍然算泄露）
// ---------------------------------------------------------------------------

/**
 * 「git 历史必须被扫到吗」—— **三种状态，没有缺省值**
 *
 * 这是 κ-2 补上的那条判据，针对的形状写在文件头：git 不可用 ⇒ 历史未扫 ⇒
 * 返回 0 命中 ⇒ 门禁绿，而「全历史密钥扫描」一次都没跑。
 *
 * ⭐ 判据**不问结果、只问选择**（理由见文件头）：
 *   · `true` 或**不写**（未声明）⇒ 扫不到即 **FAIL**；
 *   · `false`                   ⇒ 扫不到就放过，但**必须可见**（记 `NOTE`）。
 *
 * ⭐ 已实测的一条性质（κ-2 · **勿当成 regression**）：显式声明 `false` 之后，
 *    **即便探测历史的那条 git 命令本身是失败的**（样本里是 `spawnSync git ENOENT`），
 *    门禁**仍然 EXIT=0**。opt-out 的语义是「**放弃这一路检查**」，不是
 *    「要求这一路必须跑通」—— 后者会让「没有 git 的合法环境」永远红，那是恒红。
 *    ⇒ 读输出时：绿的原因是「**有人明确选择了放弃**」，且该选择以 NOTE 留在输出里可审计；
 *      只有当 opt-out 之下**仍然冒出 FAIL** 时，那才是真回归。
 */
export type RequireHistory = boolean | undefined;

export interface ScanOptions {
  /**
   * ⚠️ 该字段在**类型上没有缺省** —— 这不是疏忽，它就是判据的落点：
   *    TS 调用方漏写会**编译不过**，从而被迫做出一次明确选择；
   *    运行时（JS 调用方）漏传 ⇒ 视为「要求」，与未声明同样处理。
   */
  requireHistory: RequireHistory;
}

/**
 * git 历史的**三态** —— 与「扫到几条命中」正交
 *
 *   `complete`    —— 完整历史已扫（CI 正常态）
 *   `shallow`     —— 仓库是浅 clone，历史被截断（`fetch-depth` 缺了）
 *   `unavailable` —— git 压根跑不起来（解包副本 / 没装 git）
 *
 * ⚠️ 它会以 `[git-history] mode=<值>` 单独打印一行 —— 这是给 **CI 日志 grep** 用的
 *    稳定标记（人类可读那行是中文、会随措辞改动，不适合当契约）。
 *    上线前人工核对的就是这一行，见 `docs` 侧的验证清单。
 */
export type GitHistoryMode = 'complete' | 'shallow' | 'unavailable';

/** git 历史扫描的结果 —— 必须把「扫没扫到」和「扫到几条」分开回报 */
interface HistoryResult {
  hits: Hit[];
  mode: GitHistoryMode;
  /** `mode === 'complete'` ⇒ 历史**真的被完整扫过** */
  scanned: boolean;
  /** 非 `complete` 时的原因（原文，供 FAIL 提示定位） */
  reason?: string;
}

/**
 * 读取调用方对「要不要 git 历史」的**显式声明**
 *
 * 认三种写法：`--require-history[=<值>]` · `--no-require-history` ·
 * 环境变量 `ABOX_SECURITY_SCAN_REQUIRE_HISTORY=<值>`。
 * 一个都不出现 ⇒ `undefined`（**未声明** ⇒ 按「要求」处理）。
 *
 * ⚠️ 刻意**不设缺省 `true`**：缺省会让「忘了声明」与「声明了要」在输出里无从分辨，
 *    而本判据的全部价值就在于把这两者分开。
 */
function readDeclaredRequireHistory(argv: string[]): RequireHistory {
  const asBool = (raw: string): boolean => !/^(0|false|no|off)$/i.test(raw.trim());
  for (const a of argv) {
    const m = /^--(no-)?require-history(?:=(.*))?$/.exec(a);
    if (!m) continue;
    if (m[1]) return false; // --no-require-history
    return asBool(m[2] ?? 'true'); // --require-history[=<值>]
  }
  const env = process.env.ABOX_SECURITY_SCAN_REQUIRE_HISTORY;
  if (env === undefined || env.trim() === '') return undefined;
  return asBool(env);
}

/**
 * 跑 `git` 并**拿回** stdout —— 刻意**不用** `execFileSync` 的默认 stdio（= `'pipe'`）
 *
 * ⚠️ 本机（Windows · 机器级限制）**无法为子进程创建匿名管道**：`spawnSync` /
 *    `execFileSync` 只要走 `pipe` 一律 `status=null` + `EBUSY`。
 * ⚠️ 这里的坏形状**尤其隐蔽**：`scanGitHistory` 把 git 失败 `catch` 成
 *    「非 git 环境 ⇒ 历史未扫」并**返回 0 命中** ⇒ **门禁照样绿**，
 *    而「全历史密钥扫描」一次都没跑。恒绿比恒红更难发现（见本文件头注）。
 *    ⇒ 2026-10-09（κ 批次：外部垫片退役）改为「临时文件重定向 + 退出后回读」，
 *      行为对齐 `pipe`，且不依赖任何仓库外物料。
 */
function gitOut(root: string, args: string[]): string {
  const tag = `abox-secscan-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const outFile = path.join(os.tmpdir(), `${tag}.out.log`);
  const errFile = path.join(os.tmpdir(), `${tag}.err.log`);
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync('git', args, { cwd: root, stdio: ['ignore', fdOut, fdErr] });
  } finally {
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  let out = '';
  try {
    out = fs.readFileSync(outFile, 'utf8');
  } catch {
    out = '';
  }
  for (const f of [outFile, errFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* 临时目录残留由系统兜底，不影响扫描结论 */
    }
  }
  // 行为对齐 execFileSync：启动失败 / 非零退出 ⇒ **抛**（由调用方决定怎么兜）
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Command failed: git ${args.join(' ')} — exit ${r.status}`);
  return out;
}

/**
 * 「历史不完整」这一族命中的**唯一构造入口**
 *
 * 两个入口（git 跑不起来 / 浅 clone）共用一条等级规则，就是为了保证：
 * **开关只有 `requireHistory` 一个** —— 开关越多，越容易「忘了声明」，
 * 而「忘了声明」正是这一族缺陷的原型。
 */
function incompleteHistoryHit(
  opts: ScanOptions,
  pattern: string,
  snippet: string,
  hintRequired: string,
  hintDeclared: string,
): Hit {
  const required = opts.requireHistory !== false; // 未声明 ⇒ 要求
  return {
    level: required ? 'FAIL' : 'NOTE',
    pattern,
    where: 'security:scan 前置条件',
    hint: required ? hintRequired : hintDeclared,
    snippet,
  };
}

/**
 * git 跑不起来时的收口 —— **不再静默返回 0 命中**
 *
 * κ-2 之前这里直接 `return []`，于是「历史没扫」与「历史扫干净了」在输出里
 * 是同一行（`【二 · git 历史扫描】 无命中`）。现在二者必须分开：
 *   · 未声明 / 声明 `requireHistory: true` ⇒ **FAIL**（这一条绿是假的，不许过关）；
 *   · 显式声明 `requireHistory: false` ⇒ `NOTE`（放过，但**可见**、可审计）。
 */
function historyNotScanned(hits: Hit[], err: unknown, opts: ScanOptions): HistoryResult {
  const reason = err instanceof Error ? err.message : String(err);
  hits.push(
    incompleteHistoryHit(
      opts,
      'git 历史未扫描',
      redact(reason),
      'git 历史**一次都没扫到**（原因见 snippet）—— 此时「无 FAIL 级命中」是假绿。若此处**确实**没有 git 历史（解包副本 / 未装 git），请显式声明 --require-history=false 或 ABOX_SECURITY_SCAN_REQUIRE_HISTORY=0；否则先修好 git 再跑。',
      'git 历史未扫描，但调用方已**显式声明** requireHistory=false —— 本条不阻断；请定期确认此处确实不该有 git 历史。',
    ),
  );
  return { hits, mode: 'unavailable', scanned: false, reason };
}

/**
 * 浅 clone 检测 —— CI `actions/checkout` 缺 `fetch-depth: 0` 的**直接后果**
 *
 * ⭐ 这条不是「多抓一类问题」，而是把上一轮刚补的那条防线**变成硬约束**：
 *    `fetch-depth: 0` 若只写在 `ci.yml` 的注释里，就没有任何机械校验在看住它
 *    （一个正确性前提只写在注释里、没有门禁检查，正是本项目的复发模式）。
 *    现在由门禁自己看住：谁把它改回 1，CI 当场红。
 *
 * ⚠️ 必须**单独问一句**，不能靠「git log 跑没跑成功」推断 —— 本机实测：
 *      · 完整 clone  ⇒ `git rev-parse --is-shallow-repository` = `false`
 *      · `--depth 1` ⇒ `true`，而 `git log --all -p` **照样 exit 0**
 *    ⇒ 浅仓库在旧判据下是 `scanned: true`，即「安静地绿、不报错」的原形。
 */
function isShallowRepository(git: (...args: string[]) => string): boolean {
  return git('rev-parse', '--is-shallow-repository').trim() === 'true';
}

function shallowHistoryHit(opts: ScanOptions): Hit {
  return incompleteHistoryHit(
    opts,
    'git 历史被截断（浅 clone）',
    'git rev-parse --is-shallow-repository → true',
    '当前仓库是**浅 clone** —— `git log --all -p` 只能看到被截断的那一段，「全历史密钥扫描」名存实亡。CI 侧根因几乎总是 `actions/checkout` **缺了 `fetch-depth: 0`**（默认 1）；本地则是 `git clone --depth N`。若确认此处**不需要**全历史，显式声明 --require-history=false 或 ABOX_SECURITY_SCAN_REQUIRE_HISTORY=0。',
    '当前仓库是浅 clone，git 历史不完整；调用方已**显式声明** requireHistory=false —— 本条不阻断。',
  );
}

function scanGitHistory(root: string, opts: ScanOptions): HistoryResult {
  const hits: Hit[] = [];
  const git = (...args: string[]): string => gitOut(root, args);

  // 2a-0. 浅 clone —— **先于**任何扫描判一次（理由见 `isShallowRepository`）
  let shallow = false;
  try {
    shallow = isShallowRepository(git);
  } catch (e) {
    return historyNotScanned(hits, e, opts);
  }
  // ⚠️ 不 return —— 被截断的那一段仍然照扫：多报一条总比静默强，
  //    但 `scanned` 必须是 false（结论里「历史 0 命中」不能被当成扫干净了）。
  if (shallow) hits.push(shallowHistoryHit(opts));

  // 2a. 历史里出现过的敏感文件名（哪怕已删除）
  let names = '';
  try {
    names = git('log', '--all', '--pretty=format:', '--name-only', '--diff-filter=AD');
  } catch (e) {
    return historyNotScanned(hits, e, opts); // 非 git 环境（如解包副本）—— **必须红或显式声明**
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
  } catch (e) {
    return historyNotScanned(hits, e, opts); // 内容扫描没跑完 ⇒ 同样不许算「扫过」
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
  return {
    hits,
    mode: shallow ? 'shallow' : 'complete',
    scanned: !shallow,
    reason: shallow ? '仓库为浅 clone —— git 历史被截断' : undefined,
  };
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

  for (const file of walk(apiSrc).files) {
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

  // ⭐ κ-2：「历史不完整 ⇒ 必须红」这条判据**自身**的自证
  //    两个入口（git 跑不起来 / 浅 clone）× 三种声明（未声明 / true / false）：
  //      未声明 与 true ⇒ FAIL（不许退化成静默 0 命中）；显式 false ⇒ NOTE（放过但必须可见）。
  //    两个入口共用一条等级规则是刻意的 —— 判据一旦分家，就会出现「只声明了一半」的空档。
  //    判据失灵（比如有人把 `level` 改回 WARN），这里当场失败。
  const incompleteCases: Array<[ScanOptions, 'FAIL' | 'NOTE']> = [
    [{ requireHistory: undefined }, 'FAIL'], // 未声明 ⇒ 按「要求」处理
    [{ requireHistory: true }, 'FAIL'],
    [{ requireHistory: false }, 'NOTE'],
  ];
  for (const [opts, want] of incompleteCases) {
    const declared = String(opts.requireHistory);
    const viaErr = historyNotScanned([], new Error('git 不可用（自证样本）'), opts).hits[0]?.level;
    if (viaErr !== want) {
      missed.push(
        `历史未扫判据失效（期望 ${want}，实得 ${String(viaErr)}）：requireHistory=${declared}`,
      );
    }
    const viaShallow = shallowHistoryHit(opts).level;
    if (viaShallow !== want) {
      missed.push(
        `浅 clone 判据失效（期望 ${want}，实得 ${viaShallow}）：requireHistory=${declared}`,
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

export function run(opts: ScanOptions): {
  workspace: Hit[];
  history: Hit[];
  logs: Hit[];
  /** git 历史是否**完整扫过**（false ⇒ 未扫 / 被截断，结论里不含完整历史） */
  historyScanned: boolean;
  /** `historyScanned === false` 时的原因（原文） */
  historyReason?: string;
  /** 历史的**三态**，与 `historyScanned` 同源（`complete` ⇔ `scanned === true`） */
  historyMode: GitHistoryMode;
} {
  const root = findRepoRoot(__dirname);
  selfTest();
  const hs = scanGitHistory(root, opts);
  const ws = scanWorkspace(root);
  return {
    // 「跳过的目录里不许有真源码」这道自校验挂在工作区命中里 —— 与扫描同一次遍历取得
    workspace: [...ws.hits, ...assertSkipDirsAreNotSource(root, ws.skippedDirs)],
    history: hs.hits,
    logs: scanLogs(root),
    historyScanned: hs.scanned,
    historyReason: hs.reason,
    historyMode: hs.mode,
  };
}

function main(): void {
  const root = findRepoRoot(__dirname);
  // ⚠️ 声明**只能**来自命令行 / 环境变量 —— main 自己不许替调用方选。
  const opts: ScanOptions = { requireHistory: readDeclaredRequireHistory(process.argv.slice(2)) };
  const { workspace, history, logs, historyScanned, historyReason, historyMode } = run(opts);
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
  console.log(
    `声明：requireHistory=${String(opts.requireHistory)}${
      opts.requireHistory === undefined ? '（**未声明** ⇒ 按「要求」处理）' : ''
    }`,
  );
  show('一 · 工作区密钥扫描', workspace);
  show('二 · git 历史扫描', history);
  show('三 · 日志脱敏核查', logs);

  console.log(
    `\n合计命中 ${all.length} 项（FAIL ${fail.length} / WARN ${warn.length} / 显式豁免 ${note.length}）` +
      ` —— 工作区 ${workspace.length} · 历史 ${history.length} · 日志 ${logs.length}` +
      // ⚠️ 这一行是**契约**：CI 上线前人工核对的就是它（grep `[git-history] mode=`）。
      //    中文那行只是给人看的，措辞会随版本变，不能当契约。
      `\n[git-history] mode=${historyMode}` +
      `\ngit 历史扫描：${
        historyScanned
          ? '已执行（完整历史）'
          : `**不完整** —— ${historyReason ?? '未执行'}（本次结论不含完整 git 历史）`
      }`,
  );

  // ⭐ κ-2 复核：把「这次到底扫没扫 git 历史」塞进**最后一行**。
  //   `gate.mjs` 的 `reportOf()` 在没有专门正则时兜底展示最后一行 —— 这一路**不依赖
  //   任何正则被维护**。后来 gate.mjs 侧补了 `REPORT_RE['security:scan']`（命中即
  //   `return hits`，兜底随之失效）⇒ 现在两条路**都必须**带得出来，且互为备份：
  //     ① 正则命中路径：上面 `[git-history] mode=` 与 `git 历史扫描：` 两行被抽走；
  //     ② 正则失配 / 被删路径：兜底回最后一行，而句尾仍挂着 `· git 历史：…`。
  //   ⇒ 任一路径烂掉，另一条仍可见；这不是靠两处同步维持的，是两条独立通路。
  //   ⚠️ 状态**现算**，不新增写死文案：与 958 行同源（`historyScanned` / `historyMode`）。
  const declaredNoHistory = opts.requireHistory === false;
  // ⭐ 用 `historyScanned` 而不是 `historyMode === 'complete'`：两者恒等（`run()` 的
  //   返回契约 `scanned ⇔ mode === 'complete'`），但写成本文件 958 行**同一个谓词** ——
  //   「扫没扫到」便不再有第二个判断点（派生 > 同步）。
  const historyState = historyScanned
    ? '已执行（完整历史）'
    : `未执行（${historyMode === 'shallow' ? '浅 clone' : 'git 不可用'}${
        declaredNoHistory ? ' · 已显式声明 requireHistory=false' : ''
      }）`;

  if (fail.length) {
    console.log(
      `\n✘ 安全扫描未通过：${fail.length} 项阻断（必须处理，不可带病上线） · git 历史：${historyState}`,
    );
    process.exit(1);
  }
  console.log(
    `\n✔ 安全扫描通过：无 FAIL 级命中${warn.length ? `（${warn.length} 项 WARN 待人工确认）` : ''}` +
      ` · git 历史：${historyState}`,
  );
}

if (require.main === module) main();
