/**
 * 订单状态机「声明 ↔ 生产写入点」机械对账（M5-7 · 缺陷 #79 的防复发门禁）
 *
 * ## 为什么需要它
 * 2026-09-18 的整体审查盘出一个 **P0**：`ab_order` 的 `cooked` / `delivering` / `delivered`
 * **三个状态全仓零写入点** —— 订单支付后永远停在 `cut_off`，团长「确认取餐」永远返回零值
 * （**不报错**），**佣金永远不产生**，自动确认跑批每天把当天全部订单报成「履约异常」。
 *
 * 而 **19 道门禁全绿、e2e 969 条全绿**。为什么一条都没红：
 *   · 没有任何门禁检查「**状态机声明了哪些状态** ↔ **生产代码真的写过哪些状态**」；
 *   · `canTransit()` 是死代码（只被单测引用），状态机是**纯声明表**；
 *   · e2e 夹具**直接 `UPDATE ab_order SET status='delivered'`** 造数据 → 测试永远从链路
 *     **中间**开始，上游那次状态推进有没有实现，它**看不见**。
 * 这正是本项目反复出现的同一族：**「多处表述 + 没有机械对账」**（#15 / #67 / #76），
 * 只不过 #79 的形态是「**根本没写**」而不是「写错了」—— 连一条报错都不会有。
 *
 * ## 它做哪两件事（都是**状态级**，不是**边级** —— 如实标注边界）
 *   ① **declared ⊆ written**：状态机里作为**迁移目标**出现过的每个状态，
 *      必须在生产代码里至少有一个**写入点**。缺 → FAIL（`#79` 就是这一条第一次生效时的形态）。
 *   ② **written ⊆ declared**：生产代码里写过的状态（含建单初始态）必须都在状态机里登记过。
 *      出现没登记的字面量 → FAIL（防 #67 那类「跨端字面量写错、没人报错」）。
 *
 * ⚠️ **本门禁不验证「边」**：它证明不了 `cut_off → cooked` 这条**迁移**是合法的，
 *    只证明 `cooked` 这个**状态**有人写。边级校验需要把写入语句与它的 `WHERE status = ?`
 *    守卫配起来，而守卫形态多变（`IN (:...ok)` / 变量 / 事务快照），静态配对必然误报。
 *    故本门禁对**无法静态判定目标状态**的写入点**显式列出为 WARN**（绝不静默跳过），
 *    并统计「写入点锚定数 ↔ 已解析数」的差额 —— 差额 > 0 时人工必须看一眼那份清单。
 *
 * ## 为什么「声明」走 import 而不是解析源码
 * `ORDER_TRANSITIONS` 是 TS 对象字面量，用正则解析要自己实现常量求值，而这正是
 * `schema-parity` 的教训（**让框架/运行时自己算一遍**）。这里直接 `import` 真值，
 * 与 `route-audit` 用 `Reflect.getMetadata` 读装饰器元数据同一思路。
 *
 * ## 自证能力（每次运行必跑，不通过则脚本自身失败）
 * 把判定逻辑抽成纯函数 `judge(targets, exempt)`，每轮用**人为构造的三份输入**跑它：
 *   ① 从 `targets` 里删掉一个真实存在的目标 → **必须报出该状态**（证明 ① 不是恒真）
 *   ② 往 `targets` 里塞一个状态机里没有的状态 → **必须报出该状态**（证明 ② 不是恒真）
 *   ③ 给 `exempt` 塞一个**已经写入了的**状态 → **必须报「豁免已过期」**（证明豁免不会腐烂）
 * 任一项报不出来 → 脚本失败。**「恒绿的检查比没有检查更糟」**。
 *
 * ## 豁免表是**会自收紧**的
 * 未实装的目标状态写在 `UNIMPLEMENTED_TARGETS` 里（每条带理由 + 账本引用），
 * 于是「能力没做」这件事**在 CI 输出里是可见的**，而不是一个看不见的洞；
 * 而一旦有人把它实现了，第 ③ 项自证会立刻要求**删掉豁免** —— 豁免只能如实存在，不能腐烂。
 *
 * 运行：`gate.mjs state:audit`（或 `gate.mjs all` 的一部分）
 */
