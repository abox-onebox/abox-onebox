/**
 * 本地内部测试 · 静态托管 + API 反向代理（零依赖 · 不引第三方包）
 *
 * 为什么需要它：手机做内部测试，最省事的形态是「**一条局域网地址**」——
 *   前端产物与后端接口**同源**，既不会踩 CORS，也不用在手机上配代理。
 *
 * 能力
 *   · 静态托管：HTML / JS / CSS / 图片 / 字体 / sourcemap
 *   · SPA 回退：命中不到文件且路径无扩展名 → 回 `index.html`
 *     （运营后台用 history 路由，直接在手机上手输 `/orders` 也能进）
 *   · 反向代理：`/api` 透传到本地 API（含请求体、响应流、changeOrigin）
 *   · 前缀冲突：`/static` **两边都要用** —— uni-app 的前端静态目录（字体等）
 *     和 API 本地上传目录（`/static/dishes/...`）同名。
 *     对策：`/static` 走「**文件优先、代理兜底**」—— dist 里存在的文件直接给，
 *     不存在的（上传图片）才透传到 API。
 *   · 穿越防护：解析后的绝对路径必须仍落在 root 内，否则 403
 *
 * ⚠️ **仅用于内网内部测试**，不要当生产服务器用：无 HTTPS、无缓存策略、无访问控制。
 */
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

/** 够用的最小类型表；未命中一律 `application/octet-stream`（浏览器会下载而不是误渲染） */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 起一个「静态站点 + API 代理」的本地服务
 *
 * @param root            静态资源根目录（绝对路径）
 * @param port            监听端口
 * @param host            监听地址，默认 `0.0.0.0`（**必须是这个，否则手机连不上**）
 * @param proxyTarget     API 地址，如 `http://127.0.0.1:3000`
 * @param proxyPrefixes   **无条件**走代理的路径前缀（API 接口）
 * @param fileFirstProxyPrefixes 「本地文件优先、未命中再代理」的路径前缀
 *                                （`/static`：前端静态资产与 API 上传目录同名，文件优先）
 * @param spa             未命中的无扩展名路径是否回退 index.html
 * @param label           日志前缀
 */
export function startStaticApp({
  root,
  port,
  host = '0.0.0.0',
  proxyTarget = null,
  proxyPrefixes = ['/api'],
  fileFirstProxyPrefixes = ['/static'],
  spa = true,
  label = 'app',
}) {
  const rootAbs = resolve(root);

  const matches = (list, pathname) => list.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  const server = createServer((req, res) => {
    const pathname = safePathname(req.url);
    if (proxyTarget && matches(proxyPrefixes, pathname)) {
      return proxy(req, res, proxyTarget, label);
    }
    if (proxyTarget && matches(fileFirstProxyPrefixes, pathname) && !resolveFile(rootAbs, pathname, false)) {
      // dist 里没有这个文件 → 是 API 的上传静态资源（如 /static/dishes/xx.jpg），透传
      return proxy(req, res, proxyTarget, label);
    }
    return serveFile(req, res, rootAbs, pathname, spa, label);
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () =>
      ok({
        port,
        root: rootAbs,
        url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      }),
    );
  });
}

/** 取 URL 的 pathname；`decodeURIComponent` 失败（畸形百分号编码）时退回原文，不让整个请求 500 */
function safePathname(url) {
  const raw = (url ?? '/').split('?')[0].split('#')[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function serveFile(req, res, rootAbs, pathname, spa, label) {
  const file = resolveFile(rootAbs, pathname, spa);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 —— 本地内部测试服务：资源不存在');
  }

  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    // HTML 不缓存：否则手机上「改了代码刷新还是旧的」，会误判成没生效
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file)
    .on('error', () => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 —— 读取文件失败');
    })
    .pipe(res);
  void label;
}

/** 解析出真实文件路径；越权、目录、未命中分别返回 null 或 index.html */
function resolveFile(rootAbs, pathname, spa) {
  const direct = resolve(rootAbs, `.${pathname}`);
  if (!inside(rootAbs, direct)) return null; // 目录穿越 → 当作不存在

  if (existsSync(direct)) {
    if (statSync(direct).isDirectory()) {
      const idx = join(direct, 'index.html');
      return existsSync(idx) ? idx : null;
    }
    return direct;
  }

  // SPA 回退：`/orders` 这类无扩展名路径交给前端路由
  if (spa && !extname(pathname)) {
    const idx = join(rootAbs, 'index.html');
    return existsSync(idx) ? idx : null;
  }
  return null;
}

function inside(rootAbs, target) {
  return target === rootAbs || target.startsWith(rootAbs + sep);
}

/** 透传到本地 API；把 `host` 改写成目标主机（等价于 vite 的 changeOrigin） */
function proxy(req, res, target, label) {
  let url;
  try {
    url = new URL(target);
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ code: 500, message: '代理目标地址不合法' }));
  }

  const upstream = httpRequest(
    {
      hostname: url.hostname,
      port: url.port || 80,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: url.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', () => {
    // API 没起来时给出可操作信息，而不是让端上看到一个无解释的空响应
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        code: 502,
        message: `[${label}] 本地 API 未响应 —— 请确认后端服务已在 ${target} 启动`,
      }),
    );
  });

  req.pipe(upstream);
}
