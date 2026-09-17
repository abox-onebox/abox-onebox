/**
 * 路由权限审计（M5-3 安全自检 · 越权机械对账）
 *
 * ## 为什么需要它
 * `AdminGuard` 的白名单判定是：
 * ```
 * if (roles && roles.length > 0 && !roles.includes(payload.role ?? '')) throw FORBIDDEN;
 * ```
 * 注意 `roles.length > 0` —— **没写 `@Roles` 的运营端点 = 对所有后台角色开放**，
 * 包括 `supplier`。而 `admin.guard.ts` 的注释亦承认这是「有意」的（如 A5 profile）。
 * 于是真正的风险是**它有意一次、忘了十次**：新加一个 `/admin/*` 端点忘了写 `@Roles`，
 * 代码照样跑、测试照样绿（没人用 supplier token 打过它），但供应商账号能拿到全平台数据。
 *
 * 这类缺陷的共同特征（同 #76）：**所有机械证据都是绿的，而对应的能力从未被验过一次**。
 * 故本脚本把「有没有写白名单」变成**机械对账**，并纳入 `gate.mjs`。
 *
 * ## 为什么用运行时反射，而不是解析源码
 * `@Roles` 存在**变量展开**形态（`@Roles(...FUND_ACTION_ROLES)`、
 * `@Roles(...FINANCE_VIEW_ROLES)` …）。正则/AST 解析要么漏展开、要么得自己实现
 * 常量求值 —— 这正是 M5-2 `schema-parity` 的教训：**让框架自己算一遍**。
 * `@Controller` / `@Get` / `@Roles` 本质都是 `Reflect.defineMetadata`，
 * **import 类文件即写入元数据**，用 `Reflect.getMetadata` 读到的就是求值后的真实白名单，
 * 无需 bootstrap Nest、无需连数据库。
 *
 * ## 自证能力
 * 每个 `.controller.ts` 文件**必须至少贡献 1 个带 `PATH_METADATA` 的类**，否则报错
 * （抓「import 失败 / 文件里没有 controller」这类静默漏扫）；另外脚本每次运行会
 * **人为构造一个违规端点走同一套规则**，必须被报出，报不出则脚本自身失败 ——
 * 「恒绿的检查比没有检查更糟」。
 *
 * 运行：`gate.mjs route:audit`（或 `gate.mjs all verify` 的一部分）
 */
import * as fs from 'fs';
import * as path from 'path';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { ADMIN_ROLES } from '../constants/admin-role';
import { ADMIN_ROLES_KEY, IS_PUBLIC_KEY } from '../decorators/auth.decorator';

/** 一个端点的审计记录 */
interface RouteRow {
  file: string;
  cls: string;
  /** 完整路径（类级 + 方法级已拼接） */
  full: string;
  method: HttpMethodName;
  /** 类级白名单（方法级未覆盖时生效）；`[]` 与 `null` 在守卫眼里**等价**（见下） */
  classRoles: string[] | null;
  /** 方法级白名单（**覆盖**类级，见 `getAllAndOverride`） */
  methodRoles: string[] | null;
  /**
   * 实际生效白名单。
   *
   * ⚠️ **`[]` 与 `null` 必须同等对待** —— `AdminGuard` 的判据是
   *    `roles && roles.length > 0`，而 `getAllAndOverride` 取的是「**方法级存在就用方法级**」。
   *    于是 `@Roles()`（空参数）会让 `roles = []` → 长度 0 → 守卫视为**未声明**
   *    → 默认对所有后台角色开放，**且它还会把类级的白名单覆盖掉**。
   *    本审计器第一版用 `!eff` 判「未声明」，会被 `[]` 骗过（空数组是 truthy）——
   *    **检查器与被执行逻辑的判据必须逐字对齐，否则检查器本身就是漏洞**。
   */
  effective: string[] | null;
  isPublic: boolean;
}

/** 与 `AdminGuard.canActivate` 完全同判据：`roles && roles.length > 0` */
const declared = (r: RouteRow): boolean => !!r.effective && r.effective.length > 0;

