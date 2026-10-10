import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createVerify, X509Certificate } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Pay from 'wechatpay-node-v3';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  PayNotifyResult,
  PrepayInput,
  PrepayResult,
  RefundInput,
  RefundResult,
  WxPayProvider,
} from './wx-pay.provider';

/**
 * 回调时间戳容差（秒）—— 防重放
 *
 * 微信官方建议 5 分钟。超过容差直接判失败：**宁可丢一次回调（微信会重推），
 * 也不接受一个可能是重放的报文**。
 */
const NOTIFY_MAX_SKEW_SEC = 300;

/** 平台证书自动拉取的最小间隔（毫秒）—— 未命中时不至于每次回调都打微信 */
const CERT_FETCH_MIN_INTERVAL_MS = 60_000;

/**
 * 微信支付 V3 · 真实实现（PROVIDER_MODE=real）
 *
 * ## 状态：**已落地（方案 A）**
 *
 * 三条能力均已实现，SDK `wechatpay-node-v3@2.2.1`（已在 package.json）负责
 * 请求签名与 HTTP 调用；**回调验签由本类自己实现**（理由见 `verifySign` 注释）。
 *
 * ## ⛔ 上线前的硬前提（缺一不可，缺则调用时抛错）
 *
 *   `WX_MINI_APPID` / `WXPAY_MCH_ID` / `WXPAY_API_V3_KEY` / `WXPAY_SERIAL_NO`
 *   `WXPAY_PRIVATE_KEY_PATH`（商户 API 私钥 apiclient_key.pem）
 *   `WXPAY_NOTIFY_URL`（**必须是 HTTPS 公网地址**，且路径是本服务的 `/api/v1/pay/notify`）
 *
 *   平台证书（`WXPAY_PLATFORM_CERT_PATH`）可留空 ⇒ 首次回调时自动调 `/v3/certificates` 拉取；
 *   也可预先下载好挂上去，省掉这次网络依赖。
 *
 * ## 三条能力的落点
 *
 *   1. 统一下单  POST /v3/pay/transactions/jsapi（JSAPI / 小程序）
 *   2. 申请退款  POST /v3/refund/domestic/refunds（`out_refund_no` 作幂等键，重试不重复出款）
 *   3. 回调      验签（RSA-SHA256 + 平台证书）→ AES-256-GCM 解密 resource → 解析 trade_state
 *
 * ⚠️ **刻意不实现 `simulatePaid`**：那是 mock 专属的调试钩子。real 通道补上它，
 *    就等于给 `POST /pay/mock/paid`（`@Public()` 免鉴权）开一个改单口子。
 *    `PaymentService.simulatePaid` 另有 `isMock` 显式守卫作第二道防线。
 */
@Injectable()
export class RealWxPayProvider extends WxPayProvider {
  private readonly logger = new Logger('WxPay:real');

  private readonly appId: string;
  private readonly mchId: string;
  private readonly apiV3Key: string;
  private readonly serialNo: string;
  private readonly notifyUrl: string;
  private readonly refundNotifyUrl: string;
  private readonly privateKeyPath: string;
  private readonly platformCertPath: string;
  private readonly autoFetchCert: boolean;

  /** 构造时算一次的「缺哪些必配项」—— 调用时才抛，避免启动即崩（服务还要能起、能自检） */
  private readonly missing: string[] = [];

  private client: Pay | null = null;
  /** 构造 client 失败的原因（私钥读不到 / SDK 拒绝），调用时一并报出来 */
  private clientErr: string | null = null;

  /**
   * 平台证书：serial（大写 hex、无冒号）→ PEM
   *
   * ⚠️ 刻意用 `protected` 而非 `private`：**唯一用途是让单测能在离线环境注入证书**
   * （`test/unit/real-wx-pay-notify.spec.ts` 现场生成 RSA 密钥对，不依赖 openssl、
   * 也不往仓库里提交任何密钥文件）。它**不是**业务扩展点，子类请勿写它。
   */
  protected readonly certs = new Map<string, string>();
  private lastCertFetchAt = 0;

