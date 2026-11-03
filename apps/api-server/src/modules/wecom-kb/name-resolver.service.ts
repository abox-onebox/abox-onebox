import { Injectable, Logger } from '@nestjs/common';
import { WecomSvcTokenService } from './wecom-svc-token.service';
import { NameCandidate, matchByName, findCandidatesInText } from './name-match';

/**
 * 「说名字」→「后台主键」的取数层
 *
 * 数据从哪来：后台已有的只读列表端点（`/admin/building-groups`、`/admin/buildings`、
 * `/admin/meal/templates`、`/admin/meal/dishes`），**不新建查询接口**。
 * 这样单选真源：后台改了数据，助手下一分钟就跟上，不存在第二份楼名单。
 *
 * 为什么要缓存 60 秒：同事常常连发几条（先看有什么、再排、再改），
 * 每条都全量拉一次列表既慢又给后台添压力。60 秒足够覆盖一次对话的节奏，
 * 又不会让「刚建的楼」在十分钟内都认不到。
 *
 * ⚠️ 楼栋 → 楼群的映射是这里最关键的一段：
 *   后台的「分配套餐」对象是**楼群**，而同事嘴里说的是**楼栋**（「量子大厦 A 座」）。
 *   若 A 座与 B 座同属一个楼群，那一句「给量子大厦 A 座上明天的套餐」就该直接命中该楼群 ——
 *   因为一楼群一日一套餐，排 A 座等于排整个楼群。这一点必须在回复里讲明，避免误会。
 */

export type GroupResolve =
  | {
      kind: 'hit';
      groupId: number;
      groupName: string;
      via: 'group' | 'building';
      buildingName?: string;
    }
  | { kind: 'many'; options: { id: number; label: string }[] }
  | { kind: 'none' };

export type ItemResolve =
  | { kind: 'hit'; id: number; name: string; priceFen?: number; statusText?: string }
  | { kind: 'many'; options: { id: number; label: string }[] }
  | { kind: 'none' };

interface CacheEntry<T> {
  at: number;
  items: T[];
}

interface RawBuilding {
  id: number;
  name: string;
  buildingGroupId?: number | null;
  groupName?: string | null;
}

interface RawGroup {
  id: number;
  name: string;
  status?: number;
  statusLabel?: string | null;
}

/**
 * 在职团长清单行（admin/leaders?view=roster 名册，status=1）
 * —— 招募缺口（节点 G）与团长健康度（节点 N）共用。
 *
 * ⚠️ 只声明「用得到」的字段：`phoneMasked` / `realName` / `nickname` / `openidTail`
 *   虽然接口有返回，这里**刻意不取**——个人身份不进 AI 数据流（隐私红线）。
 * ⚠️ `totalCommissionFen` 也刻意不接：它是 `ab_team_leader.total_commission` 的统计快照，
 *   `balance` 列从不更新（恒 0），拿它判「团长手上还有多少钱」会算出假亏损。
 *   钱的口径一律走财务端点（节点 K）。
 */
interface RawLeader {
  id: number;
  buildingId: number;
  buildingName: string | null;
  /** 所属楼群 id / 名称（健康度按楼群算覆盖率用） */
  groupId?: number | null;
  groupName?: string | null;
  level: string;
  status: number;
  monthOrders: number;
  /** 累计完成份数（健康度的「老团长/新团长」区分） */
  totalOrders?: number;
  /** 已转正的被推荐人数量（升级第二条件） */
  invitedFormalCount?: number;
  /** 他名下最近一次产生订单的时间（BJ ISO；无单为 null） */
  lastOrderAt?: string | null;
  /** 收款三要素是否齐全（缺一项提不了现 → 卡点） */
  payoutBound?: boolean;
  /** 已签协议版本 */
  agreeVersion?: string | null;
  /** 任命时间（判「新上任」用，避免把刚任命的人算成流失） */
  createdAt?: string | null;
}

interface RawTemplate {
  id: number;
  name?: string | null;
  priceFen?: number;
  status?: number;
  statusText?: string;
}

interface RawDish {
  id: number;
  name?: string | null;
}

