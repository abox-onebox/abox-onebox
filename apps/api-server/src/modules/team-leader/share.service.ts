import { Inject, Injectable, Logger } from '@nestjs/common';

import { currentTimeline, formatTimeOfDay } from '../../common/utils/order-timeline';
import { TeamLeader } from '../../database/entities/leader.entity';
import { WX_MINI_PROVIDER, WxMiniProvider } from '../../providers/wx-mini/wx-mini.provider';
import { STORAGE_PROVIDER, StorageProvider } from '../../providers/storage/storage.provider';

/**
 * 分享中心服务（M2 · 2.7 · 接口 L2 / L3）
 *
 * 落点：`modules/team-leader/share`（《开发里程碑计划 v1.0》2.7）
 *
 * | L2 | GET  /leader/share         | 分享物料（小程序路径 / 邀请码 / 海报底图） |
 * | L3 | POST /leader/share/qrcode  | 生成带团长 ID 的小程序码（返回图片 URL）   |
 *
 * **邀请码格式**：`LDR` + 4 位零填充团长 id（如 `LDR0001`），与《接口规范》§3.3 U6
 * 的 `leaderCode` 入参示例一致 —— 采用**确定性生成**而非落库，避免多一个需要维护
 * 唯一性的字段；团长 id 本身即唯一键。
 *
 * **小程序码**：2026-11-20 已接入真实微信 `wxacode.getUnlimited` —— provider 生成图片
 * 二进制，storage 落盘返回持久 URL，按 `scene` 缓存（同一团长复用，避免微信调用配额）。
 * mock 模式下 provider 返回占位 PNG，仅本地联调用，不部署生产。
 */
@Injectable()
export class ShareService {
  private readonly logger = new Logger('ShareService');

  /** scene+size → {url,base64} 的内存缓存（进程内；重启后重生成，图片本体在 storage 不丢） */
  private readonly qrcodeCache = new Map<string, { url: string; base64: string }>();

