import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { UserStatus } from '../constants/user-status';
import { User } from '../../database/entities/user.entity';

/**
 * 「这个人还能不能收钱」的**唯一判定**（F-10 收口）
 *
 * ## 它修的是什么
 *
 * 全仓写钱路径此前**只判「余额账户行存在」**，从不判「这个人还收不收得了钱」：
 *   · `CommissionService.creditCommissions` —— 佣金进余额
 *   · `OrderService.autoConfirmByDate` —— 计佣（写 `pending`，次日就变成钱）
 *   · `ReversalService.refundBalancePart` —— 退款把钱退回余额
 * 而「提现」是**唯一**的出钱口且必须过 `LeaderGuard`。于是账号已注销
 * （`ab_user.status = UserStatus.CANCELED`）的用户：钱照进余额、照被计佣，
 * 却**永远提不出来** —— 钱永久悬空，且**没有任何一处报错**（"幂等"地每天继续计）。
 *
 * ## ⭐ 为什么是「一个服务一个方法」，而不是三处各写一个 if
 *
 * 与 `LeaderLookupService`（邀请码解析 · 缺陷 #92）、`LeaderMoneyService`
 * （余额真源 · #69）同一族训诫：**同一件事的第二份表述必然悄悄错掉**。
 * 「不能收钱」的判据将来一定会变（黑名单要不要拦？长期不活跃的要不要？），
 * 三处各写一个 `if` 时改一处必然漏两处 —— 而漏掉的那处恰好是**最贵的那处**（钱）。
 *
 * ## 口径：`ab_user` 行存在 且 `status !== CANCELED`
 *
 * ⚠️ **刻意只拦「已注销」一种**（本批规格如此）：
 *    · `3 已注销` —— 用户**自主发起**且个人信息已匿名化（`UserService.cancelAccount`），
 *      这笔钱既无从支付也无从联系，**必须停住**；
 *    · `2 黑名单` —— **平台处罚**，可申诉、可解除，钱仍是他的；拦掉等于平台
 *      把用户的钱扣下来却不给渠道取回（同样是悬空，只是换了一个原因），
 *      故**不并入本判定**。若日后要拦，改本方法一处即可 —— 这正是它单独成函数的意义。
 *
 * ⚠️ **fail-closed 的方向要选对**：本函数返回 `false` 时，调用方应**停下并留痕**，
 *    而不是「当作没问题继续写钱」。配套的落地方式是在 `settlePending` 里收集进
 *    `skippedReasons`（佣金行留在 `pending`，补跑可再拾起），在 `autoConfirmByDate`
 *    里则「履约照收口、钱不计」—— 事实与钱分开，是本项目的一贯纪律。
 */
@Injectable()
export class UserPayeeService {
  constructor(@InjectRepository(User) private readonly userRepo: Repository<User>) {}

  /**
   * 该用户是否为「可收款人」
   *
   * @param userId `ab_user.id`（订单 / 团长档案上的 `userId`）
   * @param manager **事务**对象；写钱的调用方几乎都在事务里，必须传，
   *                否则读到的是事务外的另一份快照（同一个容易漏的项目顽疾）。
   * @returns `true` = 行存在且状态不是已注销
   */
  async canReceiveMoney(userId: number, manager?: EntityManager): Promise<boolean> {
    const id = Number(userId);
    // id 非法（NaN / 0 / 负）一律视为不可收 —— 不给钱找一个「大概是」的收款人
    if (!Number.isInteger(id) || id <= 0) return false;

    const repo = manager ? manager.getRepository(User) : this.userRepo;
    const user = await repo.findOne({
      where: { id },
      // ⚠️ 只取判定需要的两列：一条 `ab_user` 行的 nickname/avatar 等在这次判定里
      //    没有任何用途，取回来只是给后续维护者一个「这里读了很多东西」的错觉。
      select: { id: true, status: true },
    });

    return !!user && Number(user.status) !== UserStatus.CANCELED;
  }
}