/** 现有代金券券种（admin/coupon/defs）—— 发券策略提案接地，避免 AI 凭空造 id */
interface RawCouponDef {
  id: number;
  name: string;
  faceValueFen: number;
  thresholdFen: number;
  validityType?: string | null;
  validDays?: number | null;
  totalLimit?: number | null;
  issuedCount?: number;
  status?: string;
}

/** 供应商（含每日产能）—— 需求预测与产能预警用，取产能基线 */
interface RawSupplier {
  id: number;
  name?: string | null;
  status?: number;
  statusLabel?: string | null;
  capacityPerDay?: number | null;
}

/** 套餐模板全量（含菜品构成/被排次数/状态）—— 选品提案用，不复用 `RawTemplate` 的裁剪版 */
interface RawTemplateItem {
  itemId: number;
  slot: number;
  slotLabel: string;
  name: string;
  supplierId: number;
}
interface RawTemplateFull {
  id: number;
  name?: string | null;
  priceFen?: number;
  costPriceFen?: number;
  oneLiner?: string | null;
  status?: number;
  statusText?: string;
  kind?: string;
  itemCount?: number;
  items?: RawTemplateItem[];
  usedCount?: number;
}

/** 财务对账视图（admin/finance/reconciliation）—— 风控对账 AI 用，仅读 summary 与差异分布 */
interface RawReconcile {
  date?: string;
  anchorLabel?: string;
  channel?: { source?: string; billAvailable?: boolean; note?: string };
  summary?: {
    balanced?: boolean;
    diffCount?: number;
    diffFen?: number;
    orderFen?: number;
    logFen?: number;
    refundFen?: number;
    netFen?: number;
    orderCount?: number;
    logCount?: number;
    refundCount?: number;
    matchedCount?: number;
  };
  diffTypeStats?: { type: string; label: string; count: number }[];
  lastRun?: {
    freshness?: string;
    date?: string;
    balanced?: boolean;
    diffCount?: number;
    /** 最近一次执行的触发方式：cron=定时自动 / manual=人工补跑（决定 AI 文案措辞） */
    trigger?: 'cron' | 'manual';
  };
  note?: string;
}

/**
 * 退款列表行（admin/finance/refunds 的 `list` 项）—— 节点 K 只读 summary；
 * 节点 Q（退款根因聚类）要逐笔聚类，故这里把用得到的字段显式列出。
 * ⚠️ `user.nickname` / `user.phoneMasked` **刻意不取**：聚类只需要 `userId` 计数，
 *    身份信息一律不进本层，避免顺着 LLM 外泄。
 */
export interface RawRefundRow {
  id?: number;
  refundNo?: string | null;
  orderNo?: string | null;
  mealDate?: string | null;
  amountFen?: number | null;
  status?: string | null;
  statusText?: string | null;
  applySource?: string | null;
  applySourceText?: string | null;
  reasonType?: string | null;
  reasonTypeText?: string | null;
  reason?: string | null;
  refundedAt?: string | null;
  auditAt?: string | null;
  user?: { id?: number | null } | null;
  leader?: { id?: number | null } | null;
}

/** 退款审批列表（admin/finance/refunds）—— K 读 summary，Q 读 list 聚类 */
interface RawRefundPage {
  summary?: {
    pendingCount?: number;
    pendingAmountFen?: number;
    approvedCount?: number;
    refundedCount?: number;
    refundedAmountFen?: number;
    rejectedCount?: number;
  };
  list?: RawRefundRow[];
}

/** 应付未出单异常（admin/supplier-shares/exceptions）—— 风控对账 AI 用，仅读 summary */
interface RawShareException {
  date?: string;
  summary?: {
    count?: number;
    supplierCount?: number;
    itemCount?: number;
    byReason?: Record<string, number>;
  };
  list?: unknown[];
}

/** 提现审批列表（admin/finance/withdrawals）—— 风控对账 AI 用，仅读 summary */
interface RawWithdrawalPage {
  summary?: {
    pendingCount?: number;
    pendingAmountFen?: number;
    approvedCount?: number;
    approvedAmountFen?: number;
    frozenByWithdrawFen?: number;
  };
  list?: unknown[];
}

/**
 * 排餐矩阵（admin/meal/matrix）—— 冷启动体检只看 stats
 *
 * 后端返回的是完整网格（dates × groups × cells），这里**只声明 stats**，
 * 让「不需要的字段不存在于类型里」成为一道闸：想误用逐格明细也过不了编译。
 */
