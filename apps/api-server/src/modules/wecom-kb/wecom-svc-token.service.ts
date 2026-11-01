import { Injectable, Logger } from '@nestjs/common';

/**
 * 后台登录接口的响应外壳（只取用到的字段）
 *
 * ⚠️ 必须独立声明成具名类型：写成 `let body: X | null = null` 再用
 *    `JSON.parse(text) as typeof body`，`typeof body` 会被收窄成 `null`，
 *    后面访问 `body.code` 全部报 TS2339（Property does not exist on type 'never'）。
 */
interface LoginEnvelope {
  code?: number;
  message?: string;
  data?: { token?: string; expiresIn?: number };
}

/**
 * 企业微信机器人的「服务账号」令牌自续
 *
 * 为什么需要它：
 *   绑定表里存的是**人工粘贴的 operator JWT**，默认 7 天过期 ⇒ 同事用到第 8 天会突然
 *   全部失败，又得找负责人重新签发、重新粘贴。这不是一个「文化水平不高」的同事能维护
 *   的东西，也是本功能落地的真正卡点之一。
 *
 *   故改为：机器人自己用一个专用 operator 账号登录、在内存里自续；同事只管说话。
 *   审计里的**发起人**仍取绑定表的 operatorName（真人），**执行身份**是服务账号 ——
 *   两者分开记录，谁下的手不会糊。
 *
 * 边界（别越）：
 *   审批人（approver）**不走这里**，仍由负责人在绑定表里自己贴 admin 令牌。
 *   动钱 / 动单 / 动团长这类高危操作必须留下**真人**的批准动作，不能被服务账号代劳。
 *
 * 账号锁定保护：
 *   adminLogin 连错 5 次锁 15 分钟（app.adminLoginMaxAttempts）。故这里失败后只冷却
 *   60s 再试、且**不在启动时预登录** —— 口令配错也只是每分钟一次，不会把账号锁到
 *   「怎么改都不生效」。
 *
 * 令牌绝不落日志：只记 code / message / 有效期。
 */
@Injectable()
export class WecomSvcTokenService {
  private readonly logger = new Logger(WecomSvcTokenService.name);

  /** 缓存令牌；null 表示尚未登录或上次失败 */
  private token: string | null = null;
  /** 到期时间戳（ms）。提前续期，不等到真过期 */
  private expiresAt = 0;
  /** 单飞：并发进来的调用共用同一次登录，避免一次涌入打出 5 次失败被锁 */
  private inflight: Promise<string | null> | null = null;
  /** 失败冷却截止（ms） */
  private cooldownUntil = 0;

  private env(name: string): string {
    return (process.env[name] || '').trim();
  }

  /** 服务账号是否已配置：未配置时上层要给「人话提示」，而不是沉默失败 */
  isConfigured(): boolean {
    return Boolean(this.env('WECOM_SVC_USERNAME') && this.env('WECOM_SVC_PASSWORD'));
  }

  private base(): string {
    return (
      process.env.WECOM_INTERNAL_API_BASE || 'http://127.0.0.1:' + (process.env.PORT || '3000')
    );
  }

  private prefix(): string {
    return process.env.API_PREFIX || '/api/v1';
  }

  /** 取可用令牌；不可用时返回 null（调用方负责给人话提示） */
  async get(): Promise<string | null> {
    const now = Date.now();
    if (this.token && now < this.expiresAt) return this.token;
    if (now < this.cooldownUntil) return null;
    if (!this.isConfigured()) return null;
    if (this.inflight) return this.inflight;

    this.inflight = this.login()
      .catch((e: unknown) => {
        this.logger.error('服务账号登录异常：' + (e as Error).message);
        return null;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async login(): Promise<string | null> {
    const username = this.env('WECOM_SVC_USERNAME');
    const password = this.env('WECOM_SVC_PASSWORD');
    const url = this.base() + this.prefix() + '/auth/admin-login';

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const text = await resp.text();
      let body: LoginEnvelope | null = null;
      try {
        body = JSON.parse(text) as LoginEnvelope;
      } catch {
        // 非 JSON（如网关错误页）按失败处理，下面统一记 code=N/A
      }

      const data = body && body.data ? body.data : null;
      if (body && body.code === 0 && data && data.token) {
        const ttlSec = Number(data.expiresIn) > 0 ? Number(data.expiresIn) : 7 * 24 * 3600;
        // 提前续：留 20% 余量，但至少 5 分钟 —— 否则 1 分钟的 TTL 会算出负数永远续不上
        const aheadSec = Math.max(300, Math.floor(ttlSec * 0.2));
        // ⚠️ 但可用时长**不能超过真实 TTL**：TTL 只有 1 秒时仍按 1 秒计。
        //    否则缓存期会长于令牌寿命，拿着一张已失效的令牌去调接口（10002 循环）。
        const usableSec = Math.max(1, Math.min(ttlSec - aheadSec, ttlSec));
        this.token = String(data.token);
        this.expiresAt = Date.now() + usableSec * 1000;
        this.cooldownUntil = 0;
        this.logger.log(
          `服务账号已登录 username=${username} 有效期 ${ttlSec}s（提前 ${aheadSec}s 续期，缓存 ${usableSec}s）`,
        );
        return this.token;
      }

      // 失败：冷却 60s，只记 code 与 message
      this.cooldownUntil = Date.now() + 60_000;
      this.logger.error(
        `服务账号登录失败 code=${body ? body.code : 'N/A'} msg=${
          body ? body.message : '响应非 JSON'
        }`,
      );
      return null;
    } catch (e) {
      this.cooldownUntil = Date.now() + 60_000;
      this.logger.error('服务账号登录请求未送达：' + (e as Error).message);
      return null;
    }
  }

  /** 令牌被后台判失效（code 10002）时主动作废，下一轮重新登录 */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  /** 测试与改密后用：清空缓存与冷却 */
  reset(): void {
    this.token = null;
    this.expiresAt = 0;
    this.cooldownUntil = 0;
  }
}
