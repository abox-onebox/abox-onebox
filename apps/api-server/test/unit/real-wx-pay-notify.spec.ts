import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyPairSyncResult,
} from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';

import { ErrorCode } from '../../src/common/constants/error-code';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { RealWxPayProvider } from '../../src/providers/wx-pay/real-wx-pay.provider';

/**
 * 微信支付 real 通道 · 回调验签与解析（**全离线、无桩**）
 *
 * ## 为什么这么写
 *
 * 验签是「免鉴权改单入口」的唯一防线（`POST /pay/notify` 带 `@Public()`），
 * 它**不能靠「我认为是对的」交付**。本用例现场生成 RSA 密钥对，
 * 用真实的 `RSA-SHA256` + `AES-256-GCM` 造出一份**与线上同构**的回调报文：
 *
 *   · 签名确实由「微信侧私钥」产生 ⇒ 验签通过是**真的通过**；
 *   · 换一把私钥、或签名后改一个字节，就验签失败 ⇒ 验签**真的在判**，不是恒真。
 *
 * ⚠️ 不往仓库提交任何密钥文件（项目的 `security-scan` 会扫 git 历史里的凭据），
 *    密钥一律运行时生成、落在系统临时目录。
 */

/** APIv3 密钥（微信要求 32 字节） */
const API_V3_KEY = 'ABoxOneBoxTestApiV3Key_32bytesOK';
const PLATFORM_SERIAL = '5157F7A5TESTSERIAL0000000001';

const RESOURCE_AAD = 'transaction';

type RsaKeys = { publicKey: string; privateKey: string };

/** 只生成一次密钥对，多用例共享，保证「同一把微信私钥」 */
let wxKeys: RsaKeys;
let otherKeys: RsaKeys;

beforeAll(() => {
  wxKeys = newKeys();
  otherKeys = newKeys();
});

function newKeys(): RsaKeys {
  const k = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }) as KeyPairSyncResult<string, string>;
  return { publicKey: k.publicKey, privateKey: k.privateKey };
}

/** 造一份 ConfigService 替身（provider 只用到 `get`） */
function fakeConfig(overrides: Record<string, string | boolean> = {}): ConfigService {
  const map: Record<string, string | boolean> = {
    'wechat.mini.appId': 'wxappid_for_test',
    'wechat.pay.mchId': '1900000109',
    'wechat.pay.apiV3Key': API_V3_KEY,
    'wechat.pay.serialNo': 'MERCHANTSERIAL0000000000001',
    'wechat.pay.notifyUrl': 'https://api.abox.example.com/api/v1/pay/notify',
    'wechat.pay.refundNotifyUrl': '',
    'wechat.pay.platformCertPath': '',
    'wechat.pay.autoFetchCert': false,
    'wechat.pay.privateKeyPath': '',
    ...overrides,
  };
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

/** 写一份临时商户私钥（运行时生成，绝不进仓库） */
function writeTempPrivateKey(pem: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'abox-wxpay-'));
  const p = join(dir, 'apiclient_key.pem');
  writeFileSync(p, pem, 'utf8');
  return p;
}

/** 微信回调 resource 的加密方式：AEAD_AES_256_GCM，密文末尾 16 字节是 authTag */
function encryptResource(plain: unknown): { ciphertext: string; nonce: string } {
  const nonce = randomBytes(12).toString('hex').slice(0, 12);
  const cipher = createCipheriv('aes-256-gcm', API_V3_KEY, nonce);
  cipher.setAAD(Buffer.from(RESOURCE_AAD));
  const body = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
    nonce,
  };
}

interface NotifyFixture {
  headers: Record<string, string>;
  rawBody: string;
}