type HttpMethodName = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL' | 'OPTIONS' | 'HEAD';

interface Finding {
  rule: string;
  level: 'FAIL' | 'WARN';
  route: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// 规则常量的「单一真相」
// ---------------------------------------------------------------------------

/**
 * 资金 / 写动作路径特征 —— 命中即视为资金相关端点。
 * 判据与《接口规范》§九 的资金端点集合对齐（提现 / 余额 / 调账 / 结算 / 退款 / 佣金 / 出款）。
 */
const FUND_PATH = /(withdraw|balance|adjust|settle|refund|commission|payout|invoice)/i;

/** 只读角色 —— 不得出现在任何资金/写端点的白名单里 */
const READONLY_ROLES = ['viewer'];

/** 运营侧角色（供应商端点里出现即视为异常） */
const OPERATOR_ROLES = ['super_admin', 'admin', 'operator', 'finance'];

/**
 * 「默认对所有后台角色开放」的**显式豁免清单**（key = `METHOD /full/path`）。
 *
 * ⚠️ 加进这里的每一条都必须带理由 —— 这个清单是审计的产出物，
 *    不是让新端点随手绕过检查的后门。**清单只减不增是常态。**
 */
const DEFAULT_OPEN_EXEMPT: Record<string, string> = {
  // A5 后台个人资料：双主体契约（typ=admin 的任意角色都要能看自己的资料），
  // 且出参按 `role` 分流，不泄露他人数据。见 admin.guard.ts 注释。
  'GET /auth/profile': 'A5 双主体契约 · 出参按 role 分流，仅本人资料',
  'POST /auth/logout': 'A4 双主体契约 · 仅吊销自己的令牌',
};

/**
 * **免鉴权「调试类」端点**的显式豁免（key = `METHOD /full/path`）。
 *
 * 为什么单独一条规则：`@Public()` 已经让人放心了，于是「随手加个调试端点」时
 * 想的是「反正只是个 mock」—— 而免鉴权 + 能改业务状态 = 越权。判据不能只看
 * 「它是不是调试端点」，必须看「**它自己有没有 fail-closed**」。
 */
const PUBLIC_DEBUG_EXEMPT: Record<string, string> = {
  'POST /pay/mock/paid':
    '本地 mock 支付通道专用；已在 `PaymentService.simulatePaid()` 内按 `wxpay.isMock` ' +
    'fail-closed 抛 10004（M5-3 加固前只靠「real provider 恰好没实现可选方法」的隐式约定）',
};

/** 路径中含这些词即视为「调试类」端点 */
const DEBUG_PATH = /(mock|debug|__|seed|fixture|test)/i;

// ---------------------------------------------------------------------------
// 元数据读取
// ---------------------------------------------------------------------------

const METHOD_NAME: Record<number, HttpMethodName> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

const norm = (p: string | undefined): string => {
  const s = (p ?? '').trim();
  if (!s || s === '/') return '';
  return ('/' + s.replace(/^\/+|\/+$/g, '')).replace(/\/{2,}/g, '/');
};

/** 把类级与方法级路径拼成完整路由（与 Nest 的 `RouterExplorer` 同规则） */
function joinPath(base: string, sub: string): string {
  const b = norm(base);
  const s = norm(sub);
  return b + s || '/';
}

/**
 * 收集一个类上的全部端点。
 *
 * JS 保证字符串键按**插入顺序**遍历，故 `getOwnPropertyNames` 的顺序即**声明顺序** ——
 * 这是检查「静态路由是否被参数路由吸收」的依据。
 */
function collectFromClass(file: string, cls: unknown, out: RouteRow[]): boolean {
  const ctor = cls as { name: string; prototype: Record<string, unknown> };
  const basePath = Reflect.getMetadata(PATH_METADATA, ctor) as string | undefined;
  if (basePath === undefined) return false; // 不是 controller，跳过

  const classRoles = (Reflect.getMetadata(ADMIN_ROLES_KEY, ctor) as string[] | undefined) ?? null;
  const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctor) === true;

