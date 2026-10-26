import { BuildingGroupStatus, BuildingStatus } from '@abox/shared-types';
import { FindOperator, Repository } from 'typeorm';

import { OrderAvailabilityService } from '../../src/common/services/order-availability.service';
import { ErrorCode } from '../../src/common/constants/error-code';
import { BuildingGroup, Building } from '../../src/database/entities/building.entity';
import { MealAssignment } from '../../src/database/entities/meal.entity';
import { SalesPause } from '../../src/database/entities/system.entity';
import { User } from '../../src/database/entities/user.entity';
import type { JwtPayload } from '../../src/common/decorators/auth.decorator';
import { CreateSalesPauseDto } from '../../src/modules/admin/sales-pause/dto/sales-pause.dto';
import { SalesPauseService } from '../../src/modules/admin/sales-pause/sales-pause.service';

/**
 * ⏱ 固定时钟
 *
 * ⚠️ 为什么必须钉住：`evaluateAvailability()` 的时间层会把 `now()` 与「该出餐日的
 *    开团 / 截单时刻」比对。若让测试跑在真实时钟上，「不停售时 canOrder 应为 true」
 *    这条断言会在每天 23:50 之后到次日 14:00 之前**恒红** —— 红的不是被测行为，
 *    而是断言依赖了环境时钟（同 `time.ts` 注入时钟的既有理由）。
 *
 * ⚠️ 只覆盖 `now` / `publishAtOf` / `cutoffAtOf` 三个本批用到的函数，其余走
 *    `requireActual` —— 收窄 mock 面，避免夹具自己把被测逻辑改掉。
 *
 * 取值：出餐日 T = 2026-10-27 ⇒ T-1 = 10-26；注入北京时刻 10-26 20:00，
 * 落在 [开团 10-26 14:00, 截单 10-27 00:00 − 10min) 之内 ⇒ 基线可下单。
 */
const NOW = new Date('2026-10-26T12:00:00.000Z'); // 北京时间 10-26 20:00
const PUBLISH = new Date('2026-10-26T06:00:00.000Z'); // 北京时间 10-26 14:00
const CUTOFF = new Date('2026-10-26T16:00:00.000Z'); // 北京时间 10-27 00:00

jest.mock('../../src/common/utils/time', () => {
  const actual = jest.requireActual('../../src/common/utils/time');
  return {
    ...actual,
    now: () => NOW,
    publishAtOf: () => PUBLISH,
    cutoffAtOf: () => CUTOFF,
  };
});

/**
 * W1 一键停售 —— 服务层单测（见 `docs/specs/PHASE3-N1N2W1-落码规格.md` §7.6）
 *
 * ## 为什么必须有它
 *
 * W1 有两条**会随时间退化**的不变量，任何 e2e 都抓不住：
 *
 *   ① **无缓存 / 立即可见**。`OrderAvailabilityService` 对 `ab_sales_pause` 是**直查**。
 *      「立刻生效」不是出自某个机制，而是出自一个**缺省**。将来任何人为了优化 RT
 *      套一层缓存（哪怕 TTL 10 秒），停售会退化成「最长延迟 TTL 秒」，
 *      而**现有验收句式仍全绿**（缓存命中的旧值在 TTL 内与真值一样）。
 *      ⇒ 本文件用「内存仓储 + 立刻重查」的形态把它固化成可执行断言。
 *
 *   ② **重叠区间取最新创建的那条**。spec §7.3 刻意允许重叠（「停售明天」+「停售下周一」），
 *      运营改主意时**后写的优先**。若哪天有人把排序换成 `meal_date_from`，
 *      晚写的区间可能更早开始 ⇒ 文案取错，且**不报错**。
 *
 * ## ⚠️ 本文件当前有 2 条**按计划红着**的用例（不是失败，是待办）
 *
 * 见文件末尾 `describe('⛔ 待开闸：文案须含运营填的 reason')`。原因：
 * `reasonText()` 的 `ReasonContext` 尚未提供承载运营 reason 的槽位，
 * 改动涉及 `common/utils/orderability.ts` —— 该文件正被 `archivist-finish` 并发占用，
 * 团队已裁定**开闸后再改**。红用例 = 待办清单，开闸后实现落地即自然转绿。
 */