/** 造一份回调报文（默认签名正确） */
function buildNotify(
  opts: {
    tradeState?: string;
    timestampSec?: number;
    /** 用什么私钥签名（默认 = 微信侧那把；传另一把即「伪造」） */
    signKey?: string;
    /** 签名之后再篡改报文（模拟中间人改金额） */
    tamper?: (raw: string) => string;
    omitHeaders?: string[];
    /** 覆盖 resource（传 `{ nonce: 'x' }` 即「缺 ciphertext」） */
    resource?: Record<string, string>;
  } = {},
): NotifyFixture {
  const resource =
    opts.resource ??
    encryptResource({
      out_trade_no: 'AB20261010TEST0001',
      transaction_id: '4200000000000000000000000001',
      trade_state: opts.tradeState ?? 'SUCCESS',
      trade_state_desc: '支付成功',
      amount: { total: 2580, payer_total: 2580, currency: 'CNY' },
    });

  let rawBody = JSON.stringify({
    id: 'EV-20261010-0001',
    create_time: '2026-10-10T13:00:00+08:00',
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: { algorithm: 'AEAD_AES_256_GCM', associated_data: RESOURCE_AAD, ...resource },
  });

  const timestamp = String(opts.timestampSec ?? Math.floor(Date.now() / 1000));
  const nonce = 'testnonce0001';
  const signature = createSign('RSA-SHA256')
    .update(`${timestamp}\n${nonce}\n${rawBody}\n`)
    .sign(opts.signKey ?? wxKeys.privateKey, 'base64');

  if (opts.tamper) rawBody = opts.tamper(rawBody);

  const headers: Record<string, string> = {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-signature': signature,
    'wechatpay-serial': PLATFORM_SERIAL,
  };
  for (const k of opts.omitHeaders ?? []) delete headers[k];

  return { headers, rawBody };
}

/** 测试用子类：注入平台证书（生产代码里 `certs` 由文件加载 / 自动拉取填充） */
class TestableRealWxPayProvider extends RealWxPayProvider {
  putPlatformCert(serial: string, pem: string): void {
    this.certs.set(serial, pem);
  }
}

function makeProvider(overrides: Record<string, string | boolean> = {}): TestableRealWxPayProvider {
  const p = new TestableRealWxPayProvider(
    fakeConfig({
      'wechat.pay.privateKeyPath': writeTempPrivateKey(wxKeys.privateKey),
      ...overrides,
    }),
  );
  p.putPlatformCert(PLATFORM_SERIAL, wxKeys.publicKey);
  return p;
}