  for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
    if (name === 'constructor') continue;
    const fn = ctor.prototype[name];
    if (typeof fn !== 'function') continue;

    const subPath = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
    const reqMethod = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
    if (subPath === undefined || reqMethod === undefined) continue;

    const methodRoles = (Reflect.getMetadata(ADMIN_ROLES_KEY, fn) as string[] | undefined) ?? null;
    // `getAllAndOverride`：方法级覆盖类级
    const effective = methodRoles ?? classRoles;

    out.push({
      file,
      cls: ctor.name,
      full: joinPath(basePath, subPath),
      method: METHOD_NAME[reqMethod] ?? 'ALL',
      classRoles,
      methodRoles,
      effective,
      isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, fn) === true || classPublic,
    });
  }

  return true;
}

/** 在 `src` 下递归找全部 `*.controller.ts`（排除测试与 node_modules） */
function findControllerFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        walk(p);
      } else if (e.name.endsWith('.controller.ts')) {
        found.push(p);
      }
    }
  };
  walk(root);
  return found.sort();
}

// ---------------------------------------------------------------------------
// 规则引擎
// ---------------------------------------------------------------------------

const isAdmin = (r: RouteRow): boolean => /^\/admin(\/|$)/.test(r.full);
const isSupplier = (r: RouteRow): boolean => /^\/supplier(\/|$)/.test(r.full);
const isFund = (r: RouteRow): boolean => r.method !== 'GET' || FUND_PATH.test(r.full);
const key = (r: RouteRow): string => `${r.method} ${r.full}`;

/**
 * 对该端点跑全部规则 —— 返回它的问题列表。
 *
 * 规则集刻意保持「只标**正确性/契约**问题」，不标风格偏好（过度设计护栏）：
 *   R1 `/admin/*` 未声明白名单 → 默认对含 supplier 的全角色开放
 *   R2 `/supplier/*` 未显式声明 `supplier` → 运营账号可访问（跨角色）
 *   R3 方法级白名单不是类级的子集 → 覆盖导致**收窄被意外放宽**
 *   R4 资金/写端点白名单含只读角色 `viewer`
 *   R5 `/admin/*` 白名单含 `supplier` → 供应商可进运营端点（除刻意豁免）
 *   R6 白名单里的角色名必须是合法角色（拼错 = 该角色永久 403，功能静默坏）
 *   R7 后台作用域下出现 `@Public()` → 免鉴权
 *   R8 静态路由声明在参数路由之后 → 被参数路由吸收（声明顺序即匹配顺序）
 */
