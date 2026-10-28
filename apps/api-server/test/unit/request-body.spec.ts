import { Logger } from '@nestjs/common';
import express from 'express';
import request from 'supertest';

import { createRequestBodyMiddleware } from '../../src/common/middleware/request-body.middleware';
import {
  MALFORMED_BODY_MESSAGE,
  carriesBody,
  hasRequestBodySemantics,
  judgeBodyFailure,
} from '../../src/common/http/request-body.policy';

/**
 * 请求体闸门（2026-10-27 生产事故收口）
 *
 * ## 事故原文
 * `GET /api/v1/orders/:orderNo` 返回
 *   {"code":10001,"message":"Unexpected token '\"', \"\"eyJhbGciO\"... is not valid JSON"}
 *
 * 那条 message 是 `body-parser` 在 `strict:true` 下用 `createStrictSyntaxError()`
 * 二次解析编出来的；再由 `@nestjs/core` 的 `mapExternalException` 把 SyntaxError
 * 一律映射成 `BadRequestException(err.message)` → AllExceptionsFilter → 10001。
 *
 * ## 本文件要钉死的三件事
 *   1. **必报**：`JSON.stringify(<jwt>)` 这种顶层 JSON 字符串当请求体 →
 *      现在的结算是「GET 忽略体 / POST 报受控中文文案」，**绝不再**出现引擎英文原文。
 *   2. **必不报**：正常请求（有无 JSON 体都算）必须原样通过，不能被这次改动打坏。
 *   3. `req.rawBody` **不能丢** —— `/pay/notify` 的微信支付 V3 验签要靠它。
 */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEwNjB9.sig';
/** 事故里那条体的原样重建：`JSON.stringify(<jwt>)` */
const QUOTED_JWT_BODY = JSON.stringify(JWT);

function app(): express.Express {
  const a = express();
  a.use(createRequestBodyMiddleware());
  a.all('/probe', (req, res) => {
    res.json({
      method: req.method,
      body: req.body ?? null,
      raw: (req as never as { rawBody?: Buffer }).rawBody?.toString('utf8') ?? null,
    });
  });
  // 复刻 Nest 的收尾链路：SyntaxError → 400 + 把 message 原样透出
  // （对应 mapExternalException + AllExceptionsFilter 的 10001 分支）
  a.use(((err: Error, _req: express.Request, res: express.Response, _next: unknown) => {
    res.status(400).json({ code: 10001, message: err.message });
  }) as express.ErrorRequestHandler);
  return a;
}

describe('请求体策略（纯函数判据）', () => {
  it('只有 POST/PUT/PATCH/DELETE 有请求体语义', () => {
    expect(hasRequestBodySemantics('POST')).toBe(true);
    expect(hasRequestBodySemantics('PUT')).toBe(true);
    expect(hasRequestBodySemantics('PATCH')).toBe(true);
    expect(hasRequestBodySemantics('DELETE')).toBe(true);
    expect(hasRequestBodySemantics('GET')).toBe(false);
    expect(hasRequestBodySemantics('HEAD')).toBe(false);
    expect(hasRequestBodySemantics('OPTIONS')).toBe(false);
    // 方法缺失不许猜：宁可不解析，不可误解析失败
    expect(hasRequestBodySemantics(undefined)).toBe(false);
  });

  /**
   * 「确实带了体」的判据 —— ⚠️ 两端都要钉：
   *   恒 true ⇒ 每个 GET 都告警（日志刷爆 = 没有告警）；恒 false ⇒ 丢弃变成静默，
   *   正是 2026-10-27「日志 0 条」的成因。
   */
  it('carriesBody：有体才 true，无体/chunked 分得清', () => {
    expect(carriesBody('0')).toBe(false);
    expect(carriesBody(undefined)).toBe(false);
    expect(carriesBody('0', 'chunked')).toBe(true); // chunked 没有 Content-Length
    expect(carriesBody('243')).toBe(true);
    expect(carriesBody(' 12 ')).toBe(true);
    expect(carriesBody('abc')).toBe(false); // 畸形头不许误判成有体
  });

  it('GET 的体失败 → ignore；POST 的体失败 → reject（受控文案）', () => {
    const e = new SyntaxError('Unexpected token \'"\', ""eyJhbGciO"... is not valid JSON');
    expect(judgeBodyFailure('GET', e).kind).toBe('ignore');
    const rejected = judgeBodyFailure('POST', e);
    expect(rejected.kind).toBe('reject');
    expect(rejected).toMatchObject({ message: MALFORMED_BODY_MESSAGE });
  });
});