interface RawMealMatrix {
  startDate?: string;
  endDate?: string;
  stats?: {
    dateCount?: number;
    groupCount?: number;
    cellCount?: number;
    /** 已排期格子数（含 pending 未上架） */
    assignedCells?: number;
    /** 其中已上架（active）的格子数 */
    publishedCells?: number;
    emptyCells?: number;
    totalSold?: number;
  };
}

/** C 端用户（admin/users）—— 流失预警与召回用，仅取判流失所需的精简字段 */
interface RawUser {
  id: number;
  status?: number;
  statusLabel?: string;
  orderCount?: number;
  /** 最近下单日（HTTP JSON 序列化为字符串，service 端用 new Date 解析；可能为 null） */
  lastOrderAt?: string | null;
  buildingId?: number | null;
}

/** 后台统一响应外壳（具名类型：写成 `as typeof body` 会被收窄成 null 而报 TS2339） */
interface ListEnvelope {
  code?: number;
  message?: string;
  data?: unknown;
}

const TTL_MS = 60_000;

@Injectable()
export class NameResolverService {
  private readonly logger = new Logger(NameResolverService.name);
  private groups?: CacheEntry<RawGroup>;
  private buildings?: CacheEntry<RawBuilding>;
  private templates?: CacheEntry<RawTemplate>;
  private templatesFull?: CacheEntry<RawTemplateFull>;
  private dishes?: CacheEntry<RawDish>;

  constructor(private readonly svcToken: WecomSvcTokenService) {}

  private base(): string {
    return (
      process.env.WECOM_INTERNAL_API_BASE || 'http://127.0.0.1:' + (process.env.PORT || '3000')
    );
  }

  private prefix(): string {
    return process.env.API_PREFIX || '/api/v1';
  }