function auditRoute(r: RouteRow): Finding[] {
  const out: Finding[] = [];
  const isDeclared = declared(r);

  if (r.isPublic && (isAdmin(r) || isSupplier(r))) {
    out.push({
      rule: 'R7',
      level: 'FAIL',
      route: key(r),
      detail: '后台作用域端点被标记 @Public() —— 免鉴权即可访问',
    });
  }

  // R10：免鉴权的「调试类」端点 —— 必须显式登记它自己的 fail-closed 守卫
  if (r.isPublic && DEBUG_PATH.test(r.full) && !PUBLIC_DEBUG_EXEMPT[key(r)]) {
    out.push({
      rule: 'R10',
      level: 'FAIL',
      route: key(r),
      detail:
        '免鉴权的调试/mock 端点未登记守卫说明 —— 免鉴权 + 能改业务状态 = 越权；' +
        '请在 PUBLIC_DEBUG_EXEMPT 写明它自身如何 fail-closed（而非依赖调用方的隐式约定）',
    });
  }

  if (isAdmin(r) && !isDeclared) {
    if (!DEFAULT_OPEN_EXEMPT[key(r)]) {
      out.push({
        rule: 'R1',
        level: 'FAIL',
        route: key(r),
        detail:
          `未声明有效 @Roles${r.methodRoles !== null || r.classRoles !== null ? '（存在**空**声明，等同未声明）' : ''}` +
          ' → 默认对所有后台角色开放（**含 supplier / viewer**）；' +
          '确认应开放后列入 DEFAULT_OPEN_EXEMPT 并写明理由',
      });
    }
  }

  if (isSupplier(r)) {
    if (!isDeclared) {
      out.push({
        rule: 'R2',
        level: 'FAIL',
        route: key(r),
        detail: '供应商端点未声明有效 @Roles —— 运营账号亦可访问（跨角色）',
      });
    } else if (!r.effective!.includes('supplier')) {
      out.push({
        rule: 'R2',
        level: 'FAIL',
        route: key(r),
        detail: `供应商端点白名单未含 'supplier'：${r.effective!.join(', ')}`,
      });
    }
    const leaked = (r.effective ?? []).filter((x) => OPERATOR_ROLES.includes(x));
    if (leaked.length) {
      out.push({
        rule: 'R5',
        level: 'WARN',
        route: key(r),
        detail: `供应商端点白名单含运营角色 ${leaked.join(', ')} —— 需人工确认是否刻意`,
      });
    }
  }

  // R9：方法级**空**声明会把类级白名单抹掉（`getAllAndOverride` + `length > 0` 联合效应）
  if (r.methodRoles !== null && r.methodRoles.length === 0 && (r.classRoles?.length ?? 0) > 0) {
    out.push({
      rule: 'R9',
      level: 'FAIL',
      route: key(r),
      detail:
        `方法级 @Roles() 为空，**覆盖并抹掉**类级白名单 ${r.classRoles!.join(', ')}` +
        ' → 实际退化为「默认对全角色开放」，权限被放宽',
    });
  }

  if (r.classRoles && r.methodRoles && r.methodRoles.length > 0 && r.classRoles.length > 0) {
    const widened = r.methodRoles.filter((x) => !r.classRoles!.includes(x));
    if (widened.length) {
      out.push({
        rule: 'R3',
        level: 'FAIL',
        route: key(r),
        detail:
          `方法级白名单 ${r.methodRoles.join(', ')} 超出类级 ${r.classRoles.join(', ')}：` +
          `多出 ${widened.join(', ')}（方法级覆盖类级 → 收窄被意外放宽）`,
      });
    }
  }

  if (r.effective && isFund(r)) {
    const bad = r.effective.filter((x) => READONLY_ROLES.includes(x));
    if (bad.length) {
      out.push({
        rule: 'R4',
        level: 'FAIL',
        route: key(r),
        detail: `资金/写端点白名单含只读角色 ${bad.join(', ')}`,
      });
    }
  }

  if (isAdmin(r) && r.effective?.includes('supplier')) {
    out.push({
      rule: 'R5',
      level: 'WARN',
      route: key(r),
      detail: "运营端点白名单含 'supplier' —— 供应商会直接拿到全平台数据，需人工确认",
    });
  }

  const unknown = (r.effective ?? []).filter((x) => !ADMIN_ROLES.includes(x));
  if (unknown.length) {
    out.push({
      rule: 'R6',
      level: 'FAIL',
      route: key(r),
      detail: `白名单含未登记角色 ${unknown.join(', ')}（合法角色见 admin-role.ts ADMIN_ROLES）—— 拼错将使该角色永久 403`,
    });
  }

  return out;
}

