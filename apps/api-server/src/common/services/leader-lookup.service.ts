import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LeaderStatus } from '@abox/shared-types';

import { ErrorCode } from '../constants/error-code';
import { BizException } from '../exceptions/biz.exception';
import { TeamLeader } from '../../database/entities/leader.entity';

/**
 * 邀请码形态：`LDR` + **4 位以上**序号（零填充团长 id），如 `LDR0001`。
 *
 * ⚠️ 兼容纯数字 id（`Number(code)`）——**仅供本地联调 / e2e**，
 *    生产入口只有二维码里的 `LDR…`（`share.service` 生成）。
 */
export const LEADER_CODE_RE = /^LDR(\d{4,})$/i;

/**
 * 解析邀请码 → 团长 id（**纯函数，不碰 IO**）
 *
 * @returns 团长 id；无法解析返回 `null`（**不抛错** —— 调用方对「无效」的处理不同：
 *          落地页要降级展示、下单要报 30007、登录要报 30007）
 */
export function parseLeaderCode(code: string): number | null {
  const trimmed = code.trim();

  const m = LEADER_CODE_RE.exec(trimmed);
  if (m) {
    const id = Number(m[1]);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  const asId = Number(trimmed);
  return Number.isInteger(asId) && asId > 0 ? asId : null;
}

/**
 * 团长邀请码解析（**全仓唯一实现** · 2026-09-18 缺陷 #92 收口时收敛）
 *
 * ## 为什么要收敛成一处
 * 收口 #92 时盘出「邀请码 → 团长」此前有**三份各自独立的实现**：
 *   ① `MealService.findLeaderByCode`（U3 落地页，返回 `null` 由调用方降级）
 *   ② `OrderService.resolveLeader`（下单归属，无效即抛 `30007`）
 *   ③ `LoginService`/`AuthService` —— **压根没有**（这才是 #92 本身）
 * 三份里前两份连正则都抄了同一份字面量 —— 「同一件事的第二、第三份表述」，
 * 改一处必然分叉（同族 #67 / #79 / #84）。故把**解析 + 查表 + 在职判定**收进本服务，
 * 三处调用方各自只保留「无效时怎么办」的策略差异。
 *
 * ⚠️ 本服务注册在 `CommonModule`（`@Global`），并已 `exports` —— 各业务模块**无需 import**
 *    即可注入；靠的是「本模块 exports 了这个服务」（`@Global()` 本身不传递仓储，见
 *    `common.module.ts` 头注）。
 */
@Injectable()
export class LeaderLookupService {
  constructor(@InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>) {}

  /** 邀请码 → 团长（**不看在职状态**，由调用方决定怎么处理停职者） */
  async byCode(code: string): Promise<TeamLeader | null> {
    const id = parseLeaderCode(code);
    if (id === null) return null;
    return this.leaderRepo.findOne({ where: { id } });
  }

  /**
   * 邀请码 → **在职**团长；码无效或团长已停职 → `30007 LEADER_NOT_FOUND`
   *
   * ⚠️ 停职也报「邀请码无效」而非单独错误码：对扫码的人而言，
   *    「这个码不能用」是同一件事，区分原因只会泄漏「这个团长被停职了」。
   */
  async requireActiveByCode(code: string): Promise<TeamLeader> {
    const leader = await this.byCode(code);
    if (!leader || leader.status !== LeaderStatus.ACTIVE) {
      throw new BizException(ErrorCode.LEADER_NOT_FOUND, `团长邀请码 ${code} 无效`);
    }
    return leader;
  }
}
