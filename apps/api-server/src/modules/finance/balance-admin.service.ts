import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { ErrorCode } from '../../common/constants/error-code';
import { BizException } from '../../common/exceptions/biz.exception';
import { maskPhone } from '../../common/utils/crypto';
import { money, toFen, toYuan } from '../../common/utils/money';
import { genAdjustNo } from '../../common/utils/order-no';
import { normalizePage, paginate } from '../../common/utils/response';
import { Balance, BalanceLog } from '../../database/entities/finance.entity';
import { TeamLeader } from '../../database/entities/leader.entity';
import { User } from '../../database/entities/user.entity';
import { BALANCE_LOG_TYPE_LABEL, levelLabel } from './commission.service';
import { AdminAdjustBalanceDto, AdminBalancesQueryDto } from './dto/finance.dto';
import { FINANCE_READ_ROLES, FUND_ACTION_ROLES } from './finance.constants';
import { FinanceService } from './finance.service';

/**
 * 后台 · 余额账户管理与调整（《接口规范 v1.0》§6.5 · **D38 / D39** · 原型 P34 · 模块 M35-04）
 *
 * ## 余额的唯一真源
 * `ab_balance`（`user_id` 维度**快照**：可用 / 冻结 / 累计进出）+
 * `ab_balance_log`（**发生额账本**：每笔一条，含 `balance_after` 逐步落痕）。
 * 两者**同源**：每次写入都在同一事务内同时落两边，故「余额」与「流水末条
 * `balance_after`」必须相等（其他读端 L11 / L19 也按此验算）。
 *
 * ⚠️ **用户与团长共用同一小程序身份**，故 `ab_balance.user_id` 指 `ab_user.id`，
 *    **不区分**「用户余额」与「团长佣金余额」—— 它们本来就是同一个池子
 *    （团长佣金入账 `creditCommissions` 写的就是这张表）。
 *
 * ## 本文件的两条核心纪律
 * 1. ⭐ **负债合计不自己算**：`summary.liability` 直接调 `FinanceService.loadLiability()`
 *    —— 与 D33 资金总览**同一个函数**。两页各写一套 `SUM(ab_balance)` 必然漂移，
 *    而且没有任何报错（e2e 用「D38 汇总 === D33 liability」钉死）。
 * 2. ⭐ **负债是时点量、不随筛选变化**：「平台还欠用户多少钱」不该因为运营在搜索框
 *    里敲了个昵称就变小。列表的 `total`（本次筛选命中数）与它**刻意分开**。
 *
 * ## D39 的四条不变量（每条都有 e2e 断言）
 * 1. **余额不为负**：扣减 / 冻结超出可用额 → `40002`；解冻超出冻结额 → `40015`（fail-closed）
 * 2. **`total_in` / `total_out` 只在充值 / 扣减变动**：冻结与解冻**都不动** ——
 *    钱没进出平台，只是从「可用」挪到「冻结」（与 L12 提现「申请阶段不计入累计支出」同口径）
 * 3. **乐观锁**：`UPDATE ... WHERE id=? AND version=?`，并发调账不丢更新
 * 4. **必带幂等键**：调账没有业务单号可供判重，重复提交就是重复加钱（同 L12 提现）
 */
@Injectable()
export class BalanceAdminService {
  private readonly logger = new Logger(BalanceAdminService.name);

  constructor(
    @InjectRepository(Balance) private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(BalanceLog) private readonly logRepo: Repository<BalanceLog>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(TeamLeader) private readonly leaderRepo: Repository<TeamLeader>,
    private readonly finance: FinanceService,
    private readonly dataSource: DataSource,
  ) {}

  // ------------------------------------------------------------------ D38 列表