  constructor(
    @Inject(WX_MINI_PROVIDER) private readonly wxMini: WxMiniProvider,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /** ⭐ 2026-11-11 收口：邀请落地页读 `leaderCode` 并调 `bindLeaderByInvite`；
   *   原指首页，而首页与 `App.vue` 都不读 `leaderCode` ⇒ 拉新归属链路不通。 */
  private static readonly LANDING_PATH = 'pages/leader-invite/leader-invite';

  /** L2 · 分享物料 */
  getShareMaterial(leader: TeamLeader) {
    const inviteCode = buildInviteCode(leader.id);
    /** scene 与分享码同源：直接承载邀请码，落地页读 scene 即得 leaderCode */
    const scene = inviteCode;

    return {
      inviteCode,
      scene,
      /** 落地路径（端上生成分享卡片用） */
      path: ShareService.LANDING_PATH,
      /** 端上可直接拼的完整参数串 */
      shareQuery: `leaderCode=${inviteCode}`,
      // ⭐ 2026-11-11 去餐化：原「一饭四菜」是餐饮自营旧口径，与当前预包装快消品冲突；
      //    且本串由服务端下发，`mp:ux-terms` 只扫前端 `.vue`，扫不到。
      title: 'ABox 一盒 · ¥25.80 / 份',
      // ⚠️ 送达时刻**派生自真源**（PR-02 收口）：改前是手写 `'11:30'`，
      //    后台把「送达时间」改掉后，团长转发出去的分享语与系统实际行为**不一致**，
      //    而分享语是**离线的**（转发到微信群后无法再纠正）。
      desc: `${leader.realName} 邀请你一起预订次日的「一盒」，上午 ${formatTimeOfDay(currentTimeline().arrival)} 送到工位`,
      /** 海报底图：端上 canvas 自绘，服务端不提供底图 */
      posterUrl: null as string | null,
      qrcodeUrl: null as string | null,
      /** 小程序码能力已接入（L3 按需生成）；端上据此显示「生成二维码海报」入口 */
      mock: this.wxMini.isMock,
      tips: '可转发小程序卡片或生成二维码海报给同事',
    };
  }

  /**
   * L3 · 生成小程序码（真实微信 wxacode.getUnlimited）
   *
   * 流程：provider 取图片二进制 → storage 按 scene 落盘 → 返回持久 URL。
   * 按 scene 进程内缓存：同一团长重复调用直接复用，避免消耗微信小程序码配额。
   */
  async generateQrcode(leader: TeamLeader, width = 430) {
    const inviteCode = buildInviteCode(leader.id);
    // ⭐ scene 直接承载邀请码（而非 `l=<id>`）：落地页读到 scene 即现成 leaderCode，
    //    端上无需自行拼 LDR+id（避免邀请码规则在端上留第二份真源）。
    const scene = inviteCode;
    const size = Math.min(Math.max(Math.floor(width) || 430, 280), 1280);
    const key = `qrcodes/${scene}-${size}.png`;

    let cached = this.qrcodeCache.get(key);
    if (!cached) {
      const { buffer, contentType } = await this.wxMini.getUnlimitedQRCode(scene, size);
      // 微信返回的是 PNG 流，storage key 固定 .png；contentType 仅作记录
      const saved = await this.storage.upload({ key, buffer, contentType });
      cached = { url: saved.url, base64: buffer.toString('base64') };
      this.qrcodeCache.set(key, cached);
      this.logger.log(`生成小程序码：团长#${leader.id} scene=${scene} width=${size} → ${key}`);
    }

    return {
      inviteCode,
      scene,
      path: ShareService.LANDING_PATH,
      width: size,
      qrcodeUrl: cached.url,
      /**
       * ⭐ 同时下发 base64：端上海报合成走「写本地临时文件 → drawImage」，
       *    绕开 downloadFile 合法域名白名单（当前只配了 request 域名，未配 downloadFile）。
       */
      qrcodeBase64: cached.base64,
      mock: false,
      tips: '可保存小程序码海报到相册，转发给同事',
    };
  }
}

/** 团长邀请码：LDR + 4 位零填充 id（确定性生成，如 LDR0001） */
export function buildInviteCode(leaderId: number | string): string {
  return `LDR${String(leaderId).padStart(4, '0')}`;
}

/** 反解邀请码 → 团长 id；格式非法返回 null */
export function parseInviteCode(code: string | undefined | null): number | null {
  if (!code) return null;
  const m = /^LDR(\d{4,})$/.exec(code.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * 用户推荐码：USR + 4 位零填充用户 id（确定性生成，如 USR0001）
 *
 * 与 `LDR` 团长码并列：普通注册用户（非团长）也能推荐别人当团长，
 * 落地页 `pages/leader-apply/leader-apply?ref=USRxxxx`，申请时回传本码以绑定
 * `ab_leader_invite.inviter_user_id`（见 `invite.service` / `team-leader.service`）。
 */
export function buildUserReferralCode(userId: number | string): string {
  return `USR${String(userId).padStart(4, '0')}`;
}

/** 反解用户推荐码 → 用户 id；格式非法返回 null */
export function parseUserReferralCode(code: string | undefined | null): number | null {
  if (!code) return null;
  const m = /^USR(\d{4,})$/i.exec(code.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** 推荐码类型：leader=团长 LDR 码 / user=普通用户 USR 码 */
export type ReferralCodeKind = 'leader' | 'user';

/** 解析结果：区分推荐人身份 */
export interface ParsedReferralCode {
  kind: ReferralCodeKind;
  id: number;
}

/**
 * 统一解析推荐码（LDR 团长码 / USR 用户码）
 *
 * ⚠️ 纯数字回退仅作本地联调 / e2e 兼容，且一律按**团长 id** 处理
 *   （与生产入口只有二维码里的 `LDR…` / 分享链接里的 `USR…` 一致）。
 *
 * @returns 无法识别返回 null（调用方据此静默跳过，不阻断登录）
 */
export function parseReferralCode(code: string | undefined | null): ParsedReferralCode | null {
  if (!code) return null;
  const trimmed = code.trim();

  const leader = parseInviteCode(trimmed);
  if (leader) return { kind: 'leader', id: leader };

  const user = parseUserReferralCode(trimmed);
  if (user) return { kind: 'user', id: user };

  // 兼容纯数字（本地联调）：按团长 id 处理
  const asId = Number(trimmed);
  if (Number.isInteger(asId) && asId > 0) return { kind: 'leader', id: asId };

  return null;
}
