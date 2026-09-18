import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * U14 · 余额明细查询入参（M5-10）
 *
 * ## ⚠️ 为什么**不**在这里 re-export `BalanceLogQueryDto`（finance 侧那个）
 *
 * 两者字段完全相同（`type` / `page` / `pageSize`），但**归属不同契约**：
 * U14 属《接口规范》§3.5（个人中心），L19 属 §五（团长端）。
 * 项目既有纪律是「**业务模块不互相 import 对方的 DTO**」——
 * `modules/user` 引 `modules/finance/dto` 会让「改团长侧入参」意外改动用户侧契约，
 * 而 `route:audit` / Swagger 文档都按模块归属产出口径表，跨模块引用会让
 * 「这一项属于哪个批次」变得不可机械判定。
 *
 * ⭐ 真正需要共用的是**实现**（`LeaderMoneyService.logsOf`）与**文案表**
 *    （`common/constants/balance-log.ts`），这两处已经共用；入参形状相同
 *    属于巧合而非耦合，各写一份是正确的。
 *
 * ## ⭐ `type` 刻意**不做白名单**（与 L19 一致）
 *
 * 未知 `type` → 命中 0 条（正常空列表），**不报错**。
 * 与项目「非法枚举 `10001`」的通行做法看似矛盾，但这里语义不同：
 * `type` 是**筛选条件**而非**写入值** —— 筛了个不存在的类型，
 * 「没有这类流水」就是正确答案；而 `ab_balance_log.type` 的写入白名单
 * 由 `balance-admin.service.ts` 的 `switch` fail-closed 把关（那里才是关键）。
 */
export class UserBalanceLogQueryDto {
  @ApiPropertyOptional({
    description:
      '流水类型：order_pay / refund（用户视角默认两类）· commission / withdraw / withdraw_refund / adjust（团长视角同账户流水）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  type?: string;

  @ApiPropertyOptional({ description: '页码，默认 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数，默认 20，上限 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