  /**
   * 余额账户列表（跨用户）
   *
   * `userId` 精确查询时**包含「无账户」的空视图**（`hasAccount=false`，余额全 0）：
   * 否则运营搜不到人 → 以为查无此用户 → 不敢充值，而 D39 恰恰支持给无账户用户首充建户。
   * 列表模式（无 `userId`）则只列**有账户**的行 —— `ab_balance` 只在发生过资金往来后建行，
   * 把所有 `ab_user` 都拉出来铺满页面对运营毫无信息量。
   *
   * ⚠️ `viewerRole` 用于下发 `actions.canAdjust` —— 端上据此决定「调账」按钮是否可点。
   *    **判定权威仍在服务端**（`@Roles`），`actions` 只是让端上不必猜；
   *    两者共用 `BALANCE_ADJUST_ROLES` 常量，不可能漂移。
   */
  async list(q: AdminBalancesQueryDto, viewerRole: string): Promise<BalanceAccountListView> {
    const { page, pageSize, skip } = normalizePage(q);
    const actions: BalanceActions = {
      canAdjust: (BALANCE_ADJUST_ROLES as readonly string[]).includes(viewerRole),
    };

    // ⭐ 负债合计：**全量 · 时点量**，与 D33 同一实现 —— 不随下方任何筛选变化
    const liability = await this.finance.loadLiability();
    const leaderAccountCount = await this.balanceRepo
      .createQueryBuilder('b')
      .where('b.user_id IN (SELECT l.user_id FROM ab_team_leader l)')
      .getCount();
    const liabilityView: BalanceLiability = {
      asOf: liability.asOf,
      balanceFen: liability.balanceFen,
      frozenFen: liability.frozenFen,
      netFen: liability.balanceFen + liability.frozenFen,
      accountCount: liability.accountCount,
      leaderAccountCount,
    };

    // ① 精确查单用户（允许无账户）
    if (q.userId) {
      const user = await this.userRepo.findOne({ where: { id: q.userId } });
      if (!user) {
        throw new BizException(
          ErrorCode.NOT_FOUND,
          `用户 #${q.userId} 不存在（余额只能挂在真实用户上）`,
        );
      }
      const account = await this.balanceRepo.findOne({ where: { userId: q.userId } });
      const rows = await this.rowsOf(
        [q.userId],
        new Map(account ? [[Number(account.userId), account]] : []),
      );
      return {
        ...paginate(rows, rows.length, 1, Math.max(rows.length, 1)),
        view: 'single',
        liability: liabilityView,
        accountTypeOptions: BALANCE_ACCOUNT_TYPE_OPTIONS,
        actions,
        logs: await this.recentLogs(q.userId),
      };
    }

    // ② 列表
    //
    // ⚠️ 一律用 **SQL 子查询**而不是 `In([...ids])`：前置条件（团长 / 关键词）的候选
    //    用户集合可能上千，而 SQLite 默认绑定变量上限 999 —— 拼大 `IN` 列表会
    //    「本地绿、换 MySQL 才炸」（M3-9 已踩过一次）。子查询没有这个上限。
    const qb = this.balanceRepo.createQueryBuilder('b');
    if (q.accountType === 'leader') {
      qb.andWhere('b.user_id IN (SELECT l.user_id FROM ab_team_leader l)');
    } else if (q.accountType === 'user') {
      qb.andWhere('b.user_id NOT IN (SELECT l.user_id FROM ab_team_leader l)');
    }
    if (q.keyword) {
      qb.andWhere(
        'b.user_id IN (SELECT u.id FROM ab_user u WHERE u.nickname LIKE :kw OR u.phone LIKE :kw)',
        { kw: `%${q.keyword}%` },
      );
    }

    const [accounts, total] = await qb
      .clone()
      // 余额降序：运营点进来最想先看「谁的余额大得异常」
      .orderBy('b.balance', 'DESC')
      .addOrderBy('b.id', 'ASC')
      .skip(skip)
      .take(pageSize)
      .getManyAndCount();

    const rows = await this.rowsOf(
      accounts.map((a) => Number(a.userId)),
      new Map(accounts.map((a) => [Number(a.userId), a])),
    );

    return {
      ...paginate(rows, total, page, pageSize),
      view: 'list',
      liability: liabilityView,
      accountTypeOptions: BALANCE_ACCOUNT_TYPE_OPTIONS,
      actions,
      /** 列表模式不带流水（一页 20 个账户 × 20 条流水 = 400 行，且运营此时还没选定看谁） */
      logs: [] as BalanceLogRow[],
    };
  }

  // ------------------------------------------------------------------ D39 调整

  /**
   * 余额调整（充值 / 扣减 / 冻结 / 解冻）—— **资金动作**
   *
   * 整段在**单事务**内完成：余额快照更新（乐观锁）+ 流水落痕，二者要么都成功
   * 要么都不发生。**只有「充值」能自动建户**：其余三个动作都以「已有余额」为前提，
   * 无账户时给出明确原因（而不是先建一个 0 余额的账户再报「余额不足」）。
   */
  async adjust(
    dto: AdminAdjustBalanceDto,
    operatorId: number,
    operatorName: string,
  ): Promise<BalanceAdjustView> {
    const actionLabel = BALANCE_ADJUST_ACTION_LABEL[dto.action] ?? dto.action;

    const user = await this.userRepo.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BizException(
        ErrorCode.NOT_FOUND,
        `用户 #${dto.userId} 不存在（余额只能挂在真实用户上）`,
      );
    }

