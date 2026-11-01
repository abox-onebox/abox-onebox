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
  data?: { token?: string; expiresIn?: number; account?: { role?: string } };
}

/** 执行身份：owner = 负责人（高权限），staff = 同事（受限） */
export type SvcTier = 'owner' | 'staff';

/** 每个身份一个槽位：令牌、到期、单飞、冷却各自独立 */
interface Slot {
  token: string | null;
  expiresAt: number;
  inflight: Promise<string | null> | null;
  cooldownUntil: number;
  /** 上次登录成功时拿到的真实角色，用于「身份与预期不符」告警 */
  role: string | null;
}

/**
 * 企业微信机器人的「服务账号」令牌自续（按身份分槽位）
 *
 * 为什么需要它：
 *   绑定表里存的是**人工粘贴的 JWT**，默认 7 天过期 ⇒ 用到第 8 天会突然全部失败，
 *   又得找负责人重新签发。这不是一个「文化水平不高」的同事能维护的东西。
 *
 *   故改为：机器人自己用专用账号登录、在内存里自续；使用者只管说话。
 *   审计里的**发起人**仍取绑定表的 operatorName（真人），**执行身份**是服务账号 ——
 *   两者分开记录，谁下的手不会糊。
 *
 * 为什么分两个槽位（而不是一个万能账号）：
 *   负责人要能操作**全部 131 个后台端点**，但同事只能操作其中 69 个。若共用一个
 *   高权限账号，则「同事能不能动钱」只能靠代码自觉；分成两个真实角色后，
 *   **后台自己的 @Roles 就是第二道闸门** —— 代码写错也不会让 operator 令牌动到钱。
 *
 *     owner → WECOM_OWNER_USERNAME / WECOM_OWNER_PASSWORD，后台角色 admin
 *     staff → WECOM_SVC_USERNAME   / WECOM_SVC_PASSWORD，  后台角色 operator
 *
 * 边界（别越）：
 *   审批人（approver）**不走这里**，仍由负责人在绑定表里自己贴令牌。
 *   动钱 / 动单 / 动团长这类高危操作必须留下**真人**的批准动作，不能被服务账号代劳。
 *
 * 账号锁定保护：
 *   adminLogin 连错 5 次锁 15 分钟。故这里失败后只冷却 60s 再试、且**不在启动时预登录**
 *   —— 口令配错也只是每分钟一次，不会把账号锁到「怎么改都不生效」。
 *
 * 令牌绝不落日志：只记 code / message / 有效期 / 角色。
 */
@Injectable()
export class WecomSvcTokenService {
  private readonly logger = new Logger(WecomSvcTokenService.name);

  private readonly slots: Record<SvcTier, Slot> = {
    owner: { token: null, expiresAt: 0, inflight: null, cooldownUntil: 0, role: null },
    staff: { token: null, expiresAt: 0, inflight: null, cooldownUntil: 0, role: null },
  };

  private env(name: string): string {
    return (process.env[name] || '').trim();
  }

  private creds(tier: SvcTier): { username: string; password: string } {
    const u = tier === 'owner' ? 'WECOM_OWNER_USERNAME' : 'WECOM_SVC_USERNAME';
    const p = tier === 'owner' ? 'WECOM_OWNER_PASSWORD' : 'WECOM_SVC_PASSWORD';
    return { username: this.env(u), password: this.env(p) };
  }

  /** 该身份是否已配置：未配置时上层要给「人话提示」，而不是沉默失败 */
  isConfigured(tier: SvcTier = 'staff'): boolean {
    const c = this.creds(tier);
    return Boolean(c.username && c.password);
  }

  /** 已配置的身份列表（用于启动自检与「帮助」页展示） */
  configuredTiers(): SvcTier[] {
    return (['owner', 'staff'] as SvcTier[]).filter((t) => this.isConfigured(t));
  }

  /** 上次登录成功的真实角色（未登录过为 null） */
  lastRole(tier: SvcTier): string | null {
    return this.slots[tier].role;
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
  async get(tier: SvcTier = 'staff'): Promise<string | null> {
    const slot = this.slots[tier];
    const now = Date.now();
    if (slot.token && now < slot.expiresAt) return slot.token;
    if (now < slot.cooldownUntil) return null;
    if (!this.isConfigured(tier)) return null;
    if (slot.inflight) return slot.inflight;

    slot.inflight = this.login(tier)
      .catch((e: unknown) => {
        this.logger.error(`[${tier}] 服务账号登录异常：` + (e as Error).message);
        return null;
      })
      .finally(() => {
        slot.inflight = null;
      });
    return slot.inflight;
  }

  private async login(tier: SvcTier): Promise<string | null> {
    const slot = this.slots[tier];
    const { username, password } = this.creds(tier);
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
        slot.token = String(data.token);
        slot.expiresAt = Date.now() + usableSec * 1000;
        slot.cooldownUntil = 0;
        slot.role = data.account && data.account.role ? String(data.account.role) : null;

        // 身份与预期不符要吼一声：owner 槽位配成 operator 会让负责人「什么都不能干」，
        // 而现象只是「点了没反应」，不查日志根本看不出来。
        const expect = tier === 'owner' ? 'admin' : 'operator';
        if (
          slot.role &&
          slot.role !== expect &&
          !(tier === 'owner' && slot.role === 'super_admin')
        ) {
          this.logger.warn(
            `[${tier}] 服务账号角色是 ${slot.role}，与预期 ${expect} 不符 —— 该身份能做的事会与配置不同`,
          );
        }

        this.logger.log(
          `[${tier}] 服务账号已登录 username=${username} role=${slot.role ?? '?'} 有效期 ${ttlSec}s（提前 ${aheadSec}s 续期，缓存 ${usableSec}s）`,
        );
        return slot.token;
      }

      // 失败：冷却 60s，只记 code 与 message
      slot.cooldownUntil = Date.now() + 60_000;
      this.logger.error(
        `[${tier}] 服务账号登录失败 code=${body ? body.code : 'N/A'} msg=${
          body ? body.message : '响应非 JSON'
        }`,
      );
      return null;
    } catch (e) {
      slot.cooldownUntil = Date.now() + 60_000;
      this.logger.error(`[${tier}] 服务账号登录请求未送达：` + (e as Error).message);
      return null;
    }
  }

  /** 令牌被后台判失效（code 10002）时主动作废，下一轮重新登录 */
  invalidate(tier: SvcTier = 'staff'): void {
    const slot = this.slots[tier];
    slot.token = null;
    slot.expiresAt = 0;
  }

  /** 测试与改密后用：清空全部缓存与冷却 */
  reset(): void {
    for (const t of ['owner', 'staff'] as SvcTier[]) {
      const slot = this.slots[t];
      slot.token = null;
      slot.expiresAt = 0;
      slot.cooldownUntil = 0;
      slot.role = null;
    }
  }
}
