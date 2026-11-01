import { Injectable, Logger } from '@nestjs/common';
import { isAfterCutoff } from '../../common/utils/time';
import { OpProxyService, Binding } from './op-proxy.service';
import { NameResolverService, GroupResolve, ItemResolve } from './name-resolver.service';
import { bjYmdPlus, parseMealDate } from './name-match';
import {
  parseIntent,
  isConfirm,
  isCancel,
  chatErrorText,
  summarizeOrderData,
  CHAT_HELP,
  CHAT_FALLBACK,
  CHAT_NEGATED,
} from './chat-flow';

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

    // 「2 / 取消」先处理：任何时候都能撤销，且不受会话是否过期影响
    if (isCancel(text)) {
      this.sessions.delete(userId);
      return '好，什么都没动。';
    }

    const session = this.getSession(userId);

    // 回数字：从候选里挑
    if (session?.draft?.options?.length && /^\d{1,2}$/.test(text)) {
      return this.pick(userId, session.draft, Number(text), binding, now);
    }

    // 回 1 / 确认：执行草稿
    if (isConfirm(text)) {
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