// ---------------------------------------------------------------------------
// 夹具：内存版 `ab_sales_pause` 仓储
// ---------------------------------------------------------------------------

/** 造一行停售记录（只填本批断言用到的列） */
function pause(
  id: number,
  mealDateFrom: string,
  mealDateTo: string,
  reason: string,
  resumedAt: Date | null = null,
): SalesPause {
  return {
    id,
    mealDateFrom,
    mealDateTo,
    reason,
    createdBy: 1,
    resumedAt,
    resumedBy: null,
    createdAt: new Date('2026-10-26T00:00:00Z'),
    updatedAt: new Date('2026-10-26T00:00:00Z'),
  } as SalesPause;
}

/**
 * 判定单个单元格是否满足条件
 *
 * ⚠️ 只支持本批实际用到的三个算子，遇到别的**直接抛错**而不是静默放行 ——
 *    静默放行会让「实现换了查询方式」变成一条恒绿的假用例。
 */
function cellSatisfies(cell: unknown, cond: unknown): boolean {
  if (cond instanceof FindOperator) {
    const op = cond as unknown as { type: string; value: unknown };
    switch (op.type) {
      case 'lessThanOrEqual':
        return typeof cell === 'string' && cell <= (op.value as string);
      case 'moreThanOrEqual':
        return typeof cell === 'string' && cell >= (op.value as string);
      case 'isNull':
        return cell === null || cell === undefined;
      default:
        throw new Error(`夹具未支持的查询算子：${op.type}`);
    }
  }
  return cell === cond;
}

/** 在内存行集上求值 TypeORM 的 `where`（含 `LessThanOrEqual` / `MoreThanOrEqual` / `IsNull`） */
function matchWhere<T extends object>(rows: T[], where: Record<string, unknown> = {}): T[] {
  return rows.filter((row) =>
    Object.entries(where).every(([key, cond]) =>
      cellSatisfies((row as Record<string, unknown>)[key], cond),
    ),
  );
}

/**
 * 内存版停售仓储
 *
 * ⚠️ 同时实现 `count` 与 `findOne` 两条查询路径，且**读数来自同一份行集** ——
 *    这样无论实现走「计数」还是「取行」，断言都成立，用例不会因为「实现换了查询方式」
 *    而变成恒绿的空壳。
 * ⚠️ `findOne` **只在显式给了 `order: { id: 'DESC' }` 时才按 id 倒序取**；
 *    没给 order 就按插入顺序（= id 升序）返回第一条 —— 刻意对齐「无 ORDER BY 时
 *    MySQL 不保证顺序」这一事实，让「必须显式排序」成为可测判据。
 */
function makePauseRepo(seed: SalesPause[] = []) {
  const rows: SalesPause[] = [...seed];
  let seq = rows.reduce((max, r) => Math.max(max, r.id ?? 0), 0);

  return {
    /** 断言用：可直接读当前行集 */
    rows,
    find: jest.fn(async (opts?: { order?: Record<string, 'ASC' | 'DESC'> }) => {
      const out = [...rows];
      if (opts?.order?.id === 'DESC') out.sort((a, b) => b.id - a.id);
      else out.sort((a, b) => a.id - b.id);
      return out;
    }),
    findOne: jest.fn(
      async (
        opts: { where?: Record<string, unknown>; order?: Record<string, 'ASC' | 'DESC'> } = {},
      ) => {
        const hit = matchWhere(rows, opts?.where);
        if (hit.length === 0) return null;
        if (opts?.order?.id === 'DESC') {
          return hit.reduce((best, r) => ((r.id ?? 0) > (best.id ?? 0) ? r : best), hit[0]!);
        }
        return hit.reduce((best, r) => ((r.id ?? 0) < (best.id ?? 0) ? r : best), hit[0]!);
      },
    ),
    count: jest.fn(
      async (opts?: { where?: Record<string, unknown> }) => matchWhere(rows, opts?.where).length,
    ),
    create: jest.fn((data: Partial<SalesPause>) => ({ ...data }) as SalesPause),
    save: jest.fn(async (row: SalesPause) => {
      if (!row.id) {
        seq += 1;
        row.id = seq;
        rows.push(row);
      }
      return row;
    }),
  };
}