  constructor(private readonly config: ConfigService) {
    super();
    this.appId = this.config.get<string>('wechat.mini.appId') ?? '';
    this.mchId = this.config.get<string>('wechat.pay.mchId') ?? '';
    this.apiV3Key = this.config.get<string>('wechat.pay.apiV3Key') ?? '';
    this.serialNo = this.config.get<string>('wechat.pay.serialNo') ?? '';
    this.notifyUrl = this.config.get<string>('wechat.pay.notifyUrl') ?? '';
    this.refundNotifyUrl = this.config.get<string>('wechat.pay.refundNotifyUrl') ?? '';
    this.privateKeyPath = this.config.get<string>('wechat.pay.privateKeyPath') ?? '';
    this.platformCertPath = this.config.get<string>('wechat.pay.platformCertPath') ?? '';
    this.autoFetchCert = this.config.get<boolean>('wechat.pay.autoFetchCert') ?? true;

    if (!this.appId) this.missing.push('WX_MINI_APPID');
    if (!this.mchId) this.missing.push('WXPAY_MCH_ID');
    if (!this.apiV3Key) this.missing.push('WXPAY_API_V3_KEY');
    if (!this.serialNo) this.missing.push('WXPAY_SERIAL_NO');
    if (!this.privateKeyPath) this.missing.push('WXPAY_PRIVATE_KEY_PATH');
    if (!this.notifyUrl) this.missing.push('WXPAY_NOTIFY_URL');

    if (this.missing.length) {
      // ⚠️ 只 WARN 不抛：服务仍要能起来跑自检（/health/ready），真正的拒绝发生在调用时
      this.logger.warn(
        `微信支付商户参数不完整（缺 ${this.missing.join(' / ')}），real 通道调用将失败`,
      );
      return;
    }

    try {
      this.client = this.buildClient();
      this.loadLocalCerts();
    } catch (e) {
      this.clientErr = (e as Error).message;
      this.client = null;
      this.logger.error(`微信支付客户端初始化失败：${this.clientErr}`);
    }
  }

  get isMock(): boolean {
    return false;
  }

  // ==========================================================================
  // ① 统一下单
  // ==========================================================================

  async createPrepay(input: PrepayInput): Promise<PrepayResult> {
    let client: Pay;
    try {
      client = this.ensureClient();
    } catch (e) {
      throw new BizException(ErrorCode.PAY_CREATE_FAILED, (e as Error).message);
    }

    const res = await client.transactions_jsapi({
      description: input.description,
      out_trade_no: input.orderNo,
      notify_url: this.notifyUrl,
      amount: { total: input.amountFen, currency: 'CNY' },
      payer: { openid: input.openid },
    });

    // ⚠️ `Output.status` 是 **HTTP 状态码**，`data.status`（退款才有）才是业务状态 —— 别混
    if (res.status !== 200 || !res.data?.prepay_id) {
      const detail = res.errRaw ?? res.error ?? res.data;
      this.logger.error(
        `微信统一下单失败 orderNo=${input.orderNo} HTTP=${res.status} detail=${JSON.stringify(detail)?.slice(0, 300)}`,
      );
      throw new BizException(ErrorCode.PAY_CREATE_FAILED);
    }

    const d = res.data as {
      prepay_id: string;
      timeStamp: string;
      nonceStr: string;
      package: string;
      paySign: string;
    };

    this.logger.log(
      `[real] 统一下单成功 orderNo=${input.orderNo} 金额=${input.amountFen}分 prepayId=${d.prepay_id}`,
    );

    return {
      prepayId: d.prepay_id,
      payParams: {
        timeStamp: d.timeStamp,
        nonceStr: d.nonceStr,
        package: d.package,
        signType: 'RSA',
        paySign: d.paySign,
      },
    };
  }

  // ==========================================================================
  // ② 申请退款
  // ==========================================================================

