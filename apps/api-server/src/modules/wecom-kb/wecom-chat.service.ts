import { Injectable, Logger } from '@nestjs/common';
import { isAfterCutoff } from '../../common/utils/time';
import { OpProxyService, Binding } from './op-proxy.service';
import { NameResolverService, GroupResolve, ItemResolve } from './name-resolver.service';
import { bjYmdPlus, parseMealDate } from './name-match';
import { parseIntent, isConfirm, isCancel } from './chat-flow';
import {
  chatErrorText,
  summarizeOrderData,
  CHAT_HELP,
  CHAT_FALLBACK,
  CHAT_NEGATED,
} from './chat-flow';
import {
  allItems,
  canExec,
  displayName,
  find,
  itemsOfModule,
  modules,
  riskOf,
  search,
  RISK_LABEL,
  TIER_LABEL,
  type CatalogItem,
  type Tier,
} from './op-policy';

/**
 * 人话 → 后台操作 的编排（「说一句话就干活」这一层的核心）
 *
 * 一次对话的形状（同事视角）：
 *   他说「给量子大厦 A 座上明天的 A 套餐」
 *     → 我已认出楼群和套餐，只差/不缺参数
 *     → 回一张草稿：给「某某楼群」排「A 套餐」，明天（11-02）
 *     → 他回 1 → 真的写进后台；回 2 → 什么都不做
 *
 * 三条不打折的规矩：
 *   1. **认不出就问，绝不猜**：楼名命不中就列候选让他回数字。
 *      排错楼的代价是「整栋楼第二天没饭吃」，比多问一句贵得多。
 *   2. **写之前必有一次确认**：草稿卡 + 回「1」才执行，杜绝「说错一句就改了库」。
 *   3. **高危不走这里**：动钱/动单/动团长一律 submit 进审批，本服务只负责把
 *      「已提交，等负责人批」说到他能听懂。
 *
 * 会话状态放内存（Map + 10 分钟 TTL）：一期单 API 实例，够用；重启丢一次上下文，
 * 代价只是他重说一句，比引入外部存储的风险小。
 */

const SESSION_TTL_MS = 10 * 60 * 1000;

interface Draft {
  groupId?: number;
  groupName?: string;
  via?: 'group' | 'building';
  buildingName?: string;
  mealId?: number;
  mealName?: string;
  mealPriceFen?: number;
  date?: string;
  /** 正在等他回数字的候选（回 n 表示第 n 个） */
  options?: { id: number; label: string }[];
  /** 这组候选补的是哪个字段 */
  picking?: 'group' | 'meal';
}

interface Session {
  at: number;
  draft?: Draft;
  /** 通用操作（走目录的任意后台功能）状态 */
  op?: OpState;
}

/**
 * 通用操作状态：先选中一个目录端点，再逐个把必填参数问出来。
 *
 * 为什么不用「一条命令写全」（`执行 xxx a=1 b=2`）：
 *   同事记不住参数名，负责人也不该记。所以做成「选中 → 只问缺的那个 → 他回一个值」，
 *   每一步都只需要理解一件事。
 */
interface OpState {
  code: string;
  params: Record<string, string>;
  /** 候选（搜索结果 / 模块下的端点），他回数字选 */
  options?: CatalogItem[];
  /** 语义标记，避免与排套餐的 options 混用 */
  picking?: 'op';
  /** 正在问的参数名 */
  asking?: string;
}

/** 2026-11-02 → 明天（11-02） */
function dateLabel(date: string, now: Date): string {
  const today = bjYmdPlus(now, 0);
  const tomorrow = bjYmdPlus(now, 1);
  const dayAfter = bjYmdPlus(now, 2);
  const md = date.slice(5);
  if (date === today) return `今天（${md}）`;
  if (date === tomorrow) return `明天（${md}）`;
  if (date === dayAfter) return `后天（${md}）`;
  return date;
}