type PauseRepo = ReturnType<typeof makePauseRepo>;

// ---------------------------------------------------------------------------
// 夹具：编排层（OrderAvailabilityService）的其余依赖
// ---------------------------------------------------------------------------

const ACTOR = { sub: 42, typ: 'admin', role: 'admin' } as unknown as JwtPayload;

/** 一条「结构层/编排层/时间层全部放行」的基线，使 `canOrder` 只由停售决定 */
function makeAvailability(pauseRepo: PauseRepo) {
  const buildingRepo = {
    findOne: jest.fn(
      async () =>
        ({
          id: 1,
          buildingGroupId: 7,
          status: BuildingStatus.ACTIVE,
          deletedAt: null,
        }) as unknown as Building,
    ),
  };
  const groupRepo = {
    findOne: jest.fn(
      async () =>
        ({
          id: 7,
          status: BuildingGroupStatus.ACTIVE,
          deletedAt: null,
        }) as unknown as BuildingGroup,
    ),
  };
  const assignRepo = {
    findOne: jest.fn(async () => ({ status: 'active' }) as unknown as MealAssignment),
  };
  const userRepo = { findOne: jest.fn(async () => null as unknown as User) };
  const bizConfig = { cutoffWindowMinutes: jest.fn(async () => 10) };

  const svc = new OrderAvailabilityService(
    userRepo as unknown as Repository<User>,
    buildingRepo as unknown as Repository<Building>,
    groupRepo as unknown as Repository<BuildingGroup>,
    assignRepo as unknown as Repository<MealAssignment>,
    pauseRepo as unknown as Repository<SalesPause>,
    bizConfig as never,
  );
  return { svc, buildingRepo, groupRepo, assignRepo, bizConfig };
}

// ---------------------------------------------------------------------------
// SalesPauseService
// ---------------------------------------------------------------------------