import * as fs from 'fs';
import * as path from 'path';

import { OrderStatus } from '@abox/shared-types';

import { ORDER_TRANSITIONS } from './order-state-machine';

// ---------------------------------------------------------------------------
// 声明侧（源 A）
// ---------------------------------------------------------------------------

/** 状态机里出现过的全部状态（键 ∪ 值） */
const DECLARED_ALL: string[] = Array.from(
  new Set(Object.entries(ORDER_TRANSITIONS).flatMap(([from, tos]) => [from, ...(tos as string[])])),
);

/** 作为**迁移目标**出现过的状态（值集合） */
const DECLARED_TARGETS: string[] = Array.from(new Set(Object.values(ORDER_TRANSITIONS).flat()));

/** `OrderStatus` 枚举的「成员名 → DB 取值」，用于把 `OrderStatus.CUT_OFF` 归一 */
const ENUM_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(OrderStatus as Record<string, string>),
);
/** `OrderStatus` 枚举的全部**取值**，用于校验字面量写法 */
const ENUM_VALUES = new Set(Object.values(OrderStatus as Record<string, string>));

/**
 * ⚠️ **已声明为迁移目标、但全仓零写入点**的状态（= 该能力未实装）
 *
 * 这不是「允许」，而是**如实登记**：报告 §三.1 给的三个处置里选的是第 ③ 条
 * （「维持现状但如实登记，并在测试清单里写明相关测试项跳过」），因为
 * **补实现属产品范围裁决**，不该由一次静态审计单方面改掉业务链路。
 *
 * 本表的纪律：**每一条都必须带理由与账本引用**；一旦有人把它实现了，
 * 自证第 ③ 项会要求立刻删除本条 —— 不允许它悄悄变成历史包袱。
 */
const UNIMPLEMENTED_TARGETS: Record<string, string> = {
  [OrderStatus.COOKED]:
    '履约链 T7（供应商出餐确认推进订单）未实装 —— 见《缺陷与陷阱》#79 / 整体审查报告 §三.1',
  [OrderStatus.DELIVERING]: '履约链 T8（配送单驱动订单）未实装 —— 见 #79',
  [OrderStatus.DELIVERED]: '履约链 T9（运营标记送达）未实装 —— 见 #79',
  [OrderStatus.REFUNDING]:
    'M4-3 起**订单**不再进入 refunding（通道进度改由 `ab_refund.status` 表达，订单审批通过即 `refunded`）' +
    '—— `ORDER_TRANSITIONS[refund_applying]` 仍留着这条边未同步，属**声明表 ↔ 实现的口径漂移**，待产品/契约侧裁决',
};

// ---------------------------------------------------------------------------
// 写入侧（源 B）—— 机械提取
// ---------------------------------------------------------------------------

type SiteKind = 'write' | 'initial';

interface Site {
  file: string;
  line: number;
  kind: SiteKind;
  /** 归一后的 DB 取值；`null` = 目标状态是动态值、静态推不出来 */
  status: string | null;
  /** 目标状态写成 `OrderStatus.<名>` 时的**成员名**（用于抓拼错的枚举成员） */
  enumName?: string;
  /** 该成员名在 `OrderStatus` 里**不存在** → 运行期是 `undefined` */
  unknownEnumMember?: boolean;
  raw: string;
}

/**
 * 订单状态写入点的**锚点形态**（捕获组 = `status:` 右侧的原文）。
 *
 * ⚠️ 两条设计决定，都是被反证测试逼出来的：
 *
 * ① **全部显式写出 `Order` 类名**：`refund.service.ts` 里同时有
 *    `.set({status: RefundStatus.X})` 与 `.set({status: OrderStatus.X})`，
 *    不锚定类名就会把**退款单状态**当成订单状态 —— 那样 ② 会报出一堆
 *    「状态机里没有的状态」，红是红了，但归因完全跑偏。
 *
 * ② **捕获「任意原文」再分类**，而不是只匹配两种合法写法。
 *    首版只匹配 `OrderStatus.X` 与 `'lit'` 两种形态，于是
 *    `status: 'ghost_state'`（一个**拼错的字面量**）落不进任何分支、
 *    被当成「动态值 → WARN」**静默放过** —— 反证测试当场抓到
 *    （塞入 `'ghost_state'` 后门禁仍 exit 0）。这正是本门禁要防的那一类缺陷
 *    （#67 跨端字面量写错，无人报错），差一点就在门禁自己身上复发。
 */