    const adjustNo = genAdjustNo();

    const settled = await this.dataSource.transaction(async (m) => {
      let account = await m.findOne(Balance, { where: { userId: dto.userId } });

      if (!account) {
        // ⭐ 首充建户：只有充值能在「无账户」时进行 —— 「给从没下过单的用户发补偿」
        //    正是 D39 的用途，若因无账户而失败，运营会卡死在这里。
        if (dto.action !== 'recharge') {
          throw new BizException(
            dto.action === 'unfreeze'
              ? ErrorCode.BALANCE_FROZEN_NOT_ENOUGH
              : ErrorCode.BALANCE_NOT_ENOUGH,
            `用户 #${dto.userId} 尚无余额账户（从未发生资金往来），没有可${actionLabel}的金额`,
            undefined,
            { userId: dto.userId, hasAccount: false, availableFen: 0, frozenFen: 0 },
          );
        }
        account = await m.save(
          m.create(Balance, {
            userId: dto.userId,
            balance: '0.00',
            frozen: '0.00',
            totalIn: '0.00',
            totalOut: '0.00',
            version: 0,
          }),
        );
        this.logger.log(`用户#${dto.userId} 首次建余额账户（操作人 ${operatorName}）`);
      }

      /**
       * ⚠️ 全程用**整数分**做加减，最后一步才转元落库。
       *    用 `round2(a - b)` 做中间步骤会在多次调整后累积残差
       *    （0.1 + 0.2 类问题），而整数分运算没有这个风险。
       */
      const balanceFen = toFen(Number(account.balance));
      const frozenFen = toFen(Number(account.frozen));

      let nextBalanceFen = balanceFen;
      let nextFrozenFen = frozenFen;
      let nextTotalInFen = toFen(Number(account.totalIn));
      let nextTotalOutFen = toFen(Number(account.totalOut));
      let direction: number;

      switch (dto.action) {
        case 'recharge':
          nextBalanceFen = balanceFen + dto.amountFen;
          nextTotalInFen = nextTotalInFen + dto.amountFen;
          direction = 1;
          break;

        case 'deduct':
          if (balanceFen < dto.amountFen) {
            throw new BizException(
              ErrorCode.BALANCE_NOT_ENOUGH,
              `可用余额 ¥${toYuan(balanceFen).toFixed(2)} 不足以扣减 ¥${toYuan(dto.amountFen).toFixed(2)}`,
              undefined,
              { userId: dto.userId, availableFen: balanceFen, frozenFen, hasAccount: true },
            );
          }
          nextBalanceFen = balanceFen - dto.amountFen;
          nextTotalOutFen = nextTotalOutFen + dto.amountFen;
          direction = -1;
          break;

        case 'freeze':
          if (balanceFen < dto.amountFen) {
            throw new BizException(
              ErrorCode.BALANCE_NOT_ENOUGH,
              `可用余额 ¥${toYuan(balanceFen).toFixed(2)} 不足以冻结 ¥${toYuan(dto.amountFen).toFixed(2)}`,
              undefined,
              { userId: dto.userId, availableFen: balanceFen, frozenFen, hasAccount: true },
            );
          }
          nextBalanceFen = balanceFen - dto.amountFen;
          nextFrozenFen = frozenFen + dto.amountFen;
          direction = -1;
          /**
           * ⭐ 冻结**不动** `total_in` / `total_out`：钱没进出平台，只是从「可用」
           *    挪到「冻结」。若把冻结记成支出，`total_out` 会随冻结 / 解冻来回跳，
           *    并与提现累计互相污染（L12 也刻意「申请阶段不计入累计支出」）。
           */
          break;

        case 'unfreeze':
          if (frozenFen < dto.amountFen) {
            throw new BizException(
              ErrorCode.BALANCE_FROZEN_NOT_ENOUGH,
              `冻结余额 ¥${toYuan(frozenFen).toFixed(2)} 不足以解冻 ¥${toYuan(dto.amountFen).toFixed(2)}`,
              undefined,
              { userId: dto.userId, availableFen: balanceFen, frozenFen, hasAccount: true },
            );
          }
          nextBalanceFen = balanceFen + dto.amountFen;
          nextFrozenFen = frozenFen - dto.amountFen;
          direction = 1;
          break;

        default:
          /**
           * 兜底 fail-closed（**不是**为了满足 TS 的「必赋值」检查）。
           *
           * DTO 的 `@IsIn` 已挡住未知 action，但**内部调用**（将来别的服务直接调
           * `adjust()`）不经过 DTO 校验。若让它静默走完 switch：`nextXxx` 全等于原值
           * → UPDATE 把相同值写回（version 还 +1）→ 流水里多出一条「金额有、余额没变」
           * 的记录。余额看起来是对的，只有账本对不上 —— 最难查的一类脏数据。
           */
          throw new BizException(
            ErrorCode.PARAM_INVALID,
            `未知的调整动作「${dto.action}」（仅支持 recharge / deduct / freeze / unfreeze）`,
            undefined,
            { field: 'action' },
          );
      }

      // ⚠️ 前置挡溢出：`ab_balance` 四列都是 DECIMAL(12,2)（上限 9,999,999,999.99 元）。
      //    不挡就会由 DB 抛出驱动相关的底层错误（本地 SQLite 宽松、MySQL 报 Out of range），
      //    而且**同一事务里的流水还没写**，运维拿到的报错无法定位是哪一步。
      if (
        nextBalanceFen > BALANCE_MAX_FEN ||
        nextFrozenFen > BALANCE_MAX_FEN ||
        nextTotalInFen > BALANCE_MAX_FEN ||
        nextTotalOutFen > BALANCE_MAX_FEN
      ) {
        throw new BizException(
          ErrorCode.PARAM_INVALID,
          `调整后金额超出系统上限（¥${toYuan(BALANCE_MAX_FEN).toLocaleString('en-US')}）`,
          undefined,
          { userId: dto.userId, field: 'amountFen' },
        );
      }

      // 乐观锁：`ab_balance.version` 防并发调账丢更新（与 L12 提现同一处理）
      const upd = await m
        .createQueryBuilder()
        .update(Balance)
        .set({
          balance: money(toYuan(nextBalanceFen)),
          frozen: money(toYuan(nextFrozenFen)),
          totalIn: money(toYuan(nextTotalInFen)),
          totalOut: money(toYuan(nextTotalOutFen)),
          version: () => 'version + 1',
        })
        .where('id = :id AND version = :v', { id: account.id, v: account.version })
        .execute();
      if (!upd.affected) {
        throw new BizException(
          ErrorCode.PARAM_INVALID,
          '该账户余额刚被其他操作改动，请刷新后重试',
          undefined,
          { userId: dto.userId, field: 'userId' },
        );
      }

      /**
       * 流水落痕（**账本**）。
       *
       * `remark` 里带上操作人：`@OperationLog` 记的是「谁调了这个接口」，
       * 而这条流水会被团长 / 用户在自己的余额明细里看到 —— 让「谁动过我的钱」
       * 在一处可查，不必再让运营去翻后台操作日志。
       */
      const log = await m.save(
        m.create(BalanceLog, {
          userId: dto.userId,
          type: BALANCE_LOG_TYPE_ADJUST,
          direction,
          amount: money(toYuan(dto.amountFen)),
          balanceAfter: money(toYuan(nextBalanceFen)),
          relatedId: adjustNo,
          remark: `【管理端${actionLabel}】${dto.reason}（操作人 ${operatorName}）`.slice(0, 256),
        }),
      );

      return {
        logId: Number(log.id),
        balanceBeforeFen: balanceFen,
        frozenBeforeFen: frozenFen,
        balanceFen: nextBalanceFen,
        frozenFen: nextFrozenFen,
        netFen: nextBalanceFen + nextFrozenFen,
        totalInFen: nextTotalInFen,
        totalOutFen: nextTotalOutFen,
      };
    });

