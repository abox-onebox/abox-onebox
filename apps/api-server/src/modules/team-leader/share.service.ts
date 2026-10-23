import { Injectable, Logger } from '@nestjs/common';

import { currentTimeline, formatTimeOfDay } from '../../common/utils/order-timeline';
import { TeamLeader } from '../../database/entities/leader.entity';

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
 * **小程序码现状（务必知悉）**：真实小程序码需调微信 `wxacode.getUnlimited`，
 * 而 `WxMiniProvider` 尚未提供该方法（属 M5 上线前事项）。故当前 `mock=true`
 * 且 `qrcodeUrl=null`，端上应展示占位并提示「生成中」——**不要**用伪造 URL
 * 冒充真实图片，那会让联调期误判「已经能出码」。
 */
@Injectable()
export class ShareService {
  private readonly logger = new Logger('ShareService');

  /** 小程序落地页（与 `apps/miniprogram/src/pages.json` 首个页面一致） */
  private static readonly LANDING_PATH = 'pages/index/index';

  /** L2 · 分享物料 */
  getShareMaterial(leader: TeamLeader) {
    const inviteCode = buildInviteCode(leader.id);
    const scene = `l=${leader.id}`;

    return {
      inviteCode,
      /** 小程序码参数（scene 承载团长 id） */
      scene,
      /** 落地路径（端上生成分享卡片用） */
      path: ShareService.LANDING_PATH,
      /** 端上可直接拼的完整参数串 */
      shareQuery: `leaderCode=${inviteCode}`,
      title: 'ABox 一盒 · 一饭四菜 ¥25.80',
      // ⚠️ 送达时刻**派生自真源**（PR-02 收口）：改前是手写 `'11:30'`，
      //    后台把「送达时间」改掉后，团长转发出去的分享语与系统实际行为**不一致**，
      //    而分享语是**离线的**（转发到微信群后无法再纠正）。
      desc: `${leader.realName} 邀请你加入${leader.floor ? ` ${leader.floor} ` : ''}拼饭群，次日上午 ${formatTimeOfDay(currentTimeline().arrival)} 送到楼下`,
      /** 海报底图：素材库上线前为 null（M5） */
      posterUrl: null as string | null,
      qrcodeUrl: null as string | null,
      mock: true,
      tips: '小程序码将在接入微信能力后生成；当前可先用「分享给朋友」转发小程序卡片',
    };
  }

  /**
   * L3 · 生成小程序码
   *
   * 接入真实微信能力前：`mock=true` + `qrcodeUrl=null`，但 **scene / path /
   * inviteCode 均已就绪** —— M5 只需把 `qrcodeUrl` 填上
   * `WxMiniProvider.getUnlimitedQRCode()` 的结果即可。
   */
  generateQrcode(leader: TeamLeader, width = 430) {
    const inviteCode = buildInviteCode(leader.id);
    const scene = `l=${leader.id}`;
    const size = Math.min(Math.max(Math.floor(width) || 430, 280), 1280);

    this.logger.log(`生成小程序码：团长#${leader.id} scene=${scene} width=${size}（mock 模式）`);

    return {
      inviteCode,
      scene,
      path: ShareService.LANDING_PATH,
      width: size,
      /** 真实图片 URL —— M5 接入后由 storage provider 返回 */
      qrcodeUrl: null as string | null,
      mock: true,
      tips: '小程序码将在接入微信能力后生成（当前为 mock 模式）',
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
