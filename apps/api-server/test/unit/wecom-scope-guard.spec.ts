import * as fs from 'fs';
import * as path from 'path';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';

/**
 * JWT 作用域判据（`scopeOf`）+ 企微模块的路径归位约束
 *
 * 背景（2026-11-01 线上实测踩过，两个缺陷叠在一起）：
 *   · `JwtAuthGuard` 的双主体隔离只按**路径前缀**判，`ADMIN_SCOPE` 只认
 *     `/admin`、`/supplier` 开头；
 *   · `main.ts` 关了默认 bodyParser，请求体由自定义中间件接管，而它只挂
 *     `/api/v1/*`。
 *   于是把「管理端点」写成 `/wecom/kb/...`（免全局前缀）会同时丢掉三样：
 *   后台主体判定、body 解析、统一限流 —— 表现为列表 500、写入 10001、
 *   带 token 还被判「请使用后台接口」。
 *
 * 结论写成本文件的两条硬约束：
 *   ① **回调**（@Public，企微侧配的地址）必须留在 `/wecom/kb` —— 不能带 `/api/v1`；
 *   ② **管理端点**必须在 `/admin/…` 下 —— 不要为了「凑一组」而挤进免前缀区。
 * 约束靠扫真实控制器断言，不靠人记。
 */

const guard = new JwtAuthGuard(new Reflector());
const scopeOf = (url: string): string =>
  (guard as unknown as { scopeOf(u: string): string }).scopeOf(url);

const WECOM_DIR = path.join(__dirname, '../../src/modules/wecom-kb');

interface Ctrl {
  file: string;
  root: string;
  isPublic: boolean;
}

/** 扫企微模块下所有控制器的根路径与是否 Public */
function wecomControllers(): Ctrl[] {
  const files = fs.readdirSync(WECOM_DIR).filter((f) => f.endsWith('.controller.ts'));
  const out: Ctrl[] = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(WECOM_DIR, f), 'utf8');
    const m = /@Controller\(['"]([^'"]+)['"]\)/.exec(src);
    if (!m) continue;
    out.push({
      file: f,
      root: '/' + m[1].replace(/^\//, ''),
      isPublic: /@Public\(\)/.test(src),
    });
  }
  return out;
}

describe('JWT 作用域 · 既有前缀不回归', () => {
  it('后台 / 供应商路径判 admin', () => {
    for (const u of [
      '/admin/orders',
      '/api/v1/admin/orders',
      '/supplier/dishes',
      '/api/v1/supplier/dishes',
    ]) {
      expect(scopeOf(u)).toBe('admin');
    }
  });

  it('用户端路径判 user', () => {
    for (const u of ['/api/v1/orders', '/orders', '/auth/login', '/api/v1/meal/today']) {
      expect(scopeOf(u)).toBe('user');
    }
  });

  it('查询串不影响判定', () => {
    expect(scopeOf('/api/v1/admin/orders?page=1&size=20')).toBe('admin');
    expect(scopeOf('/api/v1/admin/wecom-kb/ops?x=1')).toBe('admin');
  });
});

describe('JWT 作用域 · 企微管理端点（归位后）', () => {
  it('★ 绑定 / 目录 / 试跑台都判 admin（写成 /wecom/… 时会被判 user ⇒ 后台 token 一律被拒）', () => {
    for (const u of [
      '/api/v1/admin/wecom-kb/bindings',
      '/api/v1/admin/wecom-kb/bindings/alice',
      '/api/v1/admin/wecom-kb/bindings/alice/tier',
      '/api/v1/admin/wecom-kb/bindings/alice/grant',
      '/api/v1/admin/wecom-kb/ops',
      '/api/v1/admin/wecom-kb/simulate',
    ]) {
      expect(scopeOf(u)).toBe('admin');
    }
  });

  it('企微回调仍是用户侧（它 @Public，到不了这里，但判据要一致）', () => {
    expect(scopeOf('/wecom/kb/callback')).toBe('user');
  });
});

describe('企微模块 · 路径归位约束（扫真实控制器，防再写回去）', () => {
  const ctrls = wecomControllers();

  it('控制器集合非空（否则下面断言恒真）', () => {
    expect(ctrls.length).toBeGreaterThanOrEqual(3);
  });

  it('★ 非 Public 的企微控制器必须以 /admin 开头', () => {
    const bad = ctrls.filter((c) => !c.isPublic && !c.root.startsWith('/admin/'));
    expect(bad.map((b) => `${b.file} → ${b.root}`)).toEqual([]);
  });

  it('★ @Public 的回调控制器必须保持 /wecom 前缀（企微侧地址不能带 /api/v1）', () => {
    const pub = ctrls.filter((c) => c.isPublic);
    expect(pub.length).toBeGreaterThanOrEqual(1); // 回调控制器必须存在
    const bad = pub.filter((c) => !c.root.startsWith('/wecom/'));
    expect(bad.map((b) => `${b.file} → ${b.root}`)).toEqual([]);
  });

  it('★ 每个非 Public 控制器的根路径都必须判 admin（作用域与路径双证）', () => {
    const missed = ctrls.filter((c) => !c.isPublic && scopeOf(c.root) !== 'admin');
    expect(missed.map((m) => `${m.file} → ${m.root}`)).toEqual([]);
  });
});
