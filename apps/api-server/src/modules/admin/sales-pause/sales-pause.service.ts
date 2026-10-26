import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ErrorCode } from '../../../common/constants/error-code';
import { BizException } from '../../../common/exceptions/biz.exception';
import { SalesPause } from '../../../database/entities/system.entity';
import type { JwtPayload } from '../../../common/decorators/auth.decorator';
import { CreateSalesPauseDto } from './dto/sales-pause.dto';

/**
 * W1 一键停售服务（ADR-N1N2W1 · 2026-10-26）
 *
 * ## ⭐ 状态模型：一张 append-only 的区间表
 *
 * 「某出餐日是否停售」= `EXISTS(
 *     SELECT 1 FROM ab_sales_pause
 *      WHERE meal_date_from <= :d AND meal_date_to >= :d AND resumed_at IS NULL)`
 *
 * 刻意**不用** `ab_config` 的键：`BizConfigService` 有 60 秒进程内缓存，
 * 会让「点了停售」与「真的停了」之间出现最长 60 秒、且**无报错**的放单窗口。
 *
 * ## 三个端点的职责
 *   · `list()`   读取全部（**含已恢复的**）—— 历史区间是审计事实，不做过滤；
 *   · `create()` 追加一条区间，落 `created_by`；
 *   · `resume()` 给**指定行**打 `resumed_at` / `resumed_by`（**不删行**）。
 *
 * ## ⚠️ 恢复按**行**而不是按「日期」
 *
 * 重叠区间是刻意为之的（「停售明天」+「停售下周一」两条独立记录）。按日期恢复会
 * 把覆盖同一天的多条一起解掉，运营想只解其中一条时做不到；且恢复动作与当初发起
 * 停售的那一行**对不上账**（操作日志里 target_id 只能记日期，记不了是哪条）。
 * ⇒ 故 `resume` 吃 `id`，一次只解一条。
 *
 * ## ⚠️ 零缓存
 *
 * 本服务与 `OrderAvailabilityService` 一样**不引入任何缓存层** ——
 * 「立刻生效」这条性质靠的是**直查**这个缺省，不是某个机制。将来若有人为了
 * 优化 RT 在此套缓存，停售会退化成「最长延迟 TTL 秒」，而现有验收句式**仍全绿**。
 * 详见 spec §7.5。
 */
@Injectable()
export class SalesPauseService {
  constructor(
    @InjectRepository(SalesPause)
    private readonly repo: Repository<SalesPause>,
  ) {}

  /**
   * 停售区间列表（**含历史**）
   *
   * ⚠️ 刻意**不过滤** `resumed_at`：运营需要看到「这个月停过哪几天、谁停的、谁恢复的」。
   *    前端按 `resumedAt === null` 自行区分「生效中 / 已恢复」—— 这是**展示口径**，
   *    不该由接口先把历史行吞掉。
   */
  async list(): Promise<SalesPause[]> {
    return this.repo.find({ order: { id: 'DESC' } });
  }

  /**
   * 创建停售区间
   *
   * ⚠️ `from > to` 判红：这是**倒挂区间**，在 DB 上合法（不会报错）但永远匹配不到
   *    任何出餐日 ⇒ 运营点了停售、后台显示成功、实际一天都没停。属于静默失败，
   *    必须在写库前拦住。
   *
   * ⚠️ 刻意**不查重叠**：见类注释「恢复按行」，重叠是被允许的正常形态。
   */
  async create(dto: CreateSalesPauseDto, actor: JwtPayload): Promise<SalesPause> {
    if (dto.mealDateFrom > dto.mealDateTo) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        '停售起始日不能晚于截止日（mealDateFrom > mealDateTo）',
      );
    }
    const row = this.repo.create({
      mealDateFrom: dto.mealDateFrom,
      mealDateTo: dto.mealDateTo,
      reason: dto.reason,
      createdBy: actor?.sub ?? null,
    });
    return this.repo.save(row);
  }

  /**
   * 恢复指定停售区间（打 `resumed_at` / `resumed_by`）
   *
   * ⚠️ 已恢复的行**拒绝重复操作**而不是静默成功：运营连点两次时，「第二次什么都没做」
   *    这件事本身是信息 —— 静默成功会让人误以为是自己刚刚那一下生效的。
   */
  async resume(id: number, actor: JwtPayload): Promise<SalesPause> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new BizException(ErrorCode.NOT_FOUND, '停售记录不存在');
    }
    if (row.resumedAt) {
      throw new BizException(ErrorCode.PARAM_INVALID, '该停售区间已恢复，无需重复操作');
    }
    row.resumedAt = new Date();
    row.resumedBy = actor?.sub ?? null;
    return this.repo.save(row);
  }
}
