import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { SubscribeMessageInput, WxNotifyProvider } from './wx-notify.provider';

/** 提前刷新窗口（秒）：微信给 7200s，提前 300s 换新，避免临界失效 */
const TOKEN_AHEAD_SECONDS = 300;

/**
 * 「手里这把 token 已经不认了」类错误码 —— 清缓存重试一次即可恢复。
 *
 * · 40001 invalid credential：别处刷新过 token，旧的被顶掉
 * · 40014 invalid access_token：同上
 * · 42001 access_token expired：到期（缓存时间算错 / 服务端时钟漂移）
 */
const TOKEN_INVALID_CODES = new Set([40001, 40014, 42001]);

/** 微信侧错误码 → 运营看得懂的说明（命中不到就原样带 errmsg） */
const ERRCODE_HINT: Record<number, string> = {
  40003: 'openid 无效或不属于本小程序',
  40037: '模板 ID 无效（检查后台 P36 配的模板是否属于本小程序）',
  43101: '用户未授权或已拒收该模板（一次性订阅需在下单/申请时重新授权）',
  47003: '模板字段与 data 不匹配（模板关键词被改过 / 传了空值）',
  45009: '接口调用频率超限',
  48001: '小程序未开通订阅消息能力',
};

/**
 * 微信订阅消息 · 真实实现（`PROVIDER_MODE=real`）
 *
 * ## 为什么现在才补
 *
 * 此前 `providers.module.ts` 里 `WX_NOTIFY_PROVIDER` 的工厂**无条件**返回 Mock
 * （连 `PROVIDER_MODE` 都没读）。于是 6 个已接线的订阅场景 —— 退款结果、佣金入账、
 * 截单提醒、团长申请结果、楼宇停供履约/退款 —— 在线上全部「投递成功」：
 * `ab_message` 里写着 `status=success`，而微信侧一条都没收到。
 *
 * ⚠️ **这类假成功比报错更难发现**：日志有记录、业务不报错、用户只是"没收到"，
 *    没人会去怀疑一张全是 success 的表。所以本类的日志里**成功也记**，且明确带
 *    `mock` / `real` 通道字样，让「发过」和「发到了」在日志里可区分。
 *
 * ## 三条实现约束
 *
 * 1. **token 必须缓存**。微信 token 7200s 有效，且每取一次都会让上一个失效；
 *    每次发送都去取 = 一单高峰互相踢、很快撞 45009。这里内存缓存 + 提前 5 分钟刷新
 *    + 并发去重（同时发现无 token 时只发一次请求）。
 * 2. **token 失效要重试一次**。服务重启、别处刷新都可能让手里的 token 立刻失效，
 *    这类失败是**瞬时**的，不重试就会在日志里留下一片假的"发送失败"。
 * 3. **不抛异常**。与抽象契约一致 —— 钱已经退了，通知失败只能算「这次没通知到」，
 *    不能反过来把成功的交易弄成失败。网络层异常也在这里收成 `{ ok: false }`。
 *
 * ## 模板 ID 从哪来（别去配环境变量）
 *
 * 真源是 **`ab_message_template.wechat_template_id`**（运营在后台 P36 填）。
 * `config/wechat.config.ts` 里那组 `WX_TPL_*` 是**历史遗留、无人读取**，别往里配。
 */
@Injectable()
export class RealWxNotifyProvider extends WxNotifyProvider {
  private readonly logger = new Logger('WxNotify:real');
  private readonly appId: string;
  private readonly appSecret: string;
  /**
   * `miniprogram_state`：打开通知落地页时进入的版本。
   *
   * ⚠️ **体验版测试必须设 `trial`**：`formal` 下微信只认正式版页面，
   * 而通知的 `page` 在体验版里同样存在，用 `formal` 会落到"页面不存在"。
   * 正式发布后设回 `formal`（默认值）。
   */
  private readonly miniState: 'formal' | 'trial' | 'developer';

  private token: string | null = null;
  /** 毫秒时间戳；0 = 无有效缓存 */
  private tokenExpireAt = 0;
  /** 并发去重：多个发送同时发现无 token 时，只发一次取 token 请求 */
  private inflightToken: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {
    super();
    this.appId = this.config.get<string>('wechat.mini.appId') ?? '';
    this.appSecret = this.config.get<string>('wechat.mini.appSecret') ?? '';

    const raw = (this.config.get<string>('app.notifyMiniState') ?? 'formal').toLowerCase();
    this.miniState =
      raw === 'trial' || raw === 'developer' ? (raw as 'trial' | 'developer') : 'formal';

    if (!this.appId || !this.appSecret) {
      // 不抛：与 Mock 一样构造成功，发送时逐条返回失败原因（否则整个应用启动不起来）
      this.logger.warn('WX_MINI_APPID / WX_MINI_SECRET 未配置，订阅消息发送必然失败');
    }
  }

  get isMock(): boolean {
    return false;
  }