  /** 取后台列表（带缓存）。失败即返回 null，由上层给人话提示，不抛异常打断对话。 */
  private async fetchList<T>(path: string): Promise<T[] | null> {
    const token = await this.svcToken.get();
    if (!token) return null;
    const url = this.base() + this.prefix() + path;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      const text = await resp.text();
      let body: ListEnvelope | null = null;
      try {
        body = JSON.parse(text) as ListEnvelope;
      } catch {
        this.logger.error(`列表接口返回非 JSON：${path}`);
        return null;
      }
      if (!body || body.code !== 0 || !body.data) {
        this.logger.error(`列表接口失败：${path} code=${body ? body.code : 'N/A'}`);
        return null;
      }
      const data = body.data as { list?: T[] } | T[];
      const list = Array.isArray(data) ? data : Array.isArray(data.list) ? data.list : [];
      return list;
    } catch (e) {
      this.logger.error(`列表接口请求未送达：${path} ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * 取后台接口的原始 data 对象（对账/退款/应付/提现等返回「对象」而非「数组」）。
   * 复用 svcToken + 60s 续期 + 统一错误日志，失败即返回 null，不抛异常打断对话。
   * ⚠️ 容忍两种外壳：① 统一响应外壳 {code,message,data}；② 直接返回对象（未包裹）。
   */
  private async fetchJson<T>(path: string): Promise<T | null> {
    const token = await this.svcToken.get();
    if (!token) return null;
    const url = this.base() + this.prefix() + path;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      const text = await resp.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        this.logger.error(`接口返回非 JSON：${path}`);
        return null;
      }
      const obj = (body && typeof body === 'object' ? body : null) as {
        code?: number;
        data?: unknown;
      } | null;
      const data = obj && 'code' in obj ? (obj.code === 0 ? obj.data : null) : body;
      if (data === null || data === undefined) {
        this.logger.error(
          `接口失败或为空：${path} code=${obj && 'code' in obj ? obj.code : 'N/A'}`,
        );
        return null;
      }
      return data as T;
    } catch (e) {
      this.logger.error(`接口请求未送达：${path} ${(e as Error).message}`);
      return null;
    }
  }

  private fresh<T>(c: CacheEntry<T> | undefined): boolean {
    return Boolean(c && Date.now() - c.at < TTL_MS);
  }

  async listGroups(force = false): Promise<RawGroup[] | null> {
    if (!force && this.fresh(this.groups)) return this.groups!.items;
    const list = await this.fetchList<RawGroup>('/admin/building-groups?pageSize=100');
    if (!list) return null;
    this.groups = { at: Date.now(), items: list };
    return list;
  }

  async listBuildings(force = false): Promise<RawBuilding[] | null> {
    if (!force && this.fresh(this.buildings)) return this.buildings!.items;
    const list = await this.fetchList<RawBuilding>('/admin/buildings?pageSize=100');
    if (!list) return null;
    this.buildings = { at: Date.now(), items: list };
    return list;
  }

  async listTemplates(force = false): Promise<RawTemplate[] | null> {
    if (!force && this.fresh(this.templates)) return this.templates!.items;
    const list = await this.fetchList<RawTemplate>('/admin/meal/templates?pageSize=100');
    if (!list) return null;
    this.templates = { at: Date.now(), items: list };
    return list;
  }

  /**
   * 套餐模板**全量**（含菜品构成 / 被排次数 / 状态）—— 选品提案用。
   *
   * 与 `listTemplates` 的区别：那个只留 `status===1` 且裁剪到 id/name/price，
   * 选品提案要看到**全部**（含停用、含 0 被排的），才能给出「留 / 试 / 退」判断。
   * 复用同一个 `fetchList` 与 60s 缓存，纯只读、零新接口。
   */
  async listTemplatesFull(force = false): Promise<RawTemplateFull[] | null> {
    if (!force && this.fresh(this.templatesFull)) return this.templatesFull!.items;
    const list = await this.fetchList<RawTemplateFull>('/admin/meal/templates?pageSize=100');
    if (!list) return null;
    this.templatesFull = { at: Date.now(), items: list };
    return list;
  }

  async listDishes(force = false): Promise<RawDish[] | null> {
    if (!force && this.fresh(this.dishes)) return this.dishes!.items;
    const list = await this.fetchList<RawDish>('/admin/meal/dishes');
    if (!list) return null;
    this.dishes = { at: Date.now(), items: list };
    return list;
  }

  /**
   * 在职团长清单（status=1）—— 招募缺口计算用。
   *
   * 分页拉全（pageSize=100，最多 20 页 = 2000 人，超过即截断，防死循环），
   * 每页都带 `status=1` 只取在职。失败策略：首屏失败返回 null（交给上层人话提示）；
   * 中途某页失败则保留已攒到的，宁缺毋滥、绝不抛异常打断对话。
   * 不带 60s 缓存（仅在命令触发时调用，要最新口径）。
   */
  async listLeaders(): Promise<RawLeader[] | null> {
    const all: RawLeader[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 20; page++) {
      const list = await this.fetchList<RawLeader>(
        `/admin/leaders?view=roster&status=1&pageSize=${pageSize}&page=${page}`,
      );
      if (!list) {
        if (page === 1) return null;
        break;
      }
      all.push(...list);
      if (list.length < pageSize) break;
    }
    return all;
  }

  /**
   * 现有代金券券种定义（admin/coupon/defs）。
   * 发券策略提案用它做接地：让 AI 知道「已有哪些券种可复用 / 哪些要新建」，不凭空造 id。
   * 不带缓存（仅命令触发时取最新）。失败返回 null，上层跳过该视角即可。
   */
  async listCouponDefs(): Promise<RawCouponDef[] | null> {
    return this.fetchList<RawCouponDef>('/admin/coupon/defs?pageSize=100');
  }

  /** 供应商列表（含每日产能）。纯只读、复用 fetchList 与 admin token，零新增接口。产能基线缺失时返回空数组由调用方降级。 */
  async listSuppliers(): Promise<RawSupplier[] | null> {
    return this.fetchList<RawSupplier>('/admin/suppliers?pageSize=100');
  }

  /** 微信支付对账（本地三头）：admin/finance/reconciliation?date=Y（date 为支付日，默认服务端取今日） */
  async getReconciliation(date: string): Promise<RawReconcile | null> {
    return this.fetchJson<RawReconcile>(
      `/admin/finance/reconciliation?date=${encodeURIComponent(date)}`,
    );
  }

  /** 退款审批列表：admin/finance/refunds?tab=pending（待审批积压，运营风控关注点） */
  async getRefunds(tab = 'pending', pageSize = 50): Promise<RawRefundPage | null> {
    return this.fetchJson<RawRefundPage>(
      `/admin/finance/refunds?tab=${encodeURIComponent(tab)}&pageSize=${pageSize}`,
    );
  }

  /**
   * 退款逐笔清单（节点 Q 用）：取 `tab=all` 的最近一页（接口无日期区间参数，
   * pageSize 上限 100），窗口过滤交给纯函数 `clusterRefunds`。
   * ⚠️ 返回的样本量就是「最近 N 笔」，文案里必须说明，别写成「全部退款」。
   */
  async listRefundRows(pageSize = 100): Promise<RawRefundRow[] | null> {
    const page = await this.getRefunds('all', Math.min(100, Math.max(1, pageSize)));
    return page?.list ?? null;
  }

  /** 应付未出单异常：admin/supplier-shares/exceptions?date=Y（date 必填，出餐日） */
  async getShareExceptions(date: string): Promise<RawShareException | null> {
    return this.fetchJson<RawShareException>(
      `/admin/supplier-shares/exceptions?date=${encodeURIComponent(date)}`,
    );
  }

  /** 提现审批列表：admin/finance/withdrawals?tab=review（待审批积压，资金风控关注点） */
  async getWithdrawals(tab = 'review'): Promise<RawWithdrawalPage | null> {
    return this.fetchJson<RawWithdrawalPage>(
      `/admin/finance/withdrawals?tab=${encodeURIComponent(tab)}&pageSize=50`,
    );
  }

  /**
   * 排餐矩阵（admin/meal/matrix）—— AI 每日编排的「冷启动体检」用。
   *
   * 只取 `stats`（格子计数），**不搬逐格数据**：判「未来几天有没有可售排餐」只需要
   * assignedCells / publishedCells 两个数，搬 7 天 × N 楼群的明细纯属浪费上下文。
   *
   * ⚠️ 两个计数的语义必须分清（体检的提示语依赖它）：
   *   assignedCells = 已排期格子数（含 pending 未上架）
   *   publishedCells = 其中已上架（active）的格子数
   * 「排了但没上架」≠「没排」—— 前者是漏了点上架，后者是没开始，负责人的下一步动作不同。
   */
  async getMealMatrix(startDate: string, endDate: string): Promise<RawMealMatrix | null> {
    return this.fetchJson<RawMealMatrix>(
      `/admin/meal/matrix?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
    );
  }

