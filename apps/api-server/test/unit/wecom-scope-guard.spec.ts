import * as fs from 'fs';
import * as path from 'path';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';

/**
 * JWT 作用域判据（`scopeOf`）
 *
 * 背景：这套「双主体隔离」只按**路径前缀**判定，漏一个前缀 = 那个端点线上不可用，
 * 而且症状极具迷惑性：
 *   · 无 token 打 → 401/10002，看起来「路由存在、只是要登录」，一切正常；
 *   · **带真 token 打** → 才暴露 `后台账号请使用后台接口`。
 * 2026-11-01 实测踩过：`/wecom/kb/bindings/*` 因不带 `/api/v1`、也不以 `/admin`
 * 开头，被判成「用户端」，整个企微绑定页线上不可用（门禁全绿，但功能是死的）。
 *
 * 所以这里不满足于「几个样例对不对」，而是**扫描真实控制器**逐个断言 ——
 * 以后新增 `/wecom/kb/*` 管理端点却忘了登记，这条会直接报红。
 */

const guard = new JwtAuthGuard(new Reflector());
const scopeOf = (url: string): string =>
  (guard as unknown as { scopeOf(u: string): string }).scopeOf(url);

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
    expect(scopeOf('/wecom/kb/ops?x=1')).toBe('admin');
  });
});

describe('JWT 作用域 · wecom 管理端点（本次修复点）', () => {
  it('★ 企微绑定 / 功能目录判 admin（此前被判 user ⇒ 后台 token 一律被拒）', () => {
    for (const u of [
      '/wecom/kb/bindings',
      '/wecom/kb/bindings/alice',
      '/wecom/kb/bindings/alice/tier',
      '/wecom/kb/bindings/alice/grant',
      '/wecom/kb/ops',
      '/wecom/kb/ops?x=1',
    ]) {
      expect(scopeOf(u)).toBe('admin');
    }
  });

  it('试跑台（走 /api/v1 前缀）判 admin', () => {
    expect(scopeOf('/api/v1/admin/wecom/kb/simulate')).toBe('admin');
  });

  it('企微回调不算管理路径（它本身 @Public，到不了这里，但判据要一致）', () => {
    expect(scopeOf('/wecom/kb/callback')).toBe('user');
  });

  it('名字相近的路径不误判（防正则过宽导致用户端端点被当成后台）', () => {
    for (const u of ['/wecom/kbX', '/wecom/kb/opsX', '/wecom/other', '/wecom/kb']) {
      expect(scopeOf(u)).toBe('user');
    }
  });
});

describe('JWT 作用域 · 扫真实控制器（防「新增端点忘登记」）', () => {
  it('★ 所有非 Public 的 wecom 控制器，其根路径都必须判 admin', () => {
    const dir = path.join(__dirname, '../../src/modules/wecom-kb');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.controller.ts'));
    expect(files.length).toBeGreaterThan(0); // 集合为空会让下面的断言自动通过，先自证

    const checked: string[] = [];
    const missed: string[] = [];

    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = /@Controller\(['"]([^'"]+)['"]\)/.exec(src);
      if (!m) continue;
      const root = '/' + m[1].replace(/^\//, '');
      if (!root.startsWith('/wecom')) continue; // 走 /admin 前缀的由 ADMIN_SCOPE 覆盖
      if (/@Public\(\)/.test(src)) continue; // 企微回调：不带令牌，属用户侧
      checked.push(root);
      if (scopeOf(root) !== 'admin') missed.push(`${f} → ${root}`);
    }

    // 至少要扫到绑定/目录两个，否则说明正则没命中（判据失效而不是通过）
    expect(checked.length).toBeGreaterThanOrEqual(2);
    expect(missed).toEqual([]);
  });
});
