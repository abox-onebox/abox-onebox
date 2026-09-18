import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, JwtPayload } from '../../common/decorators/auth.decorator';
import { BizConfigService } from '../../common/services/biz-config.service';
import { LeaderMoneyService } from '../../common/services/leader-money.service';
import { UserBalanceLogQueryDto } from './dto/user-balance.dto';

/**
 * 个人中心（`/me/*`）· 《接口规范》§3.5
 *
 * ## M2 落 U17；M5-10 补 U13 / U14
 *
 * 规范 §3.5 里 **U12–U16 早已登记**，但实现长期只落了 U17 ——
 * 于是原型 P8「个人中心」的账户余额与 P9「账户余额明细」两页
 * **有版式、有契约、没有后端**（`apps/miniprogram` 里是脚手架占位页）。
 * 本批补齐读侧两支：
 *
 * | 端点 | 契约 | 页面 |
 * |------|------|------|
 * | `GET /me/balance` | U13 可用余额（**单位分**） | P8 个人中心 · P9 顶部大卡 |
 * | `GET /me/balance/logs` | U14 余额明细（M04-03） | P9 流水列表 |
 *
 * ## ⭐ 复用 `LeaderMoneyService`，不自己查 `ab_balance`
 *
 * `ab_balance` / `ab_balance_log` 的维度从来是 **`user_id`**：用户与团长
 * **共用同一小程序身份**，佣金入账与下单抵扣走**同一条余额链路**。
 * 故这里直接用全局的 `LeaderMoneyService`（与 A1 登录、A2 资料、L11、D38
 * 后台余额页**同一个真源**）—— 若此处再 `SUM(ab_balance)` 一次，就会出现
 * 「个人中心与余额明细显示两个余额」的分叉，且**两边都不报错**
 * （M4-4 修掉的 #69 就是这个形状，不要重开）。
 *
 * ## ⚠️ U12 不在这里实现（**刻意的，不是漏了**）
 *
 * 规范 U12 = `GET /me`「用户信息（含所属团长、办公楼）」。仓内已有
 * **A2 `GET /auth/me`**（`AuthService.profile()`）返回同一份数据
 * （该端点自己的注释写着「小程序端便捷别名」）。再建一个 `/me` 就是
 * **两个端点、一份数据**，而 P8 需要的「办公楼名 / 团长名」两个派生字段
 * 已在 A2 出参上补齐（M5-10）。结论：**U12 由 A2 承担**，不另设端点。
 *
 * ## ⚠️ 币种口径：一律**整数分**
 *
 * `ab_balance.balance` 是 `DECIMAL(12,2)`（元）。跨 mysql/sqlite 驱动时
 * TypeORM 取回可能是 string / number，浮点比较会出现
 * `25.80 vs 25.800000000000004` 这类问题，故对外**只给分**，
 * 端上用 `fenToYuanText()` 渲染（与 L11 / D38 一致）。
 */
@ApiTags('个人中心')
@ApiBearerAuth()
@Controller('me')
export class UserController {
  constructor(
    private readonly bizConfig: BizConfigService,
    private readonly leaderMoney: LeaderMoneyService,
  ) {}

  @Get('support')
  @ApiOperation({
    summary: 'U17 客服入口配置（一期：客服微信号 + 服务时间，人工处理）',
  })
  support() {
    return this.bizConfig.supportContact();
  }