  /**
   * C 端用户名录（admin/users）—— 流失预警与召回用。
   *
   * 只取判流失所需的精简字段（id/status/orderCount/lastOrderAt/buildingId），不搬昵称/手机号等 PII。
   * 分页拉全（pageSize=100，最多 20 页 = 2000 人，超过即截断，防死循环），
   * 每页各自独立 try/catch：首屏失败返回 null；中途某页失败保留已攒到的，宁缺毋滥。
   * 复用 svcToken + fetchJson，零新增接口。operator 令牌已在 user-admin 角色内，纯读可达。
   */
  async listUsers(): Promise<RawUser[] | null> {
    const all: RawUser[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 20; page++) {
      let body: unknown = null;
      try {
        body = await this.fetchJson<unknown>(`/admin/users?pageSize=${pageSize}&page=${page}`);
      } catch {
        if (page === 1) return null;
        break;
      }
      if (body == null) {
        if (page === 1) return null;
        break;
      }
      // 兼容两种返回形态：① 分页对象 {list:[...]}；② 裸数组 [...]
      const arr = Array.isArray(body)
        ? body
        : Array.isArray((body as { list?: unknown[] }).list)
          ? (body as { list: unknown[] }).list
          : [];
      if (!arr.length) break;
      for (const raw of arr) {
        const u = raw as Record<string, unknown>;
        const id = Number(u.id);
        if (!Number.isFinite(id) || id <= 0) continue;
        all.push({
          id,
          status: typeof u.status === 'number' ? u.status : undefined,
          statusLabel: typeof u.statusLabel === 'string' ? u.statusLabel : undefined,
          orderCount: typeof u.orderCount === 'number' ? u.orderCount : 0,
          lastOrderAt:
            u.lastOrderAt == null
              ? null
              : typeof u.lastOrderAt === 'string'
                ? u.lastOrderAt
                : String(u.lastOrderAt),
          buildingId: u.buildingId == null ? null : Number(u.buildingId),
        });
      }
      if (arr.length < pageSize) break;
    }
    return all;
  }

