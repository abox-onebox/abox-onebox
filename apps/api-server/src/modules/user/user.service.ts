import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import { LeaderStatus, ORDER_TERMINAL_STATUS } from '@abox/shared-types';

import { ErrorCode } from '../../common/constants/error-code';
import { CANCELED_NICKNAME, UserStatus } from '../../common/constants/user-status';
import { BizException } from '../../common/exceptions/biz.exception';
import { LeaderMoneyService } from '../../common/services/leader-money.service';
import { TeamLeader } from '../../database/entities/leader.entity';
import { Order } from '../../database/entities/order.entity';
import { User } from '../../database/entities/user.entity';
import { ACCOUNT_CANCEL_CONFIRM_TEXT, UserCancelDto } from './dto/user-cancel.dto';

/** 闸门原因 → 中文（端上不再自造第二份文案；`data.reasons` 给出机器可读的键） */
const REASON_TEXT: Record<string, string> = {
  leader: '你仍是团长身份，请先在「我的 → 团长资料」退出团长',
  balance: '账户余额（或冻结额）不为 0，请先提现或使用完',
  orders: '有未完成的订单，请等订单完成或取消后再来',
};

/**
 * U19 · 账号注销（M5-20）· 个人中心自助注销
 *
 * ## 为什么非做不可
 *
 * 「提供账号注销入口」是**微信小程序提审的硬条件**（《提审自检清单 v1.2》第 10 条
 * 「缺失不通过」；合规侧同条），而本仓库长期只有 **协议页里的一个客服引导**。
 * 它与 U16 协议阅读页（M5-18）是**同一对提审阻塞项**：协议页已收口，本项此前一直
 * 「已在册、未排期」（M6 `K53`）。本批把它落成**端上自助 + 服务端留痕**的闭环。
 *
 * ## ⭐ 语义：注销 = 置 `status=3` + 匿名化，**不是**物理删除
 *
 * | 动作 | 为什么这样做 |
 * |------|--------------|
 * | `status = 3` | 同一微信号再登录 → 20014（`ACCOUNT_CANCELED`），**不给新会话** |
 * | `deleted_at = now` | 与 `status` 构成双证据；后台/排查按同一字段筛 |
 * | 昵称 / 头像 / 手机号(含 hash) / 办公楼 / 所属团长 / 订阅标记 → 清空 | 合规含义是「删除**或**匿名化」；昵称会出现在历史订单与后台列表上 |
 * | `openid` / `unionid` **保留** | 唯一索引在 `openid` 上，清了就没法**拦住再登录**；二者本身不是展示字段 |
 *
 * ⚠️ **刻意不做物理删除**：订单、退款、佣金是**钱**的凭证，删了会让财务对不上。
 *    一期如实告知用户「与订单/资金相关的记录按法律法规要求保留」。
 *
 * ## ⚠️ 三道闸门（fail-closed）—— 都指向同一件事：**注销不能让人损失钱**
 *
 * | 键 | 判据 | 端上要说的 |
 * |----|------|-----------|
 * | `leader` | 该用户是**在职团长**（`ab_team_leader.status = 1`） | 先「退出团长身份」再注销（退出本身已有资金闸门 20008） |
 * | `balance` | `ab_balance` 可用额 **或** 冻结额 > 0 | 先把余额提现 / 用掉（一期无自动退款到微信通道） |
 * | `orders` | 存在**非终态**订单（`ORDER_TERMINAL_STATUS` 之外） | 等这些订单完成或取消后再来 |
 *
 * ⭐ **为什么不做「自动清零余额后注销」**：一期余额出款走灵活用工人工通道
 *    （见自营结算口径），系统**没有**把余额退给用户的能力。自动清零 =
 *    用户的钱被系统吞掉，而且**不会有任何报错**。宁可让他看到一次失败。
 *
 * ## ⚠️ 已知残留（如实登记，不掩盖）
 *
 * JWT 无状态（`auth.service` A4 头注已写明「服务端不吊销任何东西」），
 * 故**注销前已签发的旧 token 在有效期内仍可调用接口** —— 与 `SC-U-28` 记录的
 * 「拉黑用户旧 token 仍可下单」是**同一个形状**。登录侧已拦死（拿不到新 token），
 * 端上注销成功即清本地登录态。彻底解法（令牌黑名单 / 具名会话）一期不值当，
 * 已登记进《已知项与预期行为清单》。
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger('UserService');

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    /** 复用全局余额真源（`ab_balance` 只此一处读）—— 不自己 `SUM` 一次（#69 的形状） */
    private readonly leaderMoney: LeaderMoneyService,
  ) {}

  /**
   * 注销当前登录账号
   *
   * @param userId 当前登录身份（`JwtPayload.sub`）
   * @returns 注销时刻 + 被匿名化的字段清单（供端上如实展示「清掉了什么」）
   */
  async cancelAccount(userId: number, dto: UserCancelDto) {
    // ① 确认词（服务端唯一判据；端上那份只是提示文案）
    if ((dto.confirmText ?? '').trim() !== ACCOUNT_CANCEL_CONFIRM_TEXT) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `请逐字输入「${ACCOUNT_CANCEL_CONFIRM_TEXT}」以确认注销`,
        undefined,
        { expect: ACCOUNT_CANCEL_CONFIRM_TEXT },
      );
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BizException(ErrorCode.USER_NOT_FOUND);

    // ② 已注销 ⇒ 明确告知，不做静默幂等
    //    （与 20013 / 40013 同哲学：对已处于目标态的重复操作是**错误**，不是成功 ——
    //      否则用户会以为「刚刚才注销成功」，而其实他早就注销过了）
    if (user.status === UserStatus.CANCELED) {
      throw new BizException(ErrorCode.ACCOUNT_CANCELED);
    }

    // ③ 三道闸门（全查一遍再报，让用户一次看到全部原因 —— 逐条报会让他改一轮报一轮）
    const reasons: string[] = [];

    const leader = await this.leaderRepo.findOne({ where: { userId } });
    if (leader && leader.status === LeaderStatus.ACTIVE) reasons.push('leader');

    const account = await this.leaderMoney.accountOf(userId);
    if (account.balanceFen > 0 || account.frozenFen > 0) reasons.push('balance');

    const pendingOrders = await this.orderRepo.count({
      where: { userId, status: Not(In(ORDER_TERMINAL_STATUS)) },
    });
    if (pendingOrders > 0) reasons.push('orders');

    if (reasons.length > 0) {
      throw new BizException(
        ErrorCode.ACCOUNT_CANCEL_BLOCKED,
        `暂不能注销：${reasons.map((r) => REASON_TEXT[r] ?? r).join('；')}`,
        undefined,
        { reasons, pendingOrders },
      );
    }

    // ④ 落库：状态 + 软删时间 + 匿名化（一次 UPDATE，避免「改了状态没清信息」的半截态）
    //
    // ⚠️ **原子占位，不做「读-再写」**（M5-19 的 U11 同纪律）：
    //    上面第 ② 步的「查库判 status」只是**快路径**（错误码更准），不构成并发防护 ——
    //    两个请求同时读到 `status = 1` 时会**双双注销成功**，第二个人拿到的是一份
    //    「刚注销成功」的回执，而他其实早已注销（假回执）。
    //    故 `WHERE status != CANCELED` 进 WHERE 子句，以 `affected = 0` 判归属并**归因到 20014**。
    const canceledAt = new Date();
    const result = await this.userRepo.update(
      { id: userId, status: Not(UserStatus.CANCELED) },
      {
        status: UserStatus.CANCELED,
        deletedAt: canceledAt,
        nickname: CANCELED_NICKNAME,
        avatarUrl: null,
        phone: null,
        phoneHash: null,
        buildingId: null,
        teamLeaderId: null,
        subscribeFlag: null,
      },
    );

    // affected = 0 ⇒ 这一轮被另一个并发请求抢先注销了（或用户已被后台注销）
    if (!result.affected) {
      throw new BizException(ErrorCode.ACCOUNT_CANCELED);
    }

    this.logger.log(
      `账号注销 user=${userId}（原因：${dto.reason?.trim() || '未填写'}）· 已匿名化个人资料`,
    );

    return {
      canceledAt: canceledAt.toISOString(),
      status: UserStatus.CANCELED,
      /** 被清空的字段（端上如实展示，不写第二份文案） */
      clearedFields: [
        'nickname',
        'avatarUrl',
        'phone',
        'phoneHash',
        'buildingId',
        'teamLeaderId',
        'subscribeFlag',
      ],
      /**
       * 口径说明由**服务端下发**（端上不复制一份文案）
       *
       * ⚠️ 必须写清「订单与资金记录依法保留」—— 否则用户会以为数据全没了，
       *    而客服在后台仍能看到他的历史订单，两边说法不一致就是**虚假告知**。
       */
      note: '账号已注销：同一微信号将无法再登录本小程序，个人资料已匿名化。与订单、退款、佣金相关的记录按法律法规要求保留。如需恢复，请联系客服。',
    };
  }
}