  async refund(input: RefundInput): Promise<RefundResult> {
    // ⚠️ 这里抛的是**普通 Error**（不是 BizException）：`RefundService.attemptWxRefund`
    //    的契约是「抛错 = 需要重试」，交由队列按 `refundNo` 幂等重试。
    const client = this.ensureClient();

    const res = await client.refunds({
      out_trade_no: input.orderNo,
      out_refund_no: input.refundNo,
      ...(input.reason ? { reason: input.reason.slice(0, 80) } : {}),
      ...(this.refundNotifyUrl ? { notify_url: this.refundNotifyUrl } : {}),
      amount: { total: input.totalFen, refund: input.refundFen, currency: 'CNY' },
    });

    if (res.status < 200 || res.status >= 300) {
      const detail = res.errRaw ?? res.error ?? res.data;
      throw new Error(
        `微信退款未受理（HTTP ${res.status} refundNo=${input.refundNo}）：${JSON.stringify(detail)?.slice(0, 300)}`,
      );
    }

    const d = (res.data ?? {}) as { refund_id?: string; status?: string };
    const status = (d.status ?? '').toUpperCase();

    // ⚠️ 受理成功但拿不到 refund_id 是异常形态：不抛（钱已经退了，抛了会被重试），
    //    但必须留日志 —— 否则对账时找不到微信侧的单号
    if (!d.refund_id) {
      this.logger.warn(
        `[real] 退款已受理但响应缺少 refund_id refundNo=${input.refundNo} status=${status}`,
      );
    }

    this.logger.log(
      `[real] 退款受理 refundNo=${input.refundNo} 退款额=${input.refundFen}分 状态=${status}`,
    );

    return { refundId: d.refund_id ?? '', status, raw: res.data };
  }

  // ==========================================================================
  // ③ 回调验签与解析
  // ==========================================================================

  async parseNotify(headers: Record<string, unknown>, rawBody: string): Promise<PayNotifyResult> {
    const timestamp = this.header(headers, 'wechatpay-timestamp');
    const nonce = this.header(headers, 'wechatpay-nonce');
    const signature = this.header(headers, 'wechatpay-signature');
    const serial = this.header(headers, 'wechatpay-serial');

    if (!timestamp || !nonce || !signature || !serial) {
      throw new Error(
        '微信回调缺少验签头（wechatpay-timestamp / wechatpay-nonce / wechatpay-signature / wechatpay-serial）',
      );
    }

    // —— 反重放：时间戳必须在容差内 ——
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      throw new Error(`微信回调时间戳非法：${timestamp}`);
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > NOTIFY_MAX_SKEW_SEC) {
      throw new Error(
        `微信回调时间戳超出容差（偏离 ${skew}s > ${NOTIFY_MAX_SKEW_SEC}s），疑似重放`,
      );
    }

    // —— 验签 ——
    const certPem = await this.platformCert(serial);
    const ok = createVerify('RSA-SHA256')
      .update(`${timestamp}\n${nonce}\n${rawBody}\n`)
      .verify(certPem, signature, 'base64');
    if (!ok) {
      throw new Error('微信回调验签失败（Wechatpay-Signature 与报文不匹配）');
    }

