import express from 'express';
import request from 'supertest';

import { createRequestBodyMiddleware } from '../../src/common/middleware/request-body.middleware';
import {
  WECOM_CALLBACK_PATH,
  createWecomRawBodyMiddleware,
} from '../../src/common/middleware/wecom-raw-body.middleware';
import { wecomXmlTag } from '../../src/modules/wecom-kb/wecom-kb.service';

/**
 * 企业微信回调「原始 XML 报文」捕获（2026-11-10 生产实测收口）
 *
 * ## 事故形态（极易误判为「回调没通」）
 * 企微后台填 URL 时的 **GET 握手能过**，但同事发消息的 **POST 永远无响应**：
 * `handlePost()` 一律打日志「企业微信回调缺少 Encrypt 节点」。
 * 根因是 `req.rawBody` 恒为 undefined，两条链路同时断：
 *   ① 裸路径 `/wecom/kb/callback` 被 setGlobalPrefix exclude，
 *      `forRoutes('*')` 展开后的 `/api/v1/*` 覆盖不到它；
 *   ② `request-body.middleware` 只解析 json / urlencoded，XML 被 skip。
 *
 * ## 本文件钉死的事
 *   【必报】POST + XML（三种 Content-Type）→ rawBody 原文逐字节可还原，
 *           且能从里面取出 `<Encrypt>` 节点（这正是控制器的判据）。
 *   【必不报】GET 握手 / 其他路径 / 尾部子路径 → 中间件必须完全不介入，
 *           不能挂起、不能读流、不能改写既有行为（尤其 2026-10-27 事故面）。
 *   【共存】与全局请求体中间件叠加时，XML 那条不能被它吃掉。
 */
type ReqWithRaw = express.Request & { rawBody?: Buffer };

/** 企微官方《加解密方案说明》的真实形态：所有字段都是 CDATA */
const XML = [
  '<xml>',
  '  <ToUserName><![CDATA[wx5823bf96d3bd56c7]]></ToUserName>',
  '  <Encrypt><![CDATA[QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=]]></Encrypt>',
  '  <AgentID><![CDATA]></AgentID>',
  '</xml>',
].join('\n');
const ENCRYPT = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';

/** 复刻线上形态：企微把签名参数放 query，密文放 body */
const QUERY = '?msg_signature=abc&timestamp=1794300000&nonce=n1';

function app(withGlobalBodyMiddleware = false): express.Express {
  const a = express();
  // ⚠️ 顺序必须与 main.ts 一致：raw 捕获在 configure() 的全局中间件之前
  a.use(createWecomRawBodyMiddleware());
  if (withGlobalBodyMiddleware) a.use(createRequestBodyMiddleware());

  a.all(WECOM_CALLBACK_PATH, (req: ReqWithRaw, res) => {
    const raw = req.rawBody?.toString('utf8') ?? null;
    // ⭐ 探针复用**产物里的真实实现**，不另写一份正则（否则又是假绿/假红）
    const encrypt = raw ? wecomXmlTag(raw, 'Encrypt') : null;
    res.json({ method: req.method, raw, encrypt: encrypt || null });
  });
  a.all('/api/v1/orders', (req: ReqWithRaw, res) => {
    res.json({ raw: req.rawBody?.toString('utf8') ?? null, body: req.body ?? null });
  });
  return a;
}

describe('wecomXmlTag：CDATA 剥离（企微 XML 的真实形态）', () => {
  it('【必报】CDATA 里的 Encrypt 必须剥成纯 Base64（否则签名恒不符）', () => {
    expect(wecomXmlTag(XML, 'Encrypt')).toBe(ENCRYPT);
    expect(wecomXmlTag('<xml><Content><![CDATA[生成开团草稿]]></Content></xml>', 'Content')).toBe(
      '生成开团草稿',
    );
    expect(
      wecomXmlTag('<xml><FromUserName><![CDATA[zhangsan]]></FromUserName></xml>', 'FromUserName'),
    ).toBe('zhangsan');
  });

  it('【必不报】不带 CDATA 的字段原样返回，标签缺失返回空串', () => {
    expect(wecomXmlTag('<xml><MsgId>1234567890</MsgId></xml>', 'MsgId')).toBe('1234567890');
    expect(wecomXmlTag(XML, 'NotExist')).toBe('');
    expect(wecomXmlTag('', 'Encrypt')).toBe('');
    // 标准空 CDATA 不能把外壳当成值返回
    expect(wecomXmlTag('<xml><AgentID><![CDATA[]]></AgentID></xml>', 'AgentID')).toBe('');
  });

  it('CDATA 内的换行/空格不污染 Base64，且首尾空白被 trim', () => {
    const wrapped = '<Encrypt>\n  <![CDATA[  ' + ENCRYPT + '  ]]>\n</Encrypt>';
    expect(wecomXmlTag(wrapped, 'Encrypt')).toBe(ENCRYPT);
  });
});