    const leader = await this.leaderRepo.findOne({ where: { userId: dto.userId } });

    return {
      adjustNo,
      action: dto.action,
      actionText: actionLabel,
      userId: dto.userId,
      nickname: user.nickname ?? null,
      isLeader: !!leader,
      amountFen: dto.amountFen,
      ...settled,
      reason: dto.reason,
      operatorId,
      operatorName,
    };
  }

  // -------------------------------------------------------------------- 内部

  /**
   * 单账户最近流水（精确查 `userId` 时附带）
   *
   * ⚠️ 为什么必须有：D39 写完流水若没有读的地方，运营调完账就**无法回答**
   *    「他这 ¥150 是哪来的」—— 只能去翻后台操作日志（那是「谁调了接口」，
   *    不是「钱怎么动的」）。余额账户管理页的核心动作就是「看着余额查来源」，
   *    故随详情一起下发。超过 20 条的历史请走团长端 L19（分页 + 类型过滤）。
   */
  private async recentLogs(userId: number): Promise<BalanceLogRow[]> {
    const rows = await this.logRepo.find({
      where: { userId },
      order: { id: 'DESC' },
      take: 20,
    });
    return rows.map((r) => ({
      id: Number(r.id),
      type: r.type,
      /** 中文文案由服务端给（与 L19 同一张表，端上不自造） */
      typeText: BALANCE_LOG_TYPE_LABEL[r.type] ?? r.type,
      direction: Number(r.direction),
      amountFen: toFen(Number(r.amount)),
      balanceAfterFen: toFen(Number(r.balanceAfter)),
      relatedId: r.relatedId ?? null,
      remark: r.remark ?? null,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  /** 批量装饰账户行（`userIds` 可含「无账户」用户 —— 此时余额全 0 且 `hasAccount=false`） */
  private async rowsOf(
    userIds: number[],
    accountByUser: Map<number, Balance>,
  ): Promise<BalanceAccountRow[]> {
    if (!userIds.length) return [];

    // 当前页规模（≤100），`In` 列表安全 —— 与列表查询里刻意用子查询的场景不同
    const [users, leaders] = await Promise.all([
      this.userRepo.find({ where: { id: In(userIds) } }),
      this.leaderRepo.find({ where: { userId: In(userIds) } }),
    ]);
    const userById = new Map(users.map((u) => [Number(u.id), u]));
    const leaderByUser = new Map(leaders.map((l) => [Number(l.userId), l]));

    return userIds.map((uid) => {
      const u = userById.get(uid);
      const l = leaderByUser.get(uid);
      const a = accountByUser.get(uid);
      const balanceFen = toFen(Number(a?.balance ?? 0));
      const frozenFen = toFen(Number(a?.frozen ?? 0));
      return {
        userId: uid,
        nickname: u?.nickname ?? null,
        avatarUrl: u?.avatarUrl ?? null,
        /** 手机号**一律脱敏**（同 M3-6 纪律：列表脱敏、详情才回真值） */
        phoneMasked: maskPhone(u?.phone),
        isLeader: !!l,
        leaderId: l ? Number(l.id) : null,
        leaderLevel: l?.level ?? null,
        leaderLevelText: l ? levelLabel(l.level) : null,
        leaderStatus: l ? Number(l.status) : null,
        leaderStatusText: l ? (Number(l.status) === 1 ? '在职' : '停职') : null,
        balanceFen,
        frozenFen,
        netFen: balanceFen + frozenFen,
        totalInFen: toFen(Number(a?.totalIn ?? 0)),
        totalOutFen: toFen(Number(a?.totalOut ?? 0)),
        hasAccount: !!a,
        updatedAt: a?.updatedAt ? new Date(a.updatedAt).toISOString() : null,
      };
    });
  }
}

// ==================================================================== 出参与常量

/**
 * 可**查看**财务域的角色（类级白名单）
 *
 * 含 `operator`：运营要能看资金总览、佣金明细与余额账户，跟进「为什么佣金没结」
 * 「这个用户余额为什么是负的」。`viewer` 刻意不含 —— 它的菜单只有 4 个看板页。
 *
 * ⚠️ 定义已上移到 `finance.constants.ts`（域级概念，不属于本 service）；此处保留
 *    同名导出以免改动散落在各控制器与文档里的既有引用。**不要再写第二份。**
 */
export const FINANCE_VIEW_ROLES = FINANCE_READ_ROLES;

/**
 * 可**调账**的角色（D39 方法级白名单）
 *
 * ⭐ **单一真相**：`FinanceAdminController` 的 `@Roles(...BALANCE_ADJUST_ROLES)`
 *    与出参 `actions.canAdjust` **共用本常量**。
 *
 * ⚠️ 为什么要共用：这两处一旦各写一份，就会漂移成「按钮亮着、点了 `10003`」
 *    或「按钮灰着、其实有权限」。项目里既有写法（如 `leader-admin.service.ts` 的
 *    `canManage`）是两处硬编码 + 注释对齐 —— 本批改为常量，从结构上消除这个风险。
 *
 * ⚠️ M4-4：真正的定义已收敛到 `finance.constants.ts` 的 `FUND_ACTION_ROLES`
 *    （D35 / D39 / D41 / D42 / D46 系列**共用同一个「资金动作」概念**，
 *    此前四处各写一份字面量）。此处保留别名，语义更贴 D39 的场景。
 */
export const BALANCE_ADJUST_ROLES = FUND_ACTION_ROLES;

/** D39 动作 → 中文文案（服务端唯一来源，端上不自造） */
export const BALANCE_ADJUST_ACTION_LABEL: Record<string, string> = {
  recharge: '充值',
  deduct: '扣减',
  freeze: '冻结',
  unfreeze: '解冻',
};

/**
 * `ab_balance_log.type` 新值：**管理员手工调整**（M3-14 登记为扩展值）
 *
 * ⚠️ 与原五值（`commission` / `order_pay` / `withdraw` / `withdraw_refund` / `refund`）
 *    刻意分开：调账既不是佣金也不是消费，混进去会让「佣金支出」类汇总口径被污染。
 *    新值已回写《接口规范》§九扩展登记与 `BALANCE_LOG_TYPE_LABEL`。
 */
export const BALANCE_LOG_TYPE_ADJUST = 'adjust';

/** `ab_balance` 四列均为 DECIMAL(12,2) → 上限 9,999,999,999.99 元 */
const BALANCE_MAX_FEN = 999_999_999_999;

const BALANCE_ACCOUNT_TYPE_OPTIONS = [
  { value: 'all', label: '全部账户' },
  { value: 'leader', label: '仅团长' },
  { value: 'user', label: '仅普通用户' },
];

/** D38 单行 */
export interface BalanceAccountRow {
  userId: number;
  nickname: string | null;
  avatarUrl: string | null;
  /** 手机号（**列表一律脱敏**） */
  phoneMasked: string | null;
  /** 是否持有团长档案 */
  isLeader: boolean;
  leaderId: number | null;
  leaderLevel: string | null;
  leaderLevelText: string | null;
  /** 团长状态（1 在职 / 2 停职）；非团长为 null */
  leaderStatus: number | null;
  leaderStatusText: string | null;
  balanceFen: number;
  frozenFen: number;
  /** 可用 + 冻结（该用户欠着的全部） */
  netFen: number;
  totalInFen: number;
  totalOutFen: number;
  /** `false` = `ab_balance` 无该用户行（余额全 0，从未发生资金往来） */
  hasAccount: boolean;
  updatedAt: string | null;
}

/** 平台负债（**全量 · 时点量** · 与 D33 `liability` 同源同值） */
export interface BalanceLiability {
  asOf: string;
  balanceFen: number;
  frozenFen: number;
  netFen: number;
  accountCount: number;
  leaderAccountCount: number;
}

/** D38 单条余额流水（仅精确查单用户时下发最近 20 条） */
export interface BalanceLogRow {
  id: number;
  type: string;
  typeText: string;
  /** 1 收入 / -1 支出（指**可用余额**的变化方向） */
  direction: number;
  amountFen: number;
  balanceAfterFen: number;
  relatedId: string | null;
  remark: string | null;
  createdAt: string;
}

/** 端上可用动作（**判定权威在服务端 `@Roles`**，此处只让端上不必猜） */
export interface BalanceActions {
  /** 是否可调账（D39 白名单：`BALANCE_ADJUST_ROLES`）—— 决定「调账」按钮是否可点 */
  canAdjust: boolean;
}

/** D38 出参 */
export interface BalanceAccountListView {
  /** ⭐ 全量负债：**不随筛选变化**（`total` 才是本次筛选命中数） */
  liability: BalanceLiability;
  /** `single` = 按 `userId` 精确查（可能含 `hasAccount=false` 的空视图）；`list` = 分页列表 */
  view: 'list' | 'single';
  accountTypeOptions: { value: string; label: string }[];
  actions: BalanceActions;
  list: BalanceAccountRow[];
  /** 仅 `view='single'`：该用户最近 20 条流水（列表模式为空数组） */
  logs: BalanceLogRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/** D39 出参 */
export interface BalanceAdjustView {
  /** 调整单号（`AJ…`，写入 `ab_balance_log.related_id`，作为追溯锚点） */
  adjustNo: string;
  action: string;
  actionText: string;
  userId: number;
  nickname: string | null;
  isLeader: boolean;
  amountFen: number;
  balanceBeforeFen: number;
  frozenBeforeFen: number;
  /** 调整后 */
  balanceFen: number;
  frozenFen: number;
  netFen: number;
  totalInFen: number;
  totalOutFen: number;
  reason: string;
  operatorId: number;
  operatorName: string;
  /** 落库的余额流水 id（运营可据此在 L19 侧核对同一笔） */
  logId: number;
}