  async send(input: SubscribeMessageInput): Promise<{ ok: boolean; errMsg?: string }> {
    if (!this.appId || !this.appSecret) {
      return { ok: false, errMsg: 'WX_MINI_APPID / WX_MINI_SECRET 未配置' };
    }
    if (!input.templateId) {
      // 正常不会走到：`missingForEnable()` 已把「无模板 ID」挡在投递之前
      return { ok: false, errMsg: '模板 ID 为空（后台 P36 未配置）' };
    }
    if (!input.openid) {
      return { ok: false, errMsg: 'openid 为空' };
    }

    try {
      let r = await this.postOnce(input, await this.getAccessToken());

      // token 可能刚被顶掉：清缓存重试一次（只重试这一类，别把业务错误也重试）
      if (!r.ok && r.code !== undefined && TOKEN_INVALID_CODES.has(r.code)) {
        this.logger.warn(`access_token 失效（errcode=${r.code}），已刷新并重试一次`);
        this.invalidateToken();
        r = await this.postOnce(input, await this.getAccessToken());
      }

      if (!r.ok) {
        this.logger.warn(
          `订阅消息发送失败：scene=${input.scene ?? '-'} template=${input.templateId} ` +
            `errcode=${r.code ?? '-'}（${r.errMsg ?? '未知'}）`,
        );
        return { ok: false, errMsg: r.errMsg };
      }

      // 成功也记一条：与 mock 的 `[mock]` 日志对照，才能事后证明「真的发出去了」
      this.logger.log(
        `订阅消息已投递：scene=${input.scene ?? '-'} template=${input.templateId} ` +
          `state=${this.miniState}`,
      );
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`订阅消息发送异常（不影响业务）：${msg}`);
      return { ok: false, errMsg: msg };
    }
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  /** 单次 HTTP 调用（不做重试，重试策略在 `send()` 里统一收口） */
  private async postOnce(
    input: SubscribeMessageInput,
    accessToken: string,
  ): Promise<{ ok: boolean; code?: number; errMsg?: string }> {
    const url =
      'https://api.weixin.qq.com/cgi-bin/message/subscribe/send' +
      `?access_token=${encodeURIComponent(accessToken)}`;

    const { data } = await axios.post(
      url,
      {
        touser: input.openid,
        template_id: input.templateId,
        // ⚠️ page 不带前导 `/`（微信要求），且必须与 pages.json 的真实路由一致。
        //    调用方传的是 `NOTIFY_PAGES.*`（唯一真相），此处只做兜底裁剪。
        ...(input.page ? { page: input.page.replace(/^\/+/, '') } : {}),
        data: this.dropEmptyValues(input.data),
        miniprogram_state: this.miniState,
        lang: 'zh_CN',
      },
      { timeout: 5000 },
    );

    const code = Number(data?.errcode ?? -1);
    if (code === 0) return { ok: true };

    const raw = String(data?.errmsg ?? '未知错误');
    const hint = ERRCODE_HINT[code];
    return { ok: false, code, errMsg: hint ? `${code} ${hint}` : `${code} ${raw}` };
  }

  /**
   * 剔除空值字段。
   *
   * 微信对模板 `data` 的要求是「模板里的每个关键词都必须给值，且不能是空串」——
   * 传空串直接 `47003 参数不合法`。业务侧组装时难免有可选变量（如备注），
   * 与其让整条通知失败，不如把空的那个字段摘掉：微信只会因为**缺关键词**报错，
   * 而缺的往往正是模板里没有绑定的那个。
   */
  private dropEmptyValues(
    data: Record<string, { value: string }>,
  ): Record<string, { value: string }> {
    const out: Record<string, { value: string }> = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      const val = typeof v?.value === 'string' ? v.value.trim() : '';
      if (val) out[k] = { value: val.slice(0, 20) }; // 微信 thing 类上限 20 字，超了会 47003
    }
    return out;
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpireAt) return this.token;
    if (this.inflightToken) return this.inflightToken;

    this.inflightToken = this.fetchToken().finally(() => {
      this.inflightToken = null;
    });
    return this.inflightToken;
  }

  private async fetchToken(): Promise<string> {
    const { data } = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: { grant_type: 'client_credential', appid: this.appId, secret: this.appSecret },
      timeout: 5000,
    });

    const token: string | undefined = data?.access_token;
    if (!token) {
      throw new Error(`获取 access_token 失败：errcode=${data?.errcode} errmsg=${data?.errmsg}`);
    }

    const ttl = Number(data?.expires_in ?? 7200);
    this.token = token;
    this.tokenExpireAt = Date.now() + Math.max(60, ttl - TOKEN_AHEAD_SECONDS) * 1000;
    this.logger.log(`access_token 已刷新（有效期 ${ttl}s）`);
    return token;
  }

  private invalidateToken(): void {
    this.token = null;
    this.tokenExpireAt = 0;
  }
}