describe('请求体中间件（HTTP 层实跑）', () => {
  it('【必不报】POST + 合法 JSON 对象 → 正常透传，且 rawBody 保留', async () => {
    const res = await request(app())
      .post('/probe')
      .set('Content-Type', 'application/json')
      .send('{"username":"abox"}');
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ username: 'abox' });
    // ⭐ /pay/notify 的验签依赖这一条，丢失即 prod 支付回调全线失败
    expect(res.body.raw).toBe('{"username":"abox"}');
  });

  it('【必不报】GET 不带体 → 正常，body 兜成 {}', async () => {
    const res = await request(app()).get('/probe');
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({});
  });

  it('【必报】GET 带顶层 JSON 字符串体（事故形态）→ 丢弃该体，走正常处理', async () => {
    const res = await request(app())
      .get('/probe')
      .set('Content-Type', 'application/json')
      // ⚠️ supertest 的 .send(string) 会按 Content-Type 原样送出，这里是 `"eyJhbGciO..."`
      .send(QUOTED_JWT_BODY);
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('GET');
    expect(res.body.body).toEqual({});
    // 反证：不再是那条伪装成 10001 的引擎原文
    expect(res.text).not.toContain('Unexpected token');
  });

  it('【必报】POST 带顶层 JSON 字符串体 → 10001，但文案受控、不泄漏引擎原文', async () => {
    const res = await request(app())
      .post('/probe')
      .set('Content-Type', 'application/json')
      .send(QUOTED_JWT_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(10001);
    expect(res.body.message).toBe(MALFORMED_BODY_MESSAGE);
    expect(JSON.stringify(res.body)).not.toContain('Unexpected token');
  });

  it('【必报】POST 带根本不是 JSON 的体 → 同样受控', async () => {
    const res = await request(app())
      .post('/probe')
      .set('Content-Type', 'application/json')
      .send('<html>not json</html>');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(MALFORMED_BODY_MESSAGE);
  });

  it('【必不报】POST 空体 → 不当非法体处理（body-parser 对空体有特判）', async () => {
    const res = await request(app()).post('/probe').set('Content-Type', 'application/json').send();
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({});
  });

  it('【必不报】表单编码体仍可用（urlencoded 分支未被改坏）', async () => {
    const res = await request(app()).post('/probe').type('form').send('username=abox');
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ username: 'abox' });
  });
});

/**
 * ⭐ 全形态覆盖（2026-10-27 严过关独立复验提出）
 *
 * 事故最初被定性成「GET 订单详情专属」，但实测是**任意方法、任意端点、且在鉴权之前**：
 *   V7 POST /auth/login  + 坏体 → 10001
 *   V8 GET  /health      + 坏体 → 10001
 *   V9 同 V8 但不带 Authorization → 10001（证明发生在鉴权之前）
 * ⇒ 闸门做在「方法有没有请求体语义」这一层，而不是「某个路由」这一层，才覆盖得住。
 *
 * 下面这组用一个**带鉴权中间件**的小型 app 复刻真实链路顺序
 *（请求体中间件 → 鉴权 → 路由），逐条钉死。
 */