  /** 清缓存（执行完写操作后调，避免刚改的数据还是旧的） */
  invalidate(): void {
    this.groups = undefined;
    this.buildings = undefined;
    this.templates = undefined;
    this.templatesFull = undefined;
    this.dishes = undefined;
  }

  /**
   * 把「楼群名」或「楼栋名」都解析成楼群 id。
   *
   * 顺序：先按楼群名找（他说的是楼群）；找不到再按楼栋名找，再顺着楼栋归到它的楼群。
   * 同一楼群下的多栋楼命中时**合并成一个命中**（因为分配对象就是楼群）。
   */
  async resolveGroup(text: string): Promise<GroupResolve> {
    const groups = await this.listGroups();
    if (!groups) return { kind: 'none' };

    const gCand: NameCandidate[] = groups.map((g) => ({ id: g.id, name: g.name }));
    const gHit = matchByName(text, gCand);
    if (gHit.kind === 'hit') {
      return { kind: 'hit', groupId: gHit.item.id, groupName: gHit.item.name, via: 'group' };
    }
    if (gHit.kind === 'many') {
      return {
        kind: 'many',
        options: gHit.items.map((x) => ({ id: x.id, label: x.name })),
      };
    }

    // 楼群名没沾上 → 按楼栋名试
    const buildings = await this.listBuildings();
    if (!buildings) return { kind: 'none' };
    const bCand: NameCandidate[] = buildings.map((b) => ({
      id: b.id,
      name: b.name,
      note: b.groupName ?? undefined,
    }));
    const bHit = matchByName(text, bCand);

    const toGroup = (buildingId: number): GroupResolve => {
      const b = buildings.find((x) => x.id === buildingId);
      if (!b || !b.buildingGroupId) return { kind: 'none' };
      const g = groups.find((x) => x.id === Number(b.buildingGroupId));
      return {
        kind: 'hit',
        groupId: Number(b.buildingGroupId),
        groupName: g ? g.name : (b.groupName ?? `楼群#${b.buildingGroupId}`),
        via: 'building',
        buildingName: b.name,
      };
    };

    if (bHit.kind === 'hit') return toGroup(bHit.item.id);

    if (bHit.kind === 'many') {
      // 多栋楼若同属一个楼群，直接合并成该楼群（一楼群一日一套餐，排哪栋都一样）
      const gids = [
        ...new Set(
          bHit.items
            .map((x) => buildings.find((b) => b.id === x.id)?.buildingGroupId)
            .filter((x): x is number => Boolean(x))
            .map(Number),
        ),
      ];
      if (gids.length === 1) return toGroup(bHit.items[0].id);
      return {
        kind: 'many',
        options: bHit.items.map((x) => ({
          id: x.id,
          label: x.note ? `${x.name}（${x.note}）` : x.name,
        })),
      };
    }

    return { kind: 'none' };
  }

  /** 套餐模板：只说「A 套餐」也能认；只认在用（status=1）的，停用的不参与派单 */
  async resolveSetMeal(text: string): Promise<ItemResolve> {
    const list = await this.listTemplates();
    if (!list) return { kind: 'none' };
    const usable = list.filter((t) => (t.status === undefined ? true : t.status === 1));
    const cand: NameCandidate[] = usable
      .filter((t) => Boolean(t.name))
      .map((t) => ({
        id: t.id,
        name: String(t.name),
        note: t.priceFen != null ? `¥${(t.priceFen / 100).toFixed(2)}` : undefined,
      }));
    const r = matchByName(text, cand);
    if (r.kind === 'hit') {
      const t = usable.find((x) => x.id === r.item.id);
      return {
        kind: 'hit',
        id: r.item.id,
        name: r.item.name,
        priceFen: t?.priceFen,
        statusText: t?.statusText,
      };
    }
    if (r.kind === 'many') {
      return {
        kind: 'many',
        options: r.items.map((x) => ({ id: x.id, label: x.note ? `${x.name} ${x.note}` : x.name })),
      };
    }
    return { kind: 'none' };
  }