describe('企业微信回调原始报文捕获', () => {
  describe('【必报】POST + XML → rawBody 原文可还原', () => {
    it.each(['text/xml', 'application/xml', 'text/plain'])(
      'Content-Type: %s 均能取到 Encrypt 节点',
      async (contentType) => {
        const res = await request(app())
          .post(WECOM_CALLBACK_PATH + QUERY)
          .set('Content-Type', contentType)
          .send(XML);
        expect(res.status).toBe(200);
        expect(res.body.raw).toBe(XML);
        expect(res.body.encrypt).toBe(ENCRYPT);
      },
    );

    it('无 Content-Type 也能读到（type: () => true 的兜底）', async () => {
      const res = await request(app()).post(WECOM_CALLBACK_PATH).set('Content-Type', '').send(XML);
      // supertest 可能补默认类型；无论哪种都要求原文可还原
      expect(res.body.raw).toBe(XML);
      expect(res.body.encrypt).toBe(ENCRYPT);
    });

    it('带 query 签名参数时仍能精确命中路径', async () => {
      const res = await request(app())
        .post(WECOM_CALLBACK_PATH + QUERY)
        .set('Content-Type', 'text/xml')
        .send(XML);
      expect(res.body.method).toBe('POST');
      expect(res.body.encrypt).toBe(ENCRYPT);
    });

    it('【共存】叠加全局请求体中间件后，XML 不被吃掉', async () => {
      const res = await request(app(true))
        .post(WECOM_CALLBACK_PATH + QUERY)
        .set('Content-Type', 'text/xml')
        .send(XML);
      expect(res.status).toBe(200);
      expect(res.body.raw).toBe(XML);
      expect(res.body.encrypt).toBe(ENCRYPT);
    });
  });

  describe('【必不报】非目标请求必须完全不介入', () => {
    it('GET 握手（URL 校验）直接通过，不挂 rawBody、不挂起', async () => {
      const res = await request(app())
        .get(WECOM_CALLBACK_PATH + '?msg_signature=abc&timestamp=1&nonce=n&echostr=xxx')
        .timeout({ deadline: 2000 });
      expect(res.status).toBe(200);
      expect(res.body.raw).toBeNull();
    });

    it('HEAD / OPTIONS 同样直接通过', async () => {
      const head = await request(app()).head(WECOM_CALLBACK_PATH).timeout({ deadline: 2000 });
      expect(head.status).toBe(200);
      const opt = await request(app()).options(WECOM_CALLBACK_PATH).timeout({ deadline: 2000 });
      expect(opt.status).toBe(200);
    });

    it('其他路径的 POST 不受影响（不读流、不挂 rawBody）', async () => {
      const res = await request(app())
        .post('/api/v1/orders')
        .set('Content-Type', 'text/xml')
        .send(XML);
      expect(res.status).toBe(200);
      expect(res.body.raw).toBeNull();
    });

    it('尾部子路径不算命中（精确判路径，不误吃 /wecom/kb/callback/xxx）', async () => {
      const res = await request(app())
        .post(WECOM_CALLBACK_PATH + '/extra')
        .set('Content-Type', 'text/xml')
        .send(XML);
      // 无匹配路由 → 404，且不会因为 raw parser 变成 200
      expect(res.status).toBe(404);
    });

    it('全局请求体中间件的已收口行为不被破坏：POST 合法 JSON 仍带 rawBody', async () => {
      const res = await request(app(true)).post('/api/v1/orders').send({ username: 'tom' });
      expect(res.status).toBe(200);
      expect(res.body.body).toMatchObject({ username: 'tom' });
      expect(res.body.raw).toBe(JSON.stringify({ username: 'tom' }));
    });
  });

  it('超限体被 body-parser 以 413 拒绝，不无限读流', async () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 'a');
    const res = await request(app())
      .post(WECOM_CALLBACK_PATH)
      .set('Content-Type', 'text/xml')
      .send(big);
    expect(res.status).toBe(413);
  });
});