    // —— 解密 resource（AEAD_AES_256_GCM，密钥 = APIv3 密钥）——
    let body: { resource?: { ciphertext: string; associated_data: string; nonce: string } };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      throw new Error('微信回调报文不是合法 JSON');
    }
    const r = body.resource;
    if (!r?.ciphertext || !r.nonce) {
      throw new Error('微信回调报文缺少 resource.ciphertext / resource.nonce');
    }

    const client = this.ensureClient();
    const plain = client.decipher_gcm<Record<string, unknown>>(
      r.ciphertext,
      r.associated_data ?? '',
      r.nonce,
      this.apiV3Key,
    );

    const tradeState = String(plain.trade_state ?? '');
    const amount = (plain.amount ?? {}) as { total?: number; payer_total?: number };

    return {
      orderNo: String(plain.out_trade_no ?? ''),
      transactionId: String(plain.transaction_id ?? ''),
      amountFen: Number(amount.total ?? 0),
      success: tradeState === 'SUCCESS',
      raw: plain,
    };
  }

  // ==========================================================================
  // 内部：客户端 / 证书 / 验签辅助
  // ==========================================================================

  private ensureClient(): Pay {
    if (this.client) return this.client;
    const why = this.clientErr
      ? this.clientErr
      : `缺失 ${this.missing.join(' / ')}（real 通道必配项，见 real-wx-pay.provider.ts 头注）`;
    throw new Error(`真实微信支付通道未就绪：${why}`);
  }

  private buildClient(): Pay {
    const privateKey = this.readPem(this.privateKeyPath);

    // ⚠️ SDK 构造器强制要求 `publicKey` 非空（否则抛「缺少公钥」），但我们**不用它验签**
    //    （见下方 `platformCert` 的实现理由），它只服务于 `publicEncrypt` / `getSN`；
    //    且我们显式传了 `serial_no`，`getSN` 也不会被调用。
    //    ⇒ 本地没挂平台证书时传一个空 Buffer 作占位，并在此写清原因，避免后人误读成 bug。
    const publicKey = this.platformCertPath ? this.readPem(this.platformCertPath) : Buffer.alloc(0);

    return new Pay({
      appid: this.appId,
      mchid: this.mchId,
      serial_no: this.serialNo,
      publicKey,
      privateKey,
      key: this.apiV3Key,
    });
  }

  private readPem(rawPath: string): Buffer {
    const p = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
    if (!existsSync(p)) {
      throw new Error(`证书/私钥文件不存在：${p}（容器内请挂到绝对路径，如 /etc/abox/certs/...）`);
    }
    return readFileSync(p);
  }

  /** 解析本地平台证书文件（可含多张，轮换期微信会并存） */
  private loadLocalCerts(): void {
    if (!this.platformCertPath) return;
    const pem = this.readPem(this.platformCertPath).toString('utf8');
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (!blocks.length) {
      this.logger.warn(
        `WXPAY_PLATFORM_CERT_PATH 里没有解析到任何 CERTIFICATE 块：${this.platformCertPath}`,
      );
      return;
    }
    for (const b of blocks) {
      try {
        const cert = new X509Certificate(b);
        this.certs.set(this.normSerial(cert.serialNumber), b);
      } catch (e) {
        this.logger.warn(`平台证书解析失败，已跳过：${(e as Error).message}`);
      }
    }
    this.logger.log(
      `已加载微信平台证书 ${this.certs.size} 张：${[...this.certs.keys()].join(', ')}`,
    );
  }

  /**
   * 按 `Wechatpay-Serial` 取平台证书 PEM；本地没有且允许自动拉取时，调 `/v3/certificates`
   *
   * ## ⭐ 为什么不用 SDK 的 `verifySign`
   *
   * SDK 那版的证书缓存是 **`protected static`**：
   *   ① 跨实例共享（多商户/多主体会串）；
   *   ② 未命中时**隐式发起一次网络请求**（`fetchCertificates`），调用方看不出来，
   *      网络不通时表现为「验签失败」而非「拉不到证书」，排查成本高；
   *   ③ 缓存写不进去时无日志。
   *
   * 本项目已多次踩「静默失效」（见《缺陷与陷阱》），故改为**实例级 Map + 显式日志 + fail-closed**：
   * 拿不到证书就抛错，绝不退化成「跳过验签」。
   */
  private async platformCert(serial: string): Promise<string> {
    const key = this.normSerial(serial);
    const hit = this.certs.get(key);
    if (hit) return hit;

    if (this.autoFetchCert && this.client) {
      await this.refreshCertificates();
      const again = this.certs.get(key);
      if (again) return again;
    }

    throw new Error(
      `未找到微信平台证书（serial=${key}）：请下载平台证书到 WXPAY_PLATFORM_CERT_PATH，` +
        `或确认 WXPAY_AUTO_FETCH_CERT 未被关掉（当前=${
          this.autoFetchCert ? '开' : '关'
        }）。拿不到证书时不放行 —— 跳过验签等于把回调变成免鉴权改单入口`,
    );
  }

  private async refreshCertificates(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCertFetchAt < CERT_FETCH_MIN_INTERVAL_MS) return;
    this.lastCertFetchAt = now;

    const client = this.ensureClient();
    const list = await client.get_certificates(this.apiV3Key);
    for (const item of list ?? []) {
      const enc = item.encrypt_certificate;
      const pem = client.decipher_gcm(
        enc.ciphertext,
        enc.associated_data,
        enc.nonce,
        this.apiV3Key,
      );
      this.certs.set(this.normSerial(String(item.serial_no)), String(pem));
    }
    this.logger.log(
      `已从微信拉取平台证书 ${list?.length ?? 0} 张：${[...this.certs.keys()].join(', ')}`,
    );
  }

  private normSerial(s: string): string {
    return String(s ?? '')
      .replace(/:/g, '')
      .toUpperCase();
  }

  private header(headers: Record<string, unknown>, name: string): string {
    // Node 的 http 头一律小写；值可能是 string 或 string[]
    const v = headers[name.toLowerCase()];
    if (Array.isArray(v)) return String(v[0] ?? '');
    return v == null ? '' : String(v);
  }
}