  /**
   * U13 · 可用余额（单位分）
   *
   * ⚠️ **普通用户也有这个账户**，不要求团长身份 —— 订单退款会退回余额
   *    （下单时可直接抵扣），故「非团长调用本接口」是完全正常的。
   *    这与 `/leader/*` 全族挂 `LeaderGuard` 是**两件事**，勿顺手照抄。
   *
   * ⭐ 无账户（从未发生资金往来）时**返回 0 而不是报错**，并带
   *    `hasBalanceAccount=false`，让端上能区分「确实是 0」与「还没开过户」
   *    （同 D38 的「无账户空视图」口径）。
   *
   * ⚠️ 字段名与 A2 `/auth/me` 的 `leader.hasBalanceAccount` **逐字一致** ——
   *    同一个语义在两处出参里叫两个名字（如 `hasAccount`），端上就得写两套判断，
   *    而两套里漏改一套**不报错**、只是某个页面把「余额 0」显示成「无账户」。
   */
  @Get('balance')
  @ApiOperation({
    summary: 'U13 可用余额（**单位分**）· 退款与佣金入账共用同一账户，不支持充值',
  })
  async balance(@CurrentUser() user: JwtPayload) {
    const snap = await this.leaderMoney.accountOf(user.sub);

    return {
      /** 可用余额（整数分） */
      balanceFen: snap.balanceFen,
      /** 冻结额（整数分） */
      frozenFen: snap.frozenFen,
      /** 累计收入（整数分） */
      totalInFen: snap.totalInFen,
      /** 累计支出（整数分） */
      totalOutFen: snap.totalOutFen,
      /** `false` = 尚无余额账户（余额全 0 是**正常状态**，不是异常） */
      hasBalanceAccount: snap.hasAccount,
      /**
       * ⭐ 口径说明由**服务端下发**（端上不复制一份文案）
       *
       * 余额的**两个来源必须一起讲**：订单退款 + 团长佣金入账
       * （用户与团长共用同一 `ab_balance`，理由见 U14 的注释）。
       * 只写「仅来自订单退款」是原型 v4.10.0 的**过时文案** —— 团长的佣金
       * 就落在同一个账户里，端上照抄这句，用户看到的就是一句
       * **与自己的流水对不上**的说明（大卡金额含佣金、说明却说只有退款）。
       *
       * 「不支持充值」才是真正要告知用户的产品口径（避免形成预付资金负债）。
       * 写在服务端是为了与后台/文档**同一份措辞**；端上手抄一遍，
       * 改了这里没改那里，用户看到的就是过期说明。
       */
      note: '余额来自订单退款与团长佣金入账（用户与团长共用同一账户），不支持充值；下单时可直接抵扣',
    };
  }

  /**
   * U14 · 余额明细（M04-03）
   *
   * ⭐ 与团长侧 L19 `GET /leader/balance-logs` **共用同一实现**
   *    （`LeaderMoneyService.logsOf`）—— 只在入参上把 `leader.userId`
   *    换成 `user.sub`。汇总 `summary` 按**全量**统计，不受分页影响。
   *
   * ## ⚠️ 为什么**不做**「用户只看 order_pay/refund」的默认筛选
   *
   * 原型 P9 的说明条写着「用户账户余额仅来自订单退款……团长佣金余额是**独立账户**」。
   * ⭐ 这句与实装**不一致**：`ab_balance` 的主键是 `user_id`，
   *    用户与团长**共用同一账户**，佣金入账与下单抵扣走同一条链路
   *    （`commission.service.ts` 头注原文：「团长佣金既可提现，也可直接抵餐费」）。
   *
   * 若按原型那样在服务端默认只回两类流水，会造出一个**假的账户切分**：
   * 团长的「账户余额」大卡显示的是含佣金的总额，而下方流水却把佣金藏起来，
   * 用户自己加不出上面那个数 —— 这比多显示几行更难解释。
   *
   * 故：**不传 `type` 即返回全部流水**（与 L19 完全一致），
   * 页面用 `typeText` + 说明条把每一类的来源讲清楚。
   * ⚠️ 原型 P9 的该句口径**已列为待修订**（见《模拟数据与回归测试结果》/批次记录），
   *    实现按**实装口径**走，不按过时文案走。
   */
  @Get('balance/logs')
  @ApiOperation({
    summary: 'U14 余额明细（分页 + 全量收支汇总）· 与 L19 同一实现',
  })
  async balanceLogs(@CurrentUser() user: JwtPayload, @Query() q: UserBalanceLogQueryDto) {
    return this.leaderMoney.logsOf(user.sub, q);
  }
}