  /**
   * 从**整句话**里认楼群（「给量子大厦 A 座上明天的套餐」→ 该楼群）
   *
   * 与 `resolveGroup(text)` 的区别：那个是把整句当**名称**去比（适合他回数字后补的那句
   * 「量子大厦 A 座」），这个是把句子当**句子**、拿库里真实名称去找（适合第一次开口）。
   */
  async resolveGroupFromSentence(text: string): Promise<GroupResolve> {
    const groups = await this.listGroups();
    if (!groups) return { kind: 'none' };
    const buildings = await this.listBuildings();

    const gCand: NameCandidate[] = groups.map((g) => ({ id: g.id, name: g.name }));
    const gHits = findCandidatesInText(text, gCand);
    if (gHits.length === 1) {
      return { kind: 'hit', groupId: gHits[0].id, groupName: gHits[0].name, via: 'group' };
    }
    if (gHits.length > 1) {
      return { kind: 'many', options: gHits.slice(0, 6).map((x) => ({ id: x.id, label: x.name })) };
    }

    if (!buildings) return { kind: 'none' };
    const bCand: NameCandidate[] = buildings.map((b) => ({
      id: b.id,
      name: b.name,
      note: b.groupName ?? undefined,
    }));
    const bHits = findCandidatesInText(text, bCand);
    if (bHits.length === 0) return { kind: 'none' };

    // 句子里的多栋楼若同属一个楼群 → 合并成该楼群（一楼群一日一套餐）
    const gids = [
      ...new Set(
        bHits
          .map((x) => buildings.find((b) => b.id === x.id)?.buildingGroupId)
          .filter((x): x is number => Boolean(x))
          .map(Number),
      ),
    ];
    if (gids.length === 1) {
      const gid = gids[0];
      const g = groups.find((x) => x.id === gid);
      const b = buildings.find((x) => Number(x.buildingGroupId) === gid);
      return {
        kind: 'hit',
        groupId: gid,
        groupName: g ? g.name : (b?.groupName ?? `楼群#${gid}`),
        via: 'building',
        buildingName: bHits[0].name,
      };
    }
    return {
      kind: 'many',
      options: bHits.slice(0, 6).map((x) => ({
        id: x.id,
        label: x.note ? `${x.name}（${x.note}）` : x.name,
      })),
    };
  }

  /** 从整句话里认套餐模板 */
  async resolveMealFromSentence(text: string): Promise<ItemResolve> {
    const list = await this.listTemplates();
    if (!list) return { kind: 'none' };
    const usable = list.filter((t) => (t.status === undefined ? true : t.status === 1));
    const cand: NameCandidate[] = usable
      .filter((t) => Boolean(t.name))
      .map((t) => ({
        id: t.id,
        name: String(t.name),
        note: t.priceFen != null ? `¥${(t.priceFen / 100).toFixed(2)}` : undefined,
      }));
    const hits = findCandidatesInText(text, cand);
    if (hits.length === 1) {
      const t = usable.find((x) => x.id === hits[0].id);
      return {
        kind: 'hit',
        id: hits[0].id,
        name: hits[0].name,
        priceFen: t?.priceFen,
        statusText: t?.statusText,
      };
    }
    if (hits.length > 1) {
      return {
        kind: 'many',
        options: hits
          .slice(0, 6)
          .map((x) => ({ id: x.id, label: x.note ? `${x.name} ${x.note}` : x.name })),
      };
    }
    return { kind: 'none' };
  }

  /** 菜品：上架/下架/编辑时用 */
  async resolveDish(text: string): Promise<ItemResolve> {
    const list = await this.listDishes();
    if (!list) return { kind: 'none' };
    const cand: NameCandidate[] = list
      .filter((d) => Boolean(d.name))
      .map((d) => ({ id: d.id, name: String(d.name) }));
    const r = matchByName(text, cand);
    if (r.kind === 'hit') return { kind: 'hit', id: r.item.id, name: r.item.name };
    if (r.kind === 'many') {
      return { kind: 'many', options: r.items.map((x) => ({ id: x.id, label: x.name })) };
    }
    return { kind: 'none' };
  }
}