@Injectable()
export class WecomChatService {
  private readonly logger = new Logger(WecomChatService.name);
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly resolver: NameResolverService,
    private readonly proxy: OpProxyService,
  ) {}

  private getSession(userId: string): Session | undefined {
    const s = this.sessions.get(userId);
    if (!s) return undefined;
    if (Date.now() - s.at > SESSION_TTL_MS) {
      this.sessions.delete(userId);
      return undefined;
    }
    return s;
  }

  private putSession(userId: string, draft?: Draft): void {
    this.sessions.set(userId, { at: Date.now(), draft });
  }

  /**
   * 主入口：给一句话，回一段人话。
   * `binding` 由调用方（wecom-kb.service）负责取，令牌由服务账号自续 —— 同事不碰令牌。
   */
  async reply(userId: string, content: string, binding: Binding): Promise<string> {
    const now = new Date();
    const text = (content || '').trim();
    const session = this.getSession(userId);

    // 「2 / 取消」先处理：任何时候都能撤销，且不受会话是否过期影响。
    // ⚠️ 例外：正在等某个参数值时，纯数字是**值**不是取消 ——
    //    楼群 id 完全可能就是 2，若被当成取消，他永远填不进去这个 2。
    //    此时只认文字型取消（「取消」「算了」「不用了」）。
    const numericParamValue = Boolean(session?.op?.asking) && /^\d+$/.test(text);
    if (isCancel(text) && !numericParamValue) {
      this.sessions.delete(userId);
      return '好，什么都没动。';
    }

    const tier: Tier = binding.tier === 'owner' ? 'owner' : 'staff';

    // ── 通用操作通道（覆盖后台全部功能）──────────────────────
    // 优先级最高：一旦进了「选功能 / 填参数」状态，这一句就是参数值或序号，
    // 不能被当成新的排套餐请求（否则他刚填的楼名会被丢掉重问）。
    if (session?.op) {
      const handled = await this.handleOp(userId, text, session.op, binding, tier);
      if (handled !== null) return handled;
    }
    const cat = this.matchCatalogEntry(text, tier);
    if (cat) return this.openCatalog(userId, cat, tier);

    // 回数字：从候选里挑
    if (session?.draft?.options?.length && /^\d{1,2}$/.test(text)) {
      return this.pick(userId, session.draft, Number(text), binding, now);
    }

    // 回 1 / 确认：执行草稿
    if (isConfirm(text)) {
      if (session?.op) return this.execOp(userId, session.op, binding, text);
      if (!session?.draft) return '现在没有等你确认的事。要排套餐就说「给 X 上明天的 Y 套餐」。';
      const d = session.draft;
      if (!d.groupId || !d.mealId || !d.date) {
        return '这条还差信息，我先不动。' + this.askMissing(d);
      }
      return this.execAssign(userId, d, binding, text, now);
    }

    // 草稿还差字段、他直接答了一嘴（「明天」「A 套餐」「量子大厦 A 座」）：
    // 先往草稿里补，别重启整个流程把已经认出的楼/套餐丢掉。
    if (session?.draft) {
      const filled = await this.fillDraft(userId, session.draft, text, now);
      if (filled) return filled;
    }

    const intent = parseIntent(text, now);
    switch (intent.kind) {
      case 'help':
        this.sessions.delete(userId);
        return CHAT_HELP;
      case 'negated':
        return CHAT_NEGATED;
      case 'assign':
        return this.startAssign(userId, text, intent.date, now, session?.draft);
      case 'orders':
        return this.queryOrders(intent.date, binding, now);
      case 'myRequests':
        return this.queryMyRequests(binding);
      case 'cancel':
        return '好，什么都没动。';
      case 'confirm':
        return '现在没有等你确认的事。';
      default:
        return CHAT_FALLBACK;
    }
  }

  // ---------------------------------------------------------------- 通用操作（全部后台功能）

  private putOp(userId: string, op?: OpState): void {
    this.sessions.set(userId, { at: Date.now(), op });
  }

  /**
   * 认「要看/要找」这类入口。返回 null 表示这句不是在要目录。
   *
   * ⚠️ 只认明确说法（「操作目录」「看 orders」「找 退款」），不做模糊猜测：
   *    把「给量子大厦排套餐」误认成「找端点」会让常用路径变慢，得不偿失。
   */
  private matchCatalogEntry(
    text: string,
    tier: Tier,
  ):
    | { kind: 'modules' }
    | { kind: 'module'; module: string }
    | { kind: 'search'; kw: string }
    | null {
    const t = text.trim();

    if (
      /^(操作目录|功能目录|全部功能|所有功能|后台功能|功能清单|能干哪些|能做哪些|有哪些功能)$/.test(
        t,
      )
    )
      return { kind: 'modules' };

    const look = /^(?:看|查看|列出|打开)\s*([a-zA-Z\u4e00-\u9fa5_-]+)$/.exec(t);
    if (look) {
      const key = look[1];
      // 英文模块名直接命中就用模块；否则当关键词搜（「看 订单」）
      if (modules(tier).some((m) => m.module === key)) return { kind: 'module', module: key };
      return { kind: 'search', kw: key };
    }

    const s = /^(?:找|搜索|搜|查功能)\s*(.+)$/.exec(t);
    if (s) return { kind: 'search', kw: s[1].trim() };

    return null;
  }

  private openCatalog(
    userId: string,
    cat: { kind: 'modules' } | { kind: 'module'; module: string } | { kind: 'search'; kw: string },
    tier: Tier,
  ): string {
    if (cat.kind === 'modules') {
      const ms = modules(tier);
      const total = allItems().length;
      const usable = allItems().filter((i) => canExec(tier, i.entry).ok).length;
      const cells = ms.map((m) => `${m.module}(${m.allowed}/${m.total})`);
      const rows: string[] = [];
      for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3).join(' · '));
      return [
        `后台一共 ${total} 项能力，你（${TIER_LABEL[tier]}）能直接用 ${usable} 项。`,
        `括号里是「你能用 / 全部」。`,
        '',
        ...rows,
        '',
        '说「看 orders」看明细；说「找 退款」直接搜。选中后我只问缺的参数。',
      ].join('\n');
    }

    if (cat.kind === 'module') {
      const items = itemsOfModule(cat.module, tier, true);
      if (items.length === 0)
        return `「${cat.module}」里没有你能直接做的操作。换别的模块，或让负责人放权。`;
      // ⚠️ 必须把候选写进会话，否则他回「1」时无处可选 —— 现象是「现在没有等你确认的事」
      this.putOp(userId, { code: '', params: {}, options: items, picking: 'op' });
      return this.optionLines(`「${cat.module}」里你能做的（回数字选）：`, items, tier);
    }

    const hits = search(cat.kw, tier, 8);
    if (hits.length === 0)
      return [
        `没找到和「${cat.kw}」相关的操作。`,
        '可以发「操作目录」看有哪些模块，或者换个说法（比如「退款」「套餐」「团长」）。',
      ].join('\n');
    this.putOp(userId, { code: '', params: {}, options: hits, picking: 'op' });
    return this.optionLines(`找到 ${hits.length} 个（回数字选）：`, hits, tier);
  }

  private optionLines(head: string, items: CatalogItem[], tier: Tier): string {
    const lines = [head];
    items.forEach((it, i) => {
      const perm = canExec(tier, it.entry);
      const risk = RISK_LABEL[riskOf(it.entry)];
      const tag = perm.ok ? risk : '不可用';
      lines.push(`${i + 1}. ${displayName(it.entry)}  [${tag}]`);
    });
    lines.push('');
    lines.push('回数字选一项；要停就回「取消」。');
    return lines.join('\n');
  }

  /** op 状态下的这一句怎么处理；返回 null 表示交回正常意图识别 */
  private async handleOp(
    userId: string,
    text: string,
    op: OpState,
    binding: Binding,
    tier: Tier,
  ): Promise<string | null> {
    // 候选列表里回数字
    if (op.options?.length && /^\d{1,2}$/.test(text)) {
      const chosen = op.options[Number(text) - 1];
      if (!chosen) return `只有 ${op.options.length} 个，回 1 到 ${op.options.length}。`;
      return this.beginOp(userId, chosen, binding, tier);
    }

    // 正问着某个参数：这句话就是值
    if (op.asking) return this.applyParamValue(userId, op, text, binding, tier);

    return null;
  }

  /** 选中一个端点：只读的直接查，写入的逐个问必填参数 */
  private async beginOp(
    userId: string,
    item: CatalogItem,
    binding: Binding,
    tier: Tier,
  ): Promise<string> {
    const perm = canExec(tier, item.entry);
    if (!perm.ok)
      return `「${displayName(item.entry)}」你现在做不了：\n${perm.reason || '权限不足'}`;

    const op: OpState = { code: item.code, params: {}, options: undefined, picking: undefined };

    if (item.entry.method === 'GET') {
      // 只读：可选筛选一律先不填，直接查了给他看
      this.sessions.delete(userId);
      const res = await this.proxy.execCatalog(item.code, {}, binding, displayName(item.entry));
      if (res.code !== 0) return `没查到：${chatErrorText(res.code, res.message)}`;
      return `「${displayName(item.entry)}」的结果：\n${this.summarizeResult(res.data)}`;
    }

    const ask = this.askNext(op);
    if (ask) {
      this.putOp(userId, op);
      return ask;
    }
    this.putOp(userId, op);
    return this.opDraftCard(op, tier);
  }

  /** 问下一个还没填的必填参数；都齐了返回 null */
  private askNext(op: OpState): string | null {
    const item = find(op.code);
    if (!item) return null;

    const next = item.entry.params.find((p) => p.required && p.name !== '*' && !op.params[p.name]);
    if (next) {
      op.asking = next.name;
      const hint = next.hint ? `\n（${next.hint.slice(0, 100)}）` : '';
      // 这里刻意不写「回 2 取消」：填参数时纯数字是值，写 2 会让人以为不能填 2
      return `「${displayName(item.entry)}」还需要：${next.name}${hint}\n直接回值就行；要停就回「取消」。`;
    }

    // 入参 DTO 没解析出字段的端点：只能收一整段 JSON
    if (item.entry.params.some((p) => p.name === '*' && p.required) && !op.params.__raw) {
      op.asking = '__raw';
      return [
        `「${displayName(item.entry)}」要一整段参数（后台没把字段逐个标出来）。`,
        '把参数按 {"字段":"值"} 发给我；不确定就先回「取消」。',
      ].join('\n');
    }

    return null;
  }

  private async applyParamValue(
    userId: string,
    op: OpState,
    text: string,
    binding: Binding,
    tier: Tier,
  ): Promise<string> {
    const v = text.trim();
    if (op.asking) op.params[op.asking] = v;
    op.asking = undefined;

    if (op.params.__raw) {
      try {
        JSON.parse(op.params.__raw);
      } catch {
        op.asking = '__raw';
        this.putOp(userId, op);
        return '这段不是合法 JSON（比如少了引号或括号）。再发一次，或回 2 取消。';
      }
    }

    const ask = this.askNext(op);
    this.putOp(userId, op);
    if (ask) return ask;
    return this.opDraftCard(op, tier);
  }

  private opDraftCard(op: OpState, tier: Tier): string {
    const item = find(op.code);
    if (!item) return '这个操作找不到了。发「操作目录」重来。';
    const perm = canExec(tier, item.entry);

    const lines = ['我准备这么办：'];
    lines.push(`· 动作：${displayName(item.entry)}`);
    lines.push(`· 接口：${item.entry.method} ${item.entry.path}`);
    const kv = Object.entries(op.params)
      .filter(([k]) => k !== '__raw')
      .map(([k, v]) => `${k}=${v}`);
    lines.push(`· 参数：${kv.length ? kv.join('  ') : '（无）'}`);
    if (op.params.__raw) lines.push(`· 参数：${op.params.__raw.slice(0, 200)}`);
    lines.push(`· 影响：${RISK_LABEL[riskOf(item.entry)]}`);
    if (!perm.ok) {
      lines.push('');
      lines.push(`⚠️ 你做不了这一项：${perm.reason || '权限不足'}`);
      lines.push('发「操作目录」换个功能，或让负责人来执行。');
      return lines.join('\n');
    }
    lines.push('');
    lines.push('回 1 执行；回 2 取消。');
    return lines.join('\n');
  }

  private async execOp(userId: string, op: OpState, binding: Binding, nl: string): Promise<string> {
    const item = find(op.code);
    this.sessions.delete(userId);
    if (!item) return '这个操作找不到了。发「操作目录」重来。';

    const res = await this.proxy.execCatalog(op.code, op.params, binding, nl);
    if (res.code === 0) {
      return `办好了：${displayName(item.entry)}\n${this.summarizeResult(res.data)}`;
    }
    return `没成功：${chatErrorText(res.code, res.message)}\n（${item.entry.method} ${item.entry.path}）`;
  }

  /** 通用出参说人话：能认出的关键字段点名，认不出就给截断 JSON 并指路 */
  private summarizeResult(data: unknown): string {
    if (data == null) return '（后台没有返回内容，通常是成功但无回执）';
    if (typeof data !== 'object') return String(data).slice(0, 300);

    const d = data as Record<string, unknown>;
    const bits: string[] = [];
    for (const k of ['id', 'orderNo', 'status', 'totalCount', 'count', 'ok', 'tier']) {
      if (d[k] != null) bits.push(`${k}=${String(d[k])}`);
    }
    if (Array.isArray(data)) {
      const arr = data as unknown[];
      const first = arr[0];
      const sample =
        first && typeof first === 'object'
          ? JSON.stringify(first).slice(0, 200)
          : String(first).slice(0, 200);
      return `${arr.length} 条。第一条：${sample}`;
    }
    if (bits.length) return bits.join(' · ');
    const s = JSON.stringify(d);
    return s.length > 600 ? s.slice(0, 600) + '…（更长的结果去后台看）' : s;
  }

  // ---------------------------------------------------------------- 排套餐

  private async startAssign(
    userId: string,
    text: string,
    date: string | null,
    now: Date,
    seed?: Draft,
  ): Promise<string> {
    // 沿用上一轮已认出的字段（「换成 B 套餐」这类补充说明不该让他把楼再说一遍）。
    // 安全前提：草稿**必须**回 1 才执行，所以沿用不会造成「没说就改了」。
    const draft: Draft = {
      groupId: seed?.groupId,
      groupName: seed?.groupName,
      via: seed?.via,
      buildingName: seed?.buildingName,
      mealId: seed?.mealId,
      mealName: seed?.mealName,
      mealPriceFen: seed?.mealPriceFen,
      date: date ?? seed?.date,
    };

    const g = await this.resolver.resolveGroupFromSentence(text);
    const gMsg = await this.applyGroup(draft, g);

    const m = await this.resolver.resolveMealFromSentence(text);
    const mMsg = this.applyMeal(draft, m);

    // 优先级：先定楼（最容易认错），再定套餐，最后定日期
    if (gMsg) {
      this.putSession(userId, draft);
      return gMsg;
    }
    if (mMsg) {
      this.putSession(userId, draft);
      return mMsg;
    }
    if (!draft.date) {
      this.putSession(userId, draft);
      return this.askDate();
    }

    this.putSession(userId, draft);
    return this.draftCard(draft, now);
  }

  /** 哪天？
   *
   * ⚠️ 刻意**不用**「回 1 = 今天，2 = 明天」的数字菜单：
   *    1/2 在本流程里已经是「确认 / 取消」，同一个数字两种含义，
   *    他按提示回 1 会被当成确认执行（而那天还没定）—— 这类歧义不能留。
   */
  private askDate(): string {
    return '哪天？说「今天」「明天」或具体日期（如 11-05）。';
  }

  /**
   * 用他这一句去补草稿里缺的字段（补到就回话，补不到返回 null 交给意图识别）
   *
   * 为什么需要：流程是「问一句 → 他答一句」，而他的回答往往是**光秃秃的实体**
   * （「明天」「A 套餐」「量子大厦 A 座」）。这些单独看不是指令：
   * 交给意图识别会得到「没听准」，或者更糟 —— 把「A 套餐」当成一条新指令，
   * 于是又问一遍「哪一栋？」，他把说过的话再说一遍，体验就散了。
   */
  private async fillDraft(
    userId: string,
    d: Draft,
    text: string,
    now: Date,
  ): Promise<string | null> {
    let changed = false;

    if (!d.mealId && /套餐/.test(text)) {
      const m = await this.resolver.resolveMealFromSentence(text);
      if (m.kind !== 'none') {
        const msg = this.applyMeal(d, m);
        if (msg) {
          this.putSession(userId, d);
          return msg;
        }
        changed = true;
      }
    }

    if (!d.groupId) {
      const g = await this.resolver.resolveGroupFromSentence(text);
      if (g.kind !== 'none') {
        const msg = await this.applyGroup(d, g);
        if (msg) {
          this.putSession(userId, d);
          return msg;
        }
        changed = true;
      }
    }

    if (!d.date) {
      const pd = parseMealDate(text, now);
      if (pd.explicit && pd.date) {
        d.date = pd.date;
        changed = true;
      }
    }

    if (!changed) return null;
    this.putSession(userId, d);
    if (!d.groupId) return this.askMissing(d);
    if (!d.mealId) return this.askMealHint();
    if (!d.date) return this.askDate();
    return this.draftCard(d, now);
  }

  /** 把楼群解析结果填进草稿；需要他选/没认到时返回提示语，成功则返回 null */
  private async applyGroup(draft: Draft, g: GroupResolve): Promise<string | null> {
    if (g.kind === 'hit') {
      draft.groupId = g.groupId;
      draft.groupName = g.groupName;
      draft.via = g.via;
      draft.buildingName = g.buildingName;
      return null;
    }
    if (g.kind === 'many') {
      draft.options = g.options;
      draft.picking = 'group';
      return this.optionList('哪一栋？回数字：', g.options);
    }
    // none：给全部楼群候选，别让他空手
    const all = await this.resolver.listGroups();
    const options = (all ?? []).slice(0, 6).map((x) => ({ id: x.id, label: x.name }));
    if (options.length === 0)
      return '我没认出是哪栋楼，而且一时拉不到楼栋清单。稍后再试，或让负责人看看后台。';
    draft.options = options;
    draft.picking = 'group';
    return this.optionList('没认出是哪一栋，你回个数字：', options);
  }

  private applyMeal(draft: Draft, m: ItemResolve): string | null {
    if (m.kind === 'hit') {
      draft.mealId = m.id;
      draft.mealName = m.name;
      draft.mealPriceFen = m.priceFen;
      return null;
    }
    if (m.kind === 'many') {
      draft.options = m.options;
      draft.picking = 'meal';
      return this.optionList('哪个套餐？回数字：', m.options);
    }
    return '哪个套餐？说个名字，比如「A 套餐」。';
  }

  /** 他回了一个数字 */
  private async pick(
    userId: string,
    draft: Draft,
    n: number,
    binding: Binding,
    now: Date,
  ): Promise<string> {
    const options = draft.options ?? [];
    const chosen = options[n - 1];
    if (!chosen) {
      return `只有 ${options.length} 个，回 1 到 ${options.length} 之间的数字。`;
    }

    if (draft.picking === 'group') {
      draft.groupId = chosen.id;
      draft.groupName = chosen.label;
      draft.via = 'group';
      draft.options = undefined;
      draft.picking = undefined;
      if (!draft.mealId) {
        this.putSession(userId, draft);
        return this.askMealHint();
      }
    } else if (draft.picking === 'meal') {
      draft.mealId = chosen.id;
      draft.mealName = chosen.label;
      draft.options = undefined;
      draft.picking = undefined;
    }

    if (!draft.date) {
      this.putSession(userId, draft);
      return this.askDate();
    }

    this.putSession(userId, draft);
    return this.draftCard(draft, now);
  }

  private askMealHint(): string {
    return '哪个套餐？说个名字，比如「A 套餐」。';
  }

  private askMissing(d: Draft): string {
    if (!d.groupId) return '还差哪一栋楼。';
    if (!d.mealId) return '还差哪个套餐。';
    if (!d.date) return '还差日期。';
    return '';
  }

  private optionList(head: string, options: { id: number; label: string }[]): string {
    return [head, ...options.map((o, i) => `${i + 1}. ${o.label}`)].join('\n');
  }

  private draftCard(d: Draft, now: Date): string {
    const lines = ['我准备这么办：'];
    const viaNote =
      d.via === 'building' && d.buildingName
        ? `（你说的是「${d.buildingName}」，它属于「${d.groupName}」；一个楼群一天只排一个套餐，所以排的是整个楼群）`
        : '';
    lines.push(`· 楼群：${d.groupName}${viaNote}`);
    const price = d.mealPriceFen != null ? `，¥${(d.mealPriceFen / 100).toFixed(2)}/份` : '';
    lines.push(`· 套餐：${d.mealName}${price}`);
    lines.push(`· 日子：${d.date ? dateLabel(d.date, now) : '未定'}`);
    lines.push('');
    lines.push('回 1 我就办；回 2 取消。');
    return lines.join('\n');
  }

  /**
   * 真去排：**建分配 → 再上架**，两步都不能省
   *
   * ⚠️ 只建分配（D2）建出来是 `pending`，用户端 `canOrder=false` ——
   *    也就是「后台看得到、手机上买不到」。必须再调 D4 `publish` 才真的开团。
   *    只调第一步而回一句「已排上」，是**谎报成功**，代价是整栋楼第二天没饭吃。
   *
   * ⚠️ 已过截单（出餐日 0 点）就先拦下、不建行：建了也只是 pending，
   *    用户端照样下不了单，只会在后台留一条让人困惑的记录。
   */
  private async execAssign(
    userId: string,
    d: Draft,
    binding: Binding,
    nl: string,
    now: Date,
  ): Promise<string> {
    const date = String(d.date);
    this.sessions.delete(userId);

    if (isAfterCutoff(date, now)) {
      return `${dateLabel(date, now)} 已经截单了（出餐日 0 点截单，也就是前一天夜里 24 点）。\n这天排不了，换一天吧。`;
    }

    const created = await this.proxy.exec(
      'assign_meal',
      {
        mealDate: date,
        buildingGroupId: String(d.groupId),
        setMealId: String(d.mealId),
      },
      binding,
      nl,
    );
    this.resolver.invalidate();

    if (created.code !== 0) {
      return `没排上：${chatErrorText(created.code, created.message)}`;
    }

    const raw = (created.data ?? {}) as Record<string, unknown>;
    const idNum = Number(raw.id ?? raw.assignmentId ?? NaN);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      return `分配建好了，但后台没回执 id，我不敢往下上架 —— 请让负责人在后台看一眼「${d.groupName} ${dateLabel(date, now)}」。`;
    }

    const pub = await this.proxy.exec(
      'publish_assignment',
      { id: String(idNum), action: 'publish' },
      binding,
      nl,
    );
    if (pub.code !== 0) {
      return [
        `「${d.groupName}」的分配建好了（#${idNum}），但**上架没成功**：${chatErrorText(pub.code, pub.message)}`,
        '现在手机上还买不到，请让负责人在后台点一下上架。',
      ].join('\n');
    }

    const isTomorrow = dateLabel(date, now).startsWith('明天');
    return [
      `办好了：${d.groupName} 已排上「${d.mealName}」，${dateLabel(date, now)}，用户现在能下单。`,
      isTomorrow ? '今晚 24 点前还能改。' : '',
      '要改就再说一句，我会重新问你。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---------------------------------------------------------------- 查数

  private async queryOrders(date: string | null, binding: Binding, now: Date): Promise<string> {
    const res = await this.proxy.query('q_orders', date ? { date } : {}, binding);
    if (res.code !== 0) return `没查到：${chatErrorText(res.code, res.message)}`;

    const day = date ? dateLabel(date, now) : '今天';
    const said = summarizeOrderData(res.data);
    if (!said) {
      // 拉到了但结构不认识：把人话退一步，不编数字
      return `${day}的查询有返回，但我没能把结果说成人话。请让负责人在后台看一眼，或把这条报给技术。`;
    }
    return `${day}：${said}。`;
  }

  private async queryMyRequests(binding: Binding): Promise<string> {
    const res = await this.proxy.query('q_my_requests', {}, binding);
    if (res.code !== 0) return `没查到：${chatErrorText(res.code, res.message)}`;

    const data = res.data;
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { list?: unknown[] })?.list)
        ? ((data as { list: unknown[] }).list as unknown[])
        : [];
    if (list.length === 0) return '你现在没有待审批或待执行的申请。';

    const lines = list.slice(0, 5).map((raw) => {
      const r = raw as Record<string, unknown>;
      const id = r.id ?? r.requestId ?? '-';
      const status = String(r.status ?? r.statusText ?? '状态未知');
      const op = String(r.opCode ?? r.op ?? '');
      return `· #${id}  ${op}  ${status}`;
    });
    return ['你提交的申请：', ...lines].join('\n');
  }
}