/** R8：同 controller 内静态路由被参数路由吸收（声明顺序 = 匹配顺序） */
function auditOrder(rows: RouteRow[]): Finding[] {
  const out: Finding[] = [];
  const byClass = new Map<string, RouteRow[]>();
  for (const r of rows) {
    const k = `${r.file}::${r.cls}`;
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k)!.push(r);
  }
  for (const [k, list] of byClass) {
    const firstParam = list.findIndex((r) => r.full.includes(':'));
    if (firstParam < 0) continue;
    // 参数路由之后，任何「同层级静态路由」都不可达
    const problems = list
      .slice(firstParam + 1)
      .filter((r) => !r.full.includes(':'))
      .filter((r) => {
        const paramSegs = list[firstParam].full.split('/').length;
        return r.full.split('/').length === paramSegs;
      });
    for (const p of problems) {
      out.push({
        rule: 'R8',
        level: 'WARN',
        route: key(p),
        detail: `静态路由声明在参数路由之后（${k}）—— 与 ${list[firstParam].full} 同层级，可能被吸收`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 扫描全部 controller 并返回端点清单（导出供复用与单测）
 *
 * ⚠️ 自证的判据是「**文件导出了带 `@Controller` 的类**」，不是「文件贡献了端点」——
 *    项目里存在**空 controller 骨架**（有 `@Controller` 零方法，如
 *    `building.controller.ts`），那是开发阶段的占位，不是漏扫。
 *    判据写错会把正常文件报成漏扫（本脚本第一版就报错了 3 个）。
 */
export function collectRoutes(srcRoot: string): { rows: RouteRow[]; files: number } {
  const files = findControllerFiles(srcRoot);
  const rows: RouteRow[] = [];
  const silent: string[] = [];

  for (const f of files) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(f) as Record<string, unknown>;
    let seen = false;
    for (const v of Object.values(mod)) {
      if (collectFromClass(f, v, rows)) seen = true;
    }
    if (!seen) silent.push(path.relative(srcRoot, f));
  }

  // 自证一：每个 controller 文件都必须导出一个带 @Controller 的类 —— 否则说明静默漏扫
  if (silent.length) {
    throw new Error(
      `自证失败：${files.length} 个 *.controller.ts 中有 ${silent.length} 个未导出 controller 类 —— ` +
        `要么文件名误称，要么 import 失败被静默跳过。\n` +
        `  待查文件：\n${silent.map((s) => `    · ${s}`).join('\n')}`,
    );
  }
  return { rows, files: files.length };
}

/** 自证二：人为构造违规端点，规则必须报出（报不出 = 本脚本自身失效） */
function selfTest(): void {
  const fake: RouteRow = {
    file: '<selftest>',
    cls: 'SelfTestController',
    full: '/admin/__selftest__',
    method: 'POST',
    classRoles: null,
    methodRoles: null,
    effective: null,
    isPublic: false,
  };
  const found = auditRoute(fake);
  const hitR1 = found.some((x) => x.rule === 'R1');
  const noFalseR4 = !found.some((x) => x.rule === 'R4');

  // 资金端点白名单含只读角色 → 必须报 R4
  const hitFund = auditRoute({
    ...fake,
    full: '/admin/__selftest_withdraw__',
    effective: ['viewer'],
  }).some((x) => x.rule === 'R4');

  // ⭐ 空 `@Roles()` 抹掉类级白名单 → 必须报 R9（且同时因 length=0 报 R1）
  const emptyRoles = auditRoute({
    ...fake,
    classRoles: ['super_admin', 'admin'],
    methodRoles: [],
    effective: [],
  });
  const hitR9 = emptyRoles.some((x) => x.rule === 'R9');
  const hitR1OnEmpty = emptyRoles.some((x) => x.rule === 'R1');

  // 白名单拼错角色 → 必须报 R6
  const hitR6 = auditRoute({ ...fake, effective: ['super_admin', 'supper_admin'] }).some(
    (x) => x.rule === 'R6',
  );

  // 供应商端点漏了 supplier → 必须报 R2
  const hitR2 = auditRoute({ ...fake, full: '/supplier/__selftest__', effective: ['admin'] }).some(
    (x) => x.rule === 'R2',
  );

  // 免鉴权的调试端点未登记守卫 → 必须报 R10（且已登记的那一个必须不报）
  const hitR10 = auditRoute({
    ...fake,
    full: '/pay/mock/__selftest__',
    isPublic: true,
    effective: null,
  }).some((x) => x.rule === 'R10');
  const r10QuietForExempt = !auditRoute({
    ...fake,
    full: '/pay/mock/paid',
    method: 'POST',
    isPublic: true,
    effective: null,
  }).some((x) => x.rule === 'R10');

  const missed = [
    ['R1 未声明白名单', hitR1],
    ['R9 空声明抹掉类级', hitR9],
    ['R1 空声明亦视为未声明', hitR1OnEmpty],
    ['R6 角色名拼错', hitR6],
    ['R2 供应商端点漏 supplier', hitR2],
    ['R4 资金端点含 viewer', hitFund],
    ['R10 免鉴权调试端点未登记', hitR10],
    ['R10 已登记的不应误报', r10QuietForExempt],
    ['无违规时不误报 R4', noFalseR4],
  ].filter(([, ok]) => !ok);

  if (missed.length) {
    throw new Error(
      `自证失败：规则未按预期报出 ${missed.map(([n]) => n).join(' / ')} —— ` +
        `检查器失效时**必须自己失败**，而不是安静地全绿`,
    );
  }
}

function main(): void {
  const srcRoot = path.resolve(__dirname, '..', '..');
  selfTest();

  const { rows, files } = collectRoutes(srcRoot);
  const findings = [...rows.flatMap(auditRoute), ...auditOrder(rows)];

  const fail = findings.filter((f) => f.level === 'FAIL');
  const warn = findings.filter((f) => f.level === 'WARN');

  const adminRows = rows.filter(isAdmin);
  const supplierRows = rows.filter(isSupplier);
  const publicRows = rows.filter((r) => r.isPublic);
  const fundRows = rows.filter(isFund);
  const openRows = adminRows.filter((r) => !declared(r) && !DEFAULT_OPEN_EXEMPT[key(r)]);

  console.log(`源：${files} 个 *.controller.ts → ${rows.length} 个端点`);
  console.log(
    `  /admin/* ${adminRows.length} · /supplier/* ${supplierRows.length} · ` +
      `资金/写 ${fundRows.length} · 免鉴权 ${publicRows.length}`,
  );
  console.log(
    `  「默认全角色开放」的运营端点：${adminRows.filter((r) => !declared(r)).length} 个` +
      `（其中已在豁免清单 ${adminRows.filter((r) => !declared(r) && DEFAULT_OPEN_EXEMPT[key(r)]).length} 个）`,
  );
  console.log(
    `  免鉴权端点（应全为预期项）：${publicRows.map((r) => key(r)).join(' · ') || '（无）'}`,
  );

  // `--list`：打印完整端点清单（人工审计用；默认不打印以免噪音）
  if (process.argv.includes('--list')) {
    console.log('\n端点清单（方法 / 路径 / 生效白名单）：');
    for (const r of [...rows].sort((a, b) => a.full.localeCompare(b.full))) {
      const wl = declared(r) ? r.effective!.join(',') : '⚠ 未声明(默认全角色)';
      console.log(`  ${r.method.padEnd(6)} ${r.full.padEnd(46)} ${wl}`);
    }
  }

  for (const f of findings) {
    const tag = f.level === 'FAIL' ? '✘' : '△';
    console.log(`  ${tag} [${f.rule}] ${f.route}\n      ${f.detail}`);
  }

  if (openRows.length) {
    console.log(`\n✘ ${openRows.length} 个运营端点未声明有效白名单且不在豁免清单：`);
    for (const r of openRows) console.log(`    ${key(r)}  (${r.file})`);
  }

  if (fail.length || openRows.length) {
    console.log(
      `\n✘ 路由权限审计未通过：${fail.length + openRows.length} 项阻断` +
        `${warn.length ? ` · ${warn.length} 项待人工确认` : ''}`,
    );
    process.exit(1);
  }

  console.log(
    `\n✔ 路由权限审计通过：${rows.length} 个端点全部有明确白名单` +
      `${warn.length ? `（${warn.length} 项 WARN 待人工确认）` : ''}`,
  );
}

if (require.main === module) main();