describe('RealWxPayProvider · 回调验签与解析（离线真密钥）', () => {
  it('① 签名正确的 SUCCESS 回调 → 解析出订单号 / 流水号 / 金额 / success=true', async () => {
    const p = makeProvider();
    const { headers, rawBody } = buildNotify();

    const r = await p.parseNotify(headers, rawBody);

    expect(r.orderNo).toBe('AB20261010TEST0001');
    expect(r.transactionId).toBe('4200000000000000000000000001');
    expect(r.amountFen).toBe(2580);
    expect(r.success).toBe(true);
  });

  it('② 变异：换一把私钥签名 → 验签失败（证明验签真的在判，不是恒真）', async () => {
    const p = makeProvider();
    const { headers, rawBody } = buildNotify({ signKey: otherKeys.privateKey });

    await expect(p.parseNotify(headers, rawBody)).rejects.toThrow(/验签失败/);
  });

  /**
   * ③ 变异：签名后篡改报文 → 验签失败
   *
   * ⚠️ 改的不是金额 —— 金额在 `resource.ciphertext` **密文**里，明文改不到它。
   *    这里改 `id`（明文层的任一处），足以证明「签名覆盖整个 rawBody」：
   *    只改一个字符，验签就必须失败。
   */
  it('③ 变异：签名后篡改报文任一处 → 验签失败', async () => {
    const p = makeProvider();
    const { headers, rawBody } = buildNotify({
      tamper: (raw) => raw.replace('EV-20261010-0001', 'EV-20261010-9999'),
    });
    expect(rawBody).toContain('EV-20261010-9999');

    await expect(p.parseNotify(headers, rawBody)).rejects.toThrow(/验签失败/);
  });

  it('④ 缺少任一验签头 → 抛错（不退化成「当成没签名直接放行」）', async () => {
    const p = makeProvider();
    for (const h of [
      'wechatpay-timestamp',
      'wechatpay-nonce',
      'wechatpay-signature',
      'wechatpay-serial',
    ]) {
      const { headers, rawBody } = buildNotify({ omitHeaders: [h] });
      await expect(p.parseNotify(headers, rawBody)).rejects.toThrow(/缺少验签头/);
    }
  });

  it('⑤ 反重放：时间戳超出 5 分钟容差 → 抛错（即便签名正确）', async () => {
    const p = makeProvider();
    const { headers, rawBody } = buildNotify({ timestampSec: Math.floor(Date.now() / 1000) - 301 });

    await expect(p.parseNotify(headers, rawBody)).rejects.toThrow(/超出容差/);
  });

  it('⑥ fail-closed：拿不到平台证书 → 抛错，绝不跳过验签', async () => {
    // 不注入证书、且关掉自动拉取：这就是「证书没配好」的真实形态
    const p = new TestableRealWxPayProvider(
      fakeConfig({ 'wechat.pay.privateKeyPath': writeTempPrivateKey(wxKeys.privateKey) }),
    );
    const { headers, rawBody } = buildNotify();

    await expect(p.parseNotify(headers, rawBody)).rejects.toThrow(/未找到微信平台证书/);
  });

  it('⑦ trade_state 非 SUCCESS（CLOSED）→ success=false，但仍算解析成功', async () => {
    const p = makeProvider();
    const { headers, rawBody } = buildNotify({ tradeState: 'CLOSED' });

    const r = await p.parseNotify(headers, rawBody);
    expect(r.success).toBe(false);
    expect(r.orderNo).toBe('AB20261010TEST0001');
  });

  it('⑧ resource 缺 ciphertext → 抛错（不静默返回空单号）', async () => {
    const p = makeProvider();
    const { headers, rawBody } = buildNotify({ resource: { nonce: 'onlynonce123' } });

    await expect(p.parseNotify(headers, rawBody)).rejects.toThrow(/缺少 resource/);
  });
});

describe('RealWxPayProvider · 配置不全时 fail-closed（不静默成功）', () => {
  it('缺必配项 → createPrepay 抛 40001，且错误信息点名缺哪些键', async () => {
    const p = new TestableRealWxPayProvider(
      fakeConfig({
        'wechat.pay.mchId': '',
        'wechat.pay.apiV3Key': '',
        'wechat.pay.privateKeyPath': '',
      }),
    );
    const input = {
      orderNo: 'AB1',
      amountFen: 2580,
      description: 'ABox一盒 团餐',
      openid: 'oTest',
    };

    await expect(p.createPrepay(input)).rejects.toMatchObject({
      code: ErrorCode.PAY_CREATE_FAILED,
    });

    try {
      await p.createPrepay(input);
      throw new Error('本行不该到达：缺必配项时必须抛错');
    } catch (e) {
      const err = e as BizException;
      expect(err.code).toBe(ErrorCode.PAY_CREATE_FAILED);
      expect(err.message).toContain('WXPAY_MCH_ID');
      expect(err.message).toContain('WXPAY_API_V3_KEY');
      expect(err.message).toContain('WXPAY_PRIVATE_KEY_PATH');
    }
  });

  it('缺必配项 → refund 抛普通 Error（交由队列按 refundNo 幂等重试，不是 BizException）', async () => {
    const p = new TestableRealWxPayProvider(fakeConfig({ 'wechat.pay.mchId': '' }));
    const input = { orderNo: 'AB1', refundNo: 'RF1', refundFen: 100, totalFen: 2580 };

    await expect(p.refund(input)).rejects.toThrow(/未就绪/);
    await expect(p.refund(input)).rejects.not.toBeInstanceOf(BizException);
  });

  it('刻意不实现 simulatePaid —— 免鉴权改单口子在 real 通道不存在', () => {
    const p = makeProvider();
    expect(p.simulatePaid).toBeUndefined();
    expect(p.isMock).toBe(false);
  });
});