describe('请求体中间件 · 全形态（V7/V8/V9）', () => {
  /** 复刻真实链路顺序：请求体闸门 → 鉴权 → 业务路由 → 兜底错误映射 */
  function apiApp(): express.Express {
    const a = express();
    a.use(createRequestBodyMiddleware());
    // 鉴权：/health 免鉴权，其余要 Authorization（缺则 10002）
    a.use((req, res, next) => {
      if (req.path === '/health') return next();
      if (!req.header('authorization')) {
        return res.status(401).json({ code: 10002, message: '未登录' });
      }
      return next();
    });
    a.get('/health', (_req, res) => res.json({ code: 0, data: { status: 'ready' } }));
    a.post('/auth/login', (req, res) => res.json({ code: 0, data: { echo: req.body } }));
    a.get('/orders', (req, res) => res.json({ code: 0, data: { list: [], echo: req.body } }));
    a.use(((err: Error, _req: express.Request, res: express.Response, _next: unknown) => {
      res.status(400).json({ code: 10001, message: err.message });
    }) as express.ErrorRequestHandler);
    return a;
  }

  /** V8：GET /health 带坏体 → **放行到业务层**（code=0），不许被吞成 10001 */
  it('V8 GET /health + 顶层字符串体 → code=0，体被丢弃', async () => {
    const res = await request(apiApp())
      .get('/health')
      .set('Content-Type', 'application/json')
      .send(QUOTED_JWT_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: 0, data: { status: 'ready' } });
    expect(res.text).not.toContain('Unexpected token');
  });

  /** V9：不带 Authorization 时，体闸门的裁决**不许**被鉴权顺序改变 */
  it('V9 GET /health + 坏体 + 不带 Authorization → 依旧 code=0（与带 token 同裁决）', async () => {
    const res = await request(apiApp())
      .get('/health')
      .set('Content-Type', 'application/json')
      .send(QUOTED_JWT_BODY);
    expect(res.body.code).toBe(0);
  });

  it('V9 反证：需要鉴权的 GET 缺 token → 报的是鉴权自己的 10002，不是 10001', async () => {
    const res = await request(apiApp())
      .get('/orders')
      .set('Content-Type', 'application/json')
      .send(QUOTED_JWT_BODY);
    expect(res.body.code).toBe(10002);
    expect(res.body.code).not.toBe(10001);
  });

  /** V7：POST 有体语义 → 仍然拒绝，但**文案受控**且**必须落 WARN 日志** */
  it('V7 POST /auth/login + 顶层字符串体 → 10001 受控中文，且必落 WARN 日志', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const res = await request(apiApp())
        .post('/auth/login')
        .set('Authorization', 'Bearer t')
        .set('Content-Type', 'application/json')
        .send(QUOTED_JWT_BODY);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(10001);
      expect(res.body.message).toBe(MALFORMED_BODY_MESSAGE);

      // ⭐ 本次事故最大的教训：这条路径**过去一条日志都没有**。
      //   故这里断言的不是「有没有报错」，而是「报错留没留痕」。
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('/auth/login');
      // 引擎原文进日志（对外不给），否则定位不到是谁发的、发的什么
      expect(logged).toContain('Unexpected token');
      // 对外文案里绝不能出现引擎原文
      expect(JSON.stringify(res.body)).not.toContain('Unexpected token');
    } finally {
      warn.mockRestore();
    }
  });

  it('V7 反证：GET 的坏体也要留痕（丢弃 ≠ 静默）', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await request(apiApp())
        .get('/health')
        .set('Content-Type', 'application/json')
        .send(QUOTED_JWT_BODY);
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('丢弃');
      expect(logged).toContain('/health');
      expect(logged).toContain(String(QUOTED_JWT_BODY.length)); // Content-Length 落日志，便于比对 nginx reqLen
    } finally {
      warn.mockRestore();
    }
  });

  /** 另一半：正常 GET（无体）**不许**告警 —— 否则日志刷爆，等于没有告警 */
  it('【必不报】GET 不带体 → 不落任何 WARN（正常流量不刷屏）', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const res = await request(apiApp()).get('/health');
      expect(res.body.code).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