const PATTERNS: Array<{ kind: SiteKind; re: RegExp }> = [
  // createQueryBuilder().update(Order).set({ … status: <RHS> … })
  {
    kind: 'write',
    re: /\.update\(\s*Order\s*\)[\s\S]{0,600}?\.set\([\s\S]{0,400}?\bstatus:\s*([^,}\n]+)/g,
  },
  // repository.update(Order, { … status: <RHS> … })
  {
    kind: 'write',
    re: /\.update\(\s*Order\s*,\s*\{[\s\S]{0,400}?\bstatus:\s*([^,}\n]+)/g,
  },
  // getRepository(Order).update({ id }, { … status: <RHS> … })
  {
    kind: 'write',
    re: /getRepository\(\s*Order\s*\)\s*\.update\([\s\S]{0,400}?\bstatus:\s*([^,}\n]+)/g,
  },
  // 属性赋值：`entity.status = OrderStatus.X`
  //
  // ⚠️ 本形态**只收 `OrderStatus.` 前缀**，不像上面三条那样也收字面量 ——
  //    因为「属性赋值」的原句里**没有类名可锚定**：`row.status = 'success'`
  //    （佣金付款行）、`assignment.status = 'active'`（餐次分配）、`order.status = 'cancelled'`
  //    在文本上长得一模一样。放开字面量会立刻产出 4 条假红（反证测试实测：
  //    `pending / applying / success / active` 全被误判成「订单状态写错」），
  //    而**假红会让真告警被一起忽略**。
  //    代价（如实标注的边界）：`order.status = 'cancelled'` 这种「属性赋值 + 裸字面量」
  //    的写法**在本门禁视野之外** —— 本仓当前零处这么写，且新增写入点一律走
  //    `.update(...).set(...)`（上面三条已覆盖）。
  { kind: 'write', re: /\.status\s*=\s*(OrderStatus\.[A-Za-z0-9_]+)/g },
  // 建单初始态：getRepository(Order).create({ … status: <RHS> … })
  {
    kind: 'initial',
    re: /getRepository\(\s*Order\s*\)\s*\.create\([\s\S]{0,1200}?\bstatus:\s*([^,}\n]+)/g,
  },
];

/** 把 `status:` 右侧的原文分类（**静态可判定的必须判定，只有真动态才留给 WARN**） */
function classify(rhs: string): Pick<Site, 'status' | 'enumName' | 'unknownEnumMember'> {
  const t = rhs.trim();
  const asEnum = /^OrderStatus\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
  if (asEnum) {
    const name = asEnum[1];
    const val = ENUM_BY_NAME[name];
    // 成员名打错（如 `COOKD`）：运行期 `OrderStatus.COOKD` 是 `undefined`，
    // 于是这一列被写成 NULL —— 而 TypeScript 拦不住跨包字符串访问，
    // 且 `undefined` 写进 DB 不会报错，正是「不报错的错」。
    return val === undefined
      ? { status: null, enumName: name, unknownEnumMember: true }
      : { status: val, enumName: name, unknownEnumMember: false };
  }
  const asLit = /^'([a-z_]+)'$/.exec(t);
  if (asLit) return { status: asLit[1], unknownEnumMember: false };
  return { status: null, unknownEnumMember: false };
}

/** 「订单更新锚点」—— 用来做**完整性核对**（锚定数 ↔ 已解析数） */
const ANCHORS: RegExp[] = [
  /\.update\(\s*Order\s*\)/g,
  /getRepository\(\s*Order\s*\)\s*\.update\(/g,
];

interface FileScan {
  sites: Site[];
  /** 锚点数（订单更新语句） */
  anchors: number;
  /** 未能解析出目标状态的锚点所在行 */
  unresolvedLines: number[];
}

function scanSource(file: string, text: string): FileScan {
  // 行首字符下标表 → 二分定位（不用「按行正则」：写入点是**跨行**的，
  // 必须整文件扫描 + 事后换算行号，否则 `.\n  update(Order)\n  .set({` 这种写法会整片漏掉）
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  const lineOf = (idx: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const sites: Site[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      const cls = classify(m[1]);
      sites.push({
        file,
        line: lineOf(m.index),
        kind: p.kind,
        status: cls.status,
        enumName: cls.enumName,
        unknownEnumMember: cls.unknownEnumMember,
        raw: m[0].replace(/\s+/g, ' ').slice(-90),
      });
    }
  }

  // 完整性：每个订单更新锚点，若**同一范围内**没有命中任何 write 站点 → 记为「未解析」
  //
  // ⚠️ 比对必须**按行**而不是按字符下标：锚点 `.update(Order)` 落在行的**中间**，
  //    而站点记录的是**行首**下标 —— 拿 `w >= a` 去比会**恒假**（每一处都被判为未解析）。
  //    这正是本项目反复踩的「观测口径不一致 → 结论恒真/恒假」那一类错（首跑即踩到，
  //    11 处锚点全报未解析 —— 而其中 9 处其实是解析出来了的）。
  const anchorIdx: number[] = [];
  for (const re of ANCHORS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) anchorIdx.push(m.index);
  }
  const writeLines = new Set(sites.filter((s) => s.kind === 'write').map((s) => s.line));
  const unresolvedLines = anchorIdx
    .filter((a) => {
      // ① 这条 `UPDATE ab_order` **根本没碰 status**（如只改 `balance_used`）→ 不是状态写入，跳过。
      //    不过滤掉它会产出一片纯噪音，而**噪音会让真正的告警被忽略**（同 #55 的教训）。
      const win = text.slice(a, a + 600);
      if (!/\bstatus\s*[:=]/.test(win)) return false;
      // ② 碰了 status，但窗口里没有任何**能解析出目标状态**的站点 → 确实未解析
      const ln = lineOf(a);
      return ![...writeLines].some((wl) => wl >= ln && wl <= ln + 24);
    })
    .map((a) => lineOf(a));

  return { sites, anchors: anchorIdx.length, unresolvedLines };
}

// ---------------------------------------------------------------------------
// 判定（纯函数 —— 便于自证时喂人造输入）
// ---------------------------------------------------------------------------

interface Finding {
  level: 'FAIL' | 'WARN';
  rule: string;
  detail: string;
}

function judge(
  targets: Set<string>,
  initial: Set<string>,
  exempt: Record<string, string>,
): Finding[] {
  const out: Finding[] = [];

  // ① declared ⊆ written（豁免项除外）
  for (const t of DECLARED_TARGETS) {
    if (targets.has(t)) continue;
    if (Object.prototype.hasOwnProperty.call(exempt, t)) continue;
    out.push({
      level: 'FAIL',
      rule: 'declared-not-written',
      detail:
        `状态机把 \`${t}\` 声明为**迁移目标**，但全仓**没有任何写入点** —— ` +
        `该状态可达性为零，下游一切依赖它的逻辑（时间线点亮 / 确认收货 / 计佣 / 跑批告警）永远不会被触发。` +
        `要么补实现，要么在 \`UNIMPLEMENTED_TARGETS\` 里如实登记理由（#79 就是这个形态）`,
    });
  }

  // ② written ⊆ declared（含建单初始态）
  for (const s of [...targets, ...initial]) {
    if (DECLARED_ALL.includes(s)) continue;
    const enumHasIt = ENUM_VALUES.has(s);
    out.push({
      level: 'FAIL',
      rule: 'written-not-declared',
      detail:
        `生产代码写入了状态 \`${s}\`，而状态机（\`ORDER_TRANSITIONS\`）**从未登记过它**` +
        (enumHasIt
          ? '（`OrderStatus` 枚举里有这个取值，但状态机没把它列为任何迁移的源或目标）'
          : '—— ⚠️ **连 `OrderStatus` 枚举里都没有这个取值**，几乎可以肯定是字面量写错了') +
        `。这类「跨端/跨文件字面量写错」不会有任何运行时报错（同 #67）：` +
        `状态位被写成一个谁都不认识的值，所有 \`status === 'x'\` 判定静默为假`,
    });
  }

  // ③ 豁免过期：已经写入了的豁免项必须删掉
  for (const e of Object.keys(exempt)) {
    if (!targets.has(e)) continue;
    out.push({
      level: 'FAIL',
      rule: 'exemption-stale',
      detail:
        `\`UNIMPLEMENTED_TARGETS\` 里的 \`${e}\` 现在**已经有写入点**了 —— 豁免已过期，必须删除，` +
        `否则「未实装清单」会变成一份**永远对不上现实**的文档（而它恰恰是人工测试决定「哪些项可跳过」的依据）`,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.spec.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

function main(): void {
  const srcRoot = path.resolve(__dirname, '..', '..');
  const self = path.resolve(__filename);
  const files = walk(srcRoot).filter((f) => path.resolve(f) !== self);

  const all: Site[] = [];
  let anchors = 0;
  const unresolved: Array<{ file: string; line: number }> = [];
  for (const f of files) {
    const scan = scanSource(f, fs.readFileSync(f, 'utf8'));
    all.push(...scan.sites);
    anchors += scan.anchors;
    for (const l of scan.unresolvedLines) {
      unresolved.push({ file: path.relative(srcRoot, f).replace(/\\/g, '/'), line: l });
    }
  }

  const writes = all.filter((s) => s.kind === 'write');
  const inits = all.filter((s) => s.kind === 'initial');
  const targets = new Set(writes.map((s) => s.status).filter((s): s is string => !!s));
  const initial = new Set(inits.map((s) => s.status).filter((s): s is string => !!s));
  /** 枚举成员名打错（`OrderStatus.COOKD`）—— 与「动态值」是**两种不同的病**，分开报 */
  const badEnum = all.filter((s) => s.unknownEnumMember);
  const unparsed = all.filter((s) => s.status === null && !s.unknownEnumMember);

  console.log(
    `源：${files.length} 个 *.ts → 订单状态写入点 ${all.length} 处（迁移 ${writes.length} · 建单初始 ${inits.length}）`,
  );
  console.log(
    `  声明侧：状态机 ${Object.keys(ORDER_TRANSITIONS).length} 个源状态 · ` +
      `${DECLARED_TARGETS.length} 个迁移目标 · 已豁免（未实装）${Object.keys(UNIMPLEMENTED_TARGETS).length} 个`,
  );
  console.log(
    `  写入侧：实际写过 ${targets.size} 个状态 · 完整性核对 锚点 ${anchors} / 已解析写入 ${writes.length}` +
      `${unresolved.length ? ` · ⚠ 待人工确认 ${unresolved.length}` : ''}`,
  );

  if (process.argv.includes('--list')) {
    console.log('\n写入点清单（文件:行 · 类别 · 目标状态）：');
    for (const s of [...all].sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line))) {
      console.log(
        `  ${s.file.replace(srcRoot, '').replace(/\\/g, '/').replace(/^\//, '')}:${s.line}` +
          `  [${s.kind}]  ${s.status ?? (s.unknownEnumMember ? `⚠ 枚举无此成员 OrderStatus.${s.enumName}` : '⚠ 动态值')}  ‹ ${s.raw}`,
      );
    }
  }

  const findings: Finding[] = judge(targets, initial, UNIMPLEMENTED_TARGETS);
  for (const s of badEnum) {
    findings.push({
      level: 'FAIL',
      rule: 'unknown-enum-member',
      detail:
        `${s.file.replace(srcRoot, '').replace(/\\/g, '/')}:${s.line} 写入 ` +
        `\`status: OrderStatus.${s.enumName}\` —— \`OrderStatus\` 里**没有这个成员**。` +
        `运行期它求值为 \`undefined\`：**不报错**、被写成一列 NULL，而所有 ` +
        `\`status === '…'\` 判定静默为假（同 #67：跨端字面量写错，没有任何人会喊）`,
    });
  }

  // ---- 自证（三项都必须报得出来）----
  const selfProof: string[] = [];
  const sample = DECLARED_TARGETS.find((t) => targets.has(t));
  if (!sample) {
    selfProof.push('找不到任何「已写入的声明目标」用于自证样本 —— 扫描器可能整体失效');
  } else {
    // ⚠️ 这里**不能**顺手把 `sample` 加进豁免表 —— 那样它反而被 ① 放过，
    //    自证就变成了「用一条豁免去证明豁免有效」的循环论证（首版即踩到：
    //    自证①报「删掉 paid 后未报出」，而真因是样本自己把自己豁免了）。
    const reduced = new Set(targets);
    reduced.delete(sample);
    if (
      !judge(reduced, initial, UNIMPLEMENTED_TARGETS).some((f) => f.rule === 'declared-not-written')
    ) {
      selfProof.push(`自证①失败：从写入集合里删掉 \`${sample}\` 后未报出 declared-not-written`);
    }
  }
  {
    const polluted = new Set(targets);
    polluted.add('__self_proof_ghost__');
    if (
      !judge(polluted, initial, UNIMPLEMENTED_TARGETS).some(
        (f) => f.rule === 'written-not-declared',
      )
    ) {
      selfProof.push('自证②失败：向写入集合塞入未登记状态后未报出 written-not-declared');
    }
  }
  {
    const staleExempt = { ...UNIMPLEMENTED_TARGETS };
    const written = DECLARED_TARGETS.find((t) => targets.has(t));
    if (written) staleExempt[written] = '自证用过期豁免';
    if (!judge(targets, initial, staleExempt).some((f) => f.rule === 'exemption-stale')) {
      selfProof.push('自证③失败：给已写入的状态加豁免后未报出 exemption-stale');
    }
  }

  for (const f of findings) {
    console.log(`  ${f.level === 'FAIL' ? '✘' : '△'} [${f.rule}] ${f.detail}`);
  }
  for (const u of unresolved) {
    console.log(
      `  △ [unresolved-write] ${u.file}:${u.line} —— 这条订单更新写了 \`status\`，但**目标状态是个动态值**` +
        `（如驳回时回退到 \`ab_refund.order_status_before\` 记的原状态），静态推不出来。` +
        `本门禁的结论是**状态级**的，故它不会让门禁变红；但「声明的目标都有人写」这句话在**这一处**上未被覆盖，` +
        `人工审计请从这里看起`,
    );
  }
  if (unparsed.length) {
    console.log(
      `  △ [unparsed-status] ${unparsed.length} 处写入的 \`status\` 值解析为 null（同上）`,
    );
  }

  if (Object.keys(UNIMPLEMENTED_TARGETS).length) {
    console.log('\n⚠️ 已声明为迁移目标、但**全仓零写入点**（能力未实装 · 已如实登记）：');
    for (const [k, v] of Object.entries(UNIMPLEMENTED_TARGETS)) console.log(`    ${k}  ←  ${v}`);
    console.log(
      '    ⚠️ 这一份就是「人工测试可以跳过哪些项」的依据；实现任意一条后，本门禁会要求同步删除豁免。',
    );
  }

  if (selfProof.length) {
    console.log(`\n✘ 门禁自证未通过（${selfProof.length} 项）：`);
    for (const s of selfProof) console.log(`    ${s}`);
    console.log('    —— 自证不通过时，本门禁的「绿」不构成任何证据，故直接失败。');
    process.exit(1);
  }

  const fails = findings.filter((f) => f.level === 'FAIL');
  if (fails.length) {
    console.log(`\n✘ 状态机写入对账未通过：${fails.length} 项阻断`);
    process.exit(1);
  }

  console.log(
    `\n✔ 状态机写入对账通过：声明的迁移目标全部有写入点（已豁免 ${Object.keys(UNIMPLEMENTED_TARGETS).length} 项未实装）· ` +
      `写入的状态全部在状态机内 · 自证 3/3`,
  );
}

if (require.main === module) main();