describe('SalesPauseService（W1 · 创建 / 列表 / 恢复）', () => {
  const dto = (d: Partial<CreateSalesPauseDto>): CreateSalesPauseDto => ({
    mealDateFrom: '2026-10-27',
    mealDateTo: '2026-10-27',
    reason: '后厨设备检修，明日恢复',
    ...d,
  });

  describe('create()', () => {
    it('写入区间与原因，并落 createdBy', async () => {
      const repo = makePauseRepo();
      const svc = new SalesPauseService(repo as never);

      const row = await svc.create(dto({}), ACTOR);

      expect(row.mealDateFrom).toBe('2026-10-27');
      expect(row.mealDateTo).toBe('2026-10-27');
      expect(row.reason).toBe('后厨设备检修，明日恢复');
      expect(row.createdBy).toBe(42);
      expect(row.resumedAt).toBeUndefined();
      // 真正落进了仓储（不是只在内存里造了个对象）
      expect(repo.rows).toHaveLength(1);
    });

    it('允许 from == to（「停售明日」就是这个形态，不做第二套开关）', async () => {
      const repo = makePauseRepo();
      const svc = new SalesPauseService(repo as never);

      const row = await svc.create(
        dto({ mealDateFrom: '2026-10-28', mealDateTo: '2026-10-28' }),
        ACTOR,
      );

      expect(row.mealDateFrom).toBe(row.mealDateTo);
    });

    it('from > to（倒挂区间）→ 10001', async () => {
      const repo = makePauseRepo();
      const svc = new SalesPauseService(repo as never);

      await expect(
        svc.create(dto({ mealDateFrom: '2026-10-29', mealDateTo: '2026-10-27' }), ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID });
      // 倒挂区间不得落库
      expect(repo.rows).toHaveLength(0);
    });
  });

  describe('list()', () => {
    it('返回历史（含已恢复行），按 id DESC', async () => {
      const repo = makePauseRepo([
        pause(1, '2026-10-20', '2026-10-20', '第一次停售', new Date('2026-10-21T00:00:00Z')),
        pause(2, '2026-10-27', '2026-10-28', '第二次停售'),
      ]);
      const svc = new SalesPauseService(repo as never);

      const rows = await svc.list();

      expect(rows.map((r) => r.id)).toEqual([2, 1]);
      // 已恢复的行**不被过滤掉** —— 历史区间是审计事实
      expect(rows[0]!.resumedAt).toBeNull();
      expect(rows[1]!.resumedAt).not.toBeNull();
    });
  });

  describe('resume()', () => {
    it('写 resumedAt 与 resumedBy', async () => {
      const repo = makePauseRepo([pause(5, '2026-10-27', '2026-10-27', '设备检修')]);
      const svc = new SalesPauseService(repo as never);

      const row = await svc.resume(5, ACTOR);

      expect(row.resumedAt).toBeInstanceOf(Date);
      expect(row.resumedBy).toBe(42);
      // ⚠️ 恢复是**打标记**而不是删行 —— 审计事实不丢
      expect(repo.rows).toHaveLength(1);
    });

    it('重复 resume 同一条 → 10001（不幂等静默成功）', async () => {
      const repo = makePauseRepo([pause(5, '2026-10-27', '2026-10-27', '设备检修')]);
      const svc = new SalesPauseService(repo as never);

      await svc.resume(5, ACTOR);
      await expect(svc.resume(5, ACTOR)).rejects.toMatchObject({
        code: ErrorCode.PARAM_INVALID,
      });
    });

    it('resume 不存在的记录 → 10004', async () => {
      const repo = makePauseRepo();
      const svc = new SalesPauseService(repo as never);

      await expect(svc.resume(999, ACTOR)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// OrderAvailabilityService —— 停售接线（§7.6 第 1 / 2 / 3 条的等价断言）
// ---------------------------------------------------------------------------

describe('OrderAvailabilityService · 停售接线（W1）', () => {
  const MEAL_DATE = '2026-10-27';
  /**
   * 覆盖 MEAL_DATE 的区间（from < d < to），用来验证「含首尾 + 点查」
   *
   * ⚠️ **必须是工厂而不是共享常量**：`resume()` 会**原地改写**行上的 `resumedAt`
   *    （见 `SalesPauseService.resume` 的 `row.resumedAt = ...`）。若多个用例共用同一行对象，
   *    前一个用例恢复过之后，后面用例拿到的就是「已恢复」的行 ⇒ 停售判定变成 false，
   *    出现**用例间互相污染**（且只在按序执行时显现，单独跑又变绿 —— 最难查的那一类）。
   */
  const spanning = () => pause(1, '2026-10-26', '2026-10-28', '全区消杀，暂停接单');

  it('WHEN 停售区间覆盖该出餐日 THEN 立刻 canOrder=false 且 reason=sales_paused', async () => {
    const repo = makePauseRepo([spanning()]);
    const { svc } = makeAvailability(repo);

    const result = await svc.forBuilding(MEAL_DATE, 1);

    expect(result.canOrder).toBe(false);
    expect(result.reason).toBe('sales_paused');
  });

  it('WHEN 停售区间**不**覆盖该出餐日 THEN 不影响下单', async () => {
    // 区间 [10-20, 10-22] 不含 10-27
    const repo = makePauseRepo([pause(1, '2026-10-20', '2026-10-22', '历史停售')]);
    const { svc } = makeAvailability(repo);

    const result = await svc.forBuilding(MEAL_DATE, 1);

    expect(result.canOrder).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('WHEN 区间端点**含首尾** THEN 端点当天也算停售', async () => {
    // 左端点 == MEAL_DATE，右端点 == MEAL_DATE，两种形态各验一次
    for (const row of [
      pause(1, MEAL_DATE, '2026-10-30', '从左端点起停'),
      pause(2, '2026-10-20', MEAL_DATE, '停到右端点'),
    ]) {
      const repo = makePauseRepo([row]);
      const { svc } = makeAvailability(repo);
      await expect(svc.forBuilding(MEAL_DATE, 1)).resolves.toMatchObject({
        canOrder: false,
        reason: 'sales_paused',
      });
    }
  });

  it('WHEN 调用 resume THEN 立刻重查 canOrder=true', async () => {
    const repo = makePauseRepo([spanning()]);
    const { svc } = makeAvailability(repo);
    const admin = new SalesPauseService(repo as never);

    await expect(svc.forBuilding(MEAL_DATE, 1)).resolves.toMatchObject({ canOrder: false });
    await admin.resume(1, ACTOR);
    await expect(svc.forBuilding(MEAL_DATE, 1)).resolves.toMatchObject({
      canOrder: true,
      reason: null,
    });
  });

  it('WHEN 停售生效 THEN 文案含运营填的 reason', async () => {
    const repo = makePauseRepo([spanning()]);
    const { svc } = makeAvailability(repo);

    const result = await svc.forBuilding(MEAL_DATE, 1);

    expect(result.canOrder).toBe(false);
    expect(result.reason).toBe('sales_paused');
    // ⭐ 运营填的原因必须原样下发到用户端
    expect(result.reasonText).toContain('全区消杀，暂停接单');
  });
});

/**
 * 重叠区间的 reason 取值（W1 **定向回归**）
 *
 * ⚠️ 与上面那条的分工：上面验「文案里**有**运营填的 reason」，这条验**取哪条行的 reason**
 *    —— 两条生效中的重叠区间并存时，必须取**后创建的那条**（`id` 更大）。
 *
 * ⚠️ 为什么必须显式 `order: { id: 'DESC' }`：
 *    · 靠插入顺序 —— MySQL 无 ORDER BY 时**不保证**返回顺序，今天碰巧对、明天加个索引就翻；
 *    · 按 `meal_date_from` 排序 —— 晚写的区间完全可能**更早开始**（先「停售下周一」、
 *      后「停售明天」），那时后写的才是运营的最新意图。
 *    ⇒ 故夹具里 `findOne` **只在显式给了 DESC 时才倒序取**，没给就返回 id 最小那条 ——
 *      正好让「漏排序」或「排错列」的实现转红，而不是恒绿。
 */
describe('重叠区间的 reason 取值（W1 定向回归）', () => {
  const MEAL_DATE = '2026-10-27';

  it('WHEN 两条重叠区间都生效 THEN 文案取 id 更大的那条（= 最新创建）', async () => {
    const older = pause(1, '2026-10-26', '2026-10-28', '第一次：全区消杀');
    const newer = pause(2, '2026-10-27', '2026-10-29', '第二次：设备检修');
    const repo = makePauseRepo([older, newer]);
    const { svc } = makeAvailability(repo);

    const result = await svc.forBuilding(MEAL_DATE, 1);

    expect(result.canOrder).toBe(false);
    expect(result.reason).toBe('sales_paused');
    // ⭐ 后写的优先；取到 older 的文案说明排序写错或没写
    expect(result.reasonText).toContain('第二次：设备检修');
    expect(result.reasonText).not.toContain('第一次：全区消杀');
  });
});
