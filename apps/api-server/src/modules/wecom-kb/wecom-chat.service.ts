import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'path';
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
  codeOfPath,
  displayName,
  find,
  isGranted,
  itemsOfModule,
  modules,
  riskOf,
  search,
  usableCount,
  RISK_LABEL,
  TIER_LABEL,
  type CatalogItem,
  type Tier,
} from './op-policy';
import { lookupQuery } from './op-meta';
import {
  bjTodayStr,
  endDateOf,
  parseStatsIntent,
  prevEndDateOf,
  type StatsIntent,
} from './stats-intent';
import {
  summarizeBuildingRank,
  summarizeDashboard,
  summarizeDishHeat,
  summarizePageDuration,
  summarizeRetention,
  compareDashboard,
} from './stats-summary';
import { summarizeData } from './result-summary';
import { callLLM, retrieveKB, isLlmAssistEnabled } from './llm.adapter';

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

/**
 * 统计视角 → 查询码。
 *
 * ⚠️ 只此一份：判权（`statsDenied`）与取数（`replyStats`）都用它，
 *    两处各写一份的话，改了视角名就会出现「拦的是 A、查的是 B」。
 */
const STATS_QCODE: Record<StatsIntent['which'], string> = {
  dashboard: 'q_stats_dashboard',
  buildingRank: 'q_building_rank',
  dishHeat: 'q_dish_heat',
  retention: 'q_stats_retention',
  pageDuration: 'q_stats_page_duration',
};

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
    // 单独放权的端点清单（只对同事有意义）：展示层与执行层必须用**同一份**清单，
    // 否则会出现「目录里看不到、却能用」或者「目录里看得到、点了说没权限」两种更糟的错。
    const granted = binding.grantedOps ?? [];

    // ── 通用操作通道（覆盖后台全部功能）──────────────────────
    // 优先级最高：一旦进了「选功能 / 填参数」状态，这一句就是参数值或序号，
    // 不能被当成新的排套餐请求（否则他刚填的楼名会被丢掉重问）。
    if (session?.op) {
      const handled = await this.handleOp(userId, text, session.op, binding, tier);
      if (handled !== null) return handled;
    }
    // ── 统计问句（必须早于 matchCatalogEntry）──────────────
    // 那条 /^(?:看|查看|列出|打开)\s*(.+)$/ 会把「看经营数据」当成「搜端点：经营数据」，
    // 而目录里没有这个模块 ⇒ 回「没找到」。顺序错了的现象是「这个功能做了但用不出来」。
    const stats = parseStatsIntent(text);
    if (stats) return this.replyStats(stats, binding, now);

    const cat = this.matchCatalogEntry(text, tier, granted);
    if (cat) return this.openCatalog(userId, cat, tier, granted);

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
      case 'genCampaign':
        return this.genCampaign(intent.brief);
      case 'genDailyReport':
        return this.genDailyReport(binding, now);
      case 'genMealProposal':
        return this.genMealProposal(binding, now);
      case 'genRecruitProposal':
        return this.genRecruitProposal(binding, now);
      case 'genCouponStrategy':
        return this.genCouponStrategy(binding, now);
      default:
        return this.maybeLLMReply(text, binding);
    }
  }

  /**
   * LLM 增强兜底：仅在「规则/意图都未命中」时尝试 LLM 应答。
   * 关闭 / 未激活 / 超时 / 异常 → 退回 CHAT_FALLBACK（与未接 LLM 的线上行为完全一致）。
   * 这一层是「可剥离」的：删除 llm.adapter 或设 LLM_ASSIST_ENABLED=false，行为退回规则驱动。
   */
  private async maybeLLMReply(text: string, _binding: Binding): Promise<string> {
    if (!isLlmAssistEnabled()) return CHAT_FALLBACK;
    try {
      const kb = await retrieveKB(text);
      const answer = await callLLM(text, kb);
      if (answer) return answer;
    } catch {
      // callLLM 已自捕；此处再兜一层，确保绝不把异常抛到消息回路之外
    }
    return CHAT_FALLBACK;
  }

  /**
   * AI 编排节点 B · 文案与素材生成（企微触发）
   * ------------------------------------------------------------------
   * 同事在企微发「生成招募页 <需求>」即触发：spawn 独立脚本 `gen-campaign.mjs` 起草文案与海报。
   *
   * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
   *   · 本方法是「纯增量」—— 只新增分支，不动订单/支付/配送核心，也不碰确定性问答逻辑；
   *   · 脚本本身是独立文件（scripts/gen-campaign.mjs），删掉/关掉即退回「手工写文案」传统路径；
   *   · 全程包在 try/finally + 超时里：脚本启动失败 / 超时 / 异常 → 立刻回退一句提示，
   *     绝不把异常抛到消息回路之外、绝不阻塞应答；
   *   · 脚本只产出草稿文件（releases/campaign/<slug>/），由人工终审后再发布，不自动上线。
   */
  private genCampaign(brief: string): Promise<string> {
    const needBrief =
      '要生成招募页，请告诉我这次推什么。例如：\n生成招募页 双十一暖冬团，推热饮+点心组合，招募一栋写字楼团长';
    if (!brief || !brief.trim()) return Promise.resolve(needBrief);

    const repoRoot = this.resolveRepoRoot();
    const script = join(repoRoot, 'scripts', 'gen-campaign.mjs');
    if (!existsSync(script)) {
      return Promise.resolve(
        '招募页生成脚本未找到（scripts/gen-campaign.mjs）。请确认部署包完整，或走手工写文案路径。',
      );
    }

    const slug = 'wx_' + Date.now();
    return new Promise<string>((resolve) => {
      let settled = false;
      const finish = (msg: string): void => {
        if (!settled) {
          settled = true;
          resolve(msg);
        }
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('node', [script, '--brief', brief, '--slug', slug], {
          cwd: repoRoot,
          env: { ...process.env },
        });
      } catch (e) {
        finish(
          `生成任务启动失败：${e instanceof Error ? e.message : String(e)}。可走手工写文案路径。`,
        );
        return;
      }

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* noop */
        }
        finish(
          `生成超时（>90s），可能 LLM 较慢或暂不可用。文件若已生成，在 releases/campaign/${slug}/ 下查看；否则请稍后重试或手工运行脚本。`,
        );
      }, 90_000);

      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('error', (e) =>
        finish(`生成任务出错：${e instanceof Error ? e.message : String(e)}。可走手工写文案路径。`),
      );
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          finish(
            `招募文案与素材已生成（AI 草稿，请人工终审后再发布）：\nreleases/campaign/${slug}/\n· copy.md（招募/朋友圈/社群文案）\n· poster.html（品牌招募页）\n· poster.svg（移动端海报）\n\n要再来一份，直接发「生成招募页 <需求>」。`,
          );
        } else {
          finish(
            `生成未成功（退出码 ${code}）。${stderr ? '\n' + stderr.slice(0, 400) : ''}\n传统手工写文案路径不受影响，可稍后重试。`,
          );
        }
      });
    });
  }

  /**
   * AI 编排节点 E · 运营日报（企微触发）
   * ------------------------------------------------------------------
   * 同事在企微发「生成今日日报」即触发：本方法先用 proxy.query 取近 7 天四视角数据
   * （经营看板/楼栋排行/菜品热度/留存，看板与排行附带上一档环比），复用 stats-summary
   * 的纯函数格式化成「人话」，再交给 `gen-daily-report.mjs` 做 AI 归因摘要 + 落盘。
   *
   * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
   *   · 全段包在大 try 内，且每个视角取数各自 try/catch：任一视角失败只跳过该段，不整机失败；
   *   · 脚本缺失/启动失败/超时/异常 → 降级为「直接回显原始数据」，不阻塞应答；
   *   · 不碰订单/支付/配送核心，纯只读聚合；
   *   · 触发方式为企微命令（非定时任务），符合「祝总禁自动任务」约束，后续放开后再接每日定时。
   */
  private genDailyReport(binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      const today = bjTodayStr(now);
      if (!today) return '取不到今天的日期，我先不动。稍后再试。';

      const base = {
        which: 'dashboard' as const,
        range: '7d' as const,
        endShift: -1,
      } as StatsIntent;
      const endDate = endDateOf(base, today);
      const prevEnd = prevEndDateOf(base, endDate);

      const sections: string[] = [];

      // 1. 经营看板（含环比）
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.dashboard,
          { range: '7d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const head = summarizeDashboard(cur.data);
          if (head) {
            const prev = await this.proxy.query(
              STATS_QCODE.dashboard,
              { range: '7d', date: prevEnd },
              binding,
            );
            const cmp = prev.code === 0 ? compareDashboard(cur.data, prev.data) : [];
            sections.push([head, ...cmp].join('\n'));
          }
        }
      } catch {
        /* 该视角跳过 */
      }

      // 2. 楼栋排行（含环比点名）
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.buildingRank,
          { range: '7d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const prev = await this.proxy.query(
            STATS_QCODE.buildingRank,
            { range: '7d', date: prevEnd },
            binding,
          );
          const txt = summarizeBuildingRank(cur.data, prev.code === 0 ? prev.data : null);
          if (txt) sections.push(txt);
        }
      } catch {
        /* 该视角跳过 */
      }

      // 3. 菜品热度
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.dishHeat,
          { range: '7d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const txt = summarizeDishHeat(cur.data);
          if (txt) sections.push(txt);
        }
      } catch {
        /* 该视角跳过 */
      }

      // 4. 留存
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.retention,
          { range: '7d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const txt = summarizeRetention(cur.data);
          if (txt) sections.push(txt);
        }
      } catch {
        /* 该视角跳过 */
      }

      if (sections.length === 0)
        return '近 7 天经营数据这次没取到（可能权限不足或数据还没生成）。可在后台看板查看，或稍后重试。';

      const plain = sections.join('\n\n');

      // 写临时数据文件，交给脚本做 AI 摘要 + 落盘
      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_in_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `运营日报数据已生成，但写入临时文件失败（磁盘权限）。可在后台看板查看原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-daily-report.mjs');
      if (!existsSync(script)) {
        // 脚本缺失：降级为「直接回显原始数据」，不依赖 AI
        return `运营日报（原始数据，AI 摘要脚本未找到）：\n\n${plain}`;
      }

      return new Promise<string>((resolve) => {
        let settled = false;
        const finish = (m: string): void => {
          if (!settled) {
            settled = true;
            resolve(m);
          }
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('node', [script, '--plain-file', plainFile], {
            cwd: repoRoot,
            env: { ...process.env },
          });
        } catch (e) {
          finish(
            `日报生成启动失败：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          );
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('日报生成超时（>90s）。原始数据已在后台看板，可稍后重试触发。');
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `日报生成出错：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          if (out.trim()) finish(out.trim());
          else
            finish(
              `日报生成未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n可在后台看板查看原始数据。`,
            );
        });
      });
    };
    return run();
  }

  /**
   * AI 编排节点 F · 选品提案（企微触发）
   * ------------------------------------------------------------------
   * 同事发「生成选品提案」即触发：本方法先用 proxy.query 取近 30 天两视角
   * （菜品热度/楼栋排行），再用 `resolver.listTemplatesFull()` 取**全量套餐目录**
   * （含菜品构成、状态、被排次数），拼成结构化纯文本，交给 `gen-meal-proposal.mjs`
   * 做 AI 选品提案（留用/试水/观察）+ 落盘。
   *
   * 与节点 E 完全相同的原则零保障：全段包 try、各视角独立 try/catch；脚本缺失/超时/
   * 异常 → 降级为「直接回显原始数据」；纯只读聚合，不碰订单/支付/配送核心；
   * 触发方式为企微命令（非定时任务），符合「祝总禁自动任务」约束。
   *
   * ⚠️ 与 E 的唯一差异：多取一份「套餐目录全量」。E 只用聚合视图，
   *   而选品提案必须知道「有哪些套餐可选、各自含什么菜、被排过几次」才能给建议 ——
   *   这份数据来自既有的 `/admin/meal/templates` 列表端点，未新建任何查询接口。
   */
  private genMealProposal(binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      const today = bjTodayStr(now);
      if (!today) return '取不到今天的日期，我先不动。稍后再试。';

      const base = {
        which: 'dashboard' as const,
        range: '30d' as const,
        endShift: -1,
      } as StatsIntent;
      const endDate = endDateOf(base, today);

      const sections: string[] = [];

      // 1. 菜品热度（30d）
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.dishHeat,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const txt = summarizeDishHeat(cur.data);
          if (txt) sections.push(txt);
        }
      } catch {
        /* 该视角跳过 */
      }

      // 2. 楼栋排行（30d，无环比）
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.buildingRank,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const txt = summarizeBuildingRank(cur.data, null);
          if (txt) sections.push(txt);
        }
      } catch {
        /* 该视角跳过 */
      }

      // 3. 套餐目录全量（含菜品构成 / 状态 / 被排次数）
      const catalogLines: string[] = [];
      try {
        const tpls = await this.resolver.listTemplatesFull();
        if (tpls && tpls.length) {
          catalogLines.push(`可选套餐目录（共 ${tpls.length} 个，含状态 / 被排次数 / 菜品构成）：`);
          for (const t of tpls) {
            const price =
              typeof t.priceFen === 'number'
                ? `¥${((t.priceFen as number) / 100).toFixed(2)}`
                : '?';
            const status = t.status === 1 ? '启用' : '停用';
            const dishes =
              (t.items ?? [])
                .map((i) => (typeof i.name === 'string' ? i.name : `#${i.itemId}`))
                .join('、') || '（无菜品）';
            const used = typeof t.usedCount === 'number' ? (t.usedCount as number) : 0;
            const cnt =
              typeof t.itemCount === 'number' ? (t.itemCount as number) : (t.items ?? []).length;
            catalogLines.push(
              `· ${t.name ?? '?'} (#${t.id}) ${price} [${status}] 被排${used}次 含${cnt}品：${dishes}`,
            );
          }
        }
      } catch {
        /* 目录取不到则跳过，仍给出已有视角 */
      }

      if (sections.length === 0 && catalogLines.length === 0)
        return '近 30 天销售数据与套餐目录这次都没取到（可能权限不足或数据还没生成）。可在后台看板查看，或稍后重试。';

      const plain = [...sections, ...catalogLines].join('\n\n');

      // 写临时数据文件，交给脚本做 AI 提案 + 落盘
      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_mp_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `选品提案数据已生成，但写入临时文件失败（磁盘权限）。可在后台看板查看原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-meal-proposal.mjs');
      if (!existsSync(script)) {
        // 脚本缺失：降级为「直接回显原始数据」，不依赖 AI
        return `选品提案（原始数据，AI 脚本未找到）：\n\n${plain}`;
      }

      return new Promise<string>((resolve) => {
        let settled = false;
        const finish = (m: string): void => {
          if (!settled) {
            settled = true;
            resolve(m);
          }
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('node', [script, '--plain-file', plainFile], {
            cwd: repoRoot,
            env: { ...process.env },
          });
        } catch (e) {
          finish(
            `选品提案生成启动失败：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          );
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('选品提案生成超时（>90s）。原始数据已在后台看板，可稍后重试触发。');
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `选品提案生成出错：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          if (out.trim()) finish(out.trim());
          else
            finish(
              `选品提案生成未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n可在后台看板查看原始数据。`,
            );
        });
      });
    };
    return run();
  }

  /**
   * AI 编排节点 G · 团长智能招募赋能（企微触发）
   * ------------------------------------------------------------------
   * 同事在企微发「生成招募提案」即触发：取「近 30 天有订单楼栋」与「在职团长覆盖楼」做差集，
   * 算出**招募缺口**，再 spawn 独立脚本 `gen-recruit-proposal.mjs` 产出招募优先级 + 话术草稿 + 新人赋能要点。
   *
   * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
   *   · 纯增量分支，不动订单/支付/配送核心，也不碰确定性问答逻辑；
   *   · 取数走既有 `proxy.query(buildingRank)` + `resolver.listLeaders()`（复用已验证链路，零新增 DI 依赖）；
   *   · 两数据源各自 try/catch：任一取不到都不中断，拿得到的先算缺口；
   *   · 脚本缺失/超时/异常 → 降级回显「原始缺口数据」，绝不阻塞应答；
   *   · 只产出草稿（releases/recruit-proposal/），由人工确认后执行，不自动改任何团长/楼数据。
   */
  private genRecruitProposal(binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      const today = bjTodayStr(now);
      if (!today) return '取不到今天的日期，我先不动。稍后再试。';

      const base = {
        which: 'dashboard' as const,
        range: '30d' as const,
        endShift: -1,
      } as StatsIntent;
      const endDate = endDateOf(base, today);

      // 1. 近 30 天有订单楼栋（按 GMV）
      type Bld = { id: number; name: string; gmvFen: number; orderCount: number; gmvShare: number };
      let buildings: Bld[] = [];
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.buildingRank,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const rows = (cur.data as Record<string, unknown>)?.buildings;
          if (Array.isArray(rows)) {
            for (const r of rows) {
              const rr = r as Record<string, unknown>;
              const id = Number(rr.id);
              if (!Number.isFinite(id)) continue;
              buildings.push({
                id,
                name: typeof rr.name === 'string' && rr.name ? rr.name : `#${id}`,
                gmvFen: typeof rr.gmvFen === 'number' ? rr.gmvFen : 0,
                orderCount: typeof rr.orderCount === 'number' ? rr.orderCount : 0,
                gmvShare: typeof rr.gmvShare === 'number' ? rr.gmvShare : 0,
              });
            }
            buildings = buildings.slice(0, 20);
          }
        }
      } catch {
        /* 跳过该视角，仍可用团长覆盖判断 */
      }

      // 2. 在职团长覆盖的楼（status=1）
      const covered = new Set<number>();
      try {
        const leaders = await this.resolver.listLeaders();
        if (leaders && leaders.length) {
          for (const l of leaders) {
            const bid = Number(l.buildingId);
            if (l.status === 1 && Number.isFinite(bid)) covered.add(bid);
          }
        }
      } catch {
        /* 跳过该视角 */
      }

      if (buildings.length === 0)
        return '近 30 天楼栋销量数据这次没取到（可能权限不足或还没开团）。可在后台看板查看，或稍后重试。';

      // 3. 组装缺口分析文本（先把差集算出来，AI 只负责「说人话」）
      const lines: string[] = [];
      lines.push(`近 30 天有订单楼栋与团长覆盖（按 GMV，共取 ${buildings.length} 栋）：`);
      const gaps: Bld[] = [];
      buildings.forEach((b, i) => {
        const has = covered.has(b.id);
        if (!has) gaps.push(b);
        const gmv = `¥${(b.gmvFen / 100).toFixed(2)}`;
        const share = b.gmvShare ? ` ${(b.gmvShare * 100).toFixed(1)}%` : '';
        lines.push(
          `${i + 1}. ${b.name}  GMV ${gmv}${share} · ${b.orderCount} 单 · ${
            has ? '已有在职团长' : '【无在职团长】'
          }`,
        );
      });
      const summary = `汇总：近 30 天有订单 ${buildings.length} 栋，其中 ${
        buildings.length - gaps.length
      } 栋已有在职团长，招募缺口 ${gaps.length} 栋。`;
      lines.push('');
      lines.push(summary);
      if (gaps.length) {
        lines.push('');
        lines.push('招募缺口清单（按 GMV 降序，优先拓展这些楼）：');
        gaps.forEach((b, i) => {
          const gmv = `¥${(b.gmvFen / 100).toFixed(2)}`;
          lines.push(`${i + 1}. ${b.name}  GMV ${gmv} · ${b.orderCount} 单`);
        });
      }
      const plain = lines.join('\n');

      // 4. 写临时数据文件，交给脚本做 AI 提案 + 落盘
      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_rp_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `招募提案数据已生成，但写入临时文件失败（磁盘权限）。可在后台看板查看原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-recruit-proposal.mjs');
      if (!existsSync(script)) {
        // 脚本缺失：降级为「直接回显原始数据」，不依赖 AI
        return `招募提案（原始数据，AI 脚本未找到）：\n\n${plain}`;
      }

      return new Promise<string>((resolve) => {
        let settled = false;
        const finish = (m: string): void => {
          if (!settled) {
            settled = true;
            resolve(m);
          }
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('node', [script, '--plain-file', plainFile], {
            cwd: repoRoot,
            env: { ...process.env },
          });
        } catch (e) {
          finish(
            `招募提案生成启动失败：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          );
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('招募提案生成超时（>90s）。原始数据已在后台看板，可稍后重试触发。');
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `招募提案生成出错：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          if (out.trim()) finish(out.trim());
          else
            finish(
              `招募提案生成未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n可在后台看板查看原始数据。`,
            );
        });
      });
    };
    return run();
  }

  /**
   * 节点 H · 动态发券策略提案。
   *
   * 复用既有取数链：dashboard(30d) + retention(30d) + buildingRank(30d) + 现有券种定义，
   * 算出「用户分层（新客/沉睡可唤醒/复购）+ 楼栋表现 + 可复用券种」，
   * 再 spawn 独立脚本 `gen-coupon-strategy.mjs` 产出四类券策略 + 预算 + 确认路径。
   *
   * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
   *   · 纯增量分支，不动订单/支付/配送核心，也不碰确定性问答逻辑；
   *   · 取数走既有 `proxy.query`（复用已验证链路，零新增 DI 依赖）+ `resolver.listCouponDefs()`；
   *   · 四数据源各自 try/catch：任一取不到都不中断，拿得到的先算；
   *   · 脚本缺失/超时/异常 → 降级回显「原始数据」，绝不阻塞应答；
   *   · 只产出草稿（releases/coupon-strategy/），由人工确认后走后台批量发券（grant-batch，含 dryRun 试算）执行，绝不自动发券。
   */
  private genCouponStrategy(binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      const today = bjTodayStr(now);
      if (!today) return '取不到今天的日期，我先不动。稍后再试。';

      const base = {
        which: 'dashboard' as const,
        range: '30d' as const,
        endShift: -1,
      } as StatsIntent;
      const endDate = endDateOf(base, today);
      const fen2yuan = (fen: number): string => `¥${((fen || 0) / 100).toFixed(2)}`;

      // 取数守卫：从 unknown 安全取数字；比率 → 百分比文本
      const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      const pct = (v: number | null | undefined): string =>
        v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;

      // 1. 整体看板
      type Dash = {
        gmvFen?: number;
        orderCount?: number;
        quantity?: number;
        avgOrderAmountFen?: number;
        refundCount?: number;
        refundRate?: number;
        activeUserCount?: number;
        activeLeaderCount?: number;
        activeBuildingCount?: number;
        repeatUserCount?: number;
        repeatRate?: number;
        grossProfitFen?: number;
        commissionFen?: number;
      };
      let dash: Dash = {};
      let warnings: string[] = [];
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.dashboard,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const m = (cur.data as Record<string, unknown>)?.metrics as
            Record<string, unknown> | undefined;
          if (m)
            dash = {
              gmvFen: num(m.gmvFen),
              orderCount: num(m.orderCount),
              quantity: num(m.quantity),
              avgOrderAmountFen: num(m.avgOrderAmountFen),
              refundCount: num(m.refundCount),
              refundRate: num(m.refundRate),
              activeUserCount: num(m.activeUserCount),
              activeLeaderCount: num(m.activeLeaderCount),
              activeBuildingCount: num(m.activeBuildingCount),
              repeatUserCount: num(m.repeatUserCount),
              repeatRate: num(m.repeatRate),
              grossProfitFen: num(m.grossProfitFen),
              commissionFen: num(m.commissionFen),
            };
          const w = (cur.data as Record<string, unknown>)?.warnings;
          if (Array.isArray(w))
            warnings = w.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
        }
      } catch {
        /* 跳过该视角 */
      }

      // 2. 留存分层
      type Ret = {
        activeUserCount?: number;
        newUserCount?: number;
        returningUserCount?: number;
        repeatUserCount?: number;
        repeatRate?: number;
        cohorts?: {
          cohortStart?: string;
          newUserCount?: number;
          observable?: boolean;
          retentionRate1?: number | null;
        }[];
      };
      let ret: Ret = {};
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.retention,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const s = (cur.data as Record<string, unknown>)?.summary as
            Record<string, unknown> | undefined;
          if (s)
            ret = {
              activeUserCount: num(s.activeUserCount),
              newUserCount: num(s.newUserCount),
              returningUserCount: num(s.returningUserCount),
              repeatUserCount: num(s.repeatUserCount),
              repeatRate: num(s.repeatRate),
            };
          const cohorts = (cur.data as Record<string, unknown>)?.cohorts;
          if (Array.isArray(cohorts))
            ret.cohorts = cohorts
              .map((c) => {
                const cc = c as Record<string, unknown>;
                return {
                  cohortStart: typeof cc.cohortStart === 'string' ? cc.cohortStart : undefined,
                  newUserCount: num(cc.newUserCount),
                  observable: cc.observable === true,
                  retentionRate1: num(cc.retentionRate1),
                };
              })
              .filter((c) => c.newUserCount != null);
        }
      } catch {
        /* 跳过该视角 */
      }

      // 3. 楼栋表现
      type Bld = { id: number; name: string; gmvFen: number; orderCount: number; gmvShare: number };
      let buildings: Bld[] = [];
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.buildingRank,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const rows = (cur.data as Record<string, unknown>)?.buildings;
          if (Array.isArray(rows)) {
            for (const r of rows) {
              const rr = r as Record<string, unknown>;
              const id = Number(rr.id);
              if (!Number.isFinite(id)) continue;
              buildings.push({
                id,
                name: typeof rr.name === 'string' && rr.name ? rr.name : `#${id}`,
                gmvFen: num(rr.gmvFen) ?? 0,
                orderCount: num(rr.orderCount) ?? 0,
                gmvShare: num(rr.gmvShare) ?? 0,
              });
            }
            buildings = buildings.slice(0, 8);
          }
        }
      } catch {
        /* 跳过该视角 */
      }

      // 4. 现有券种（接地：复用而非凭空造 id）
      type Def = {
        id: number;
        name: string;
        faceValueFen: number;
        thresholdFen: number;
        validityType?: string | null;
        validDays?: number | null;
        totalLimit?: number | null;
        issuedCount?: number;
        status?: string;
      };
      let defs: Def[] = [];
      try {
        const list = await this.resolver.listCouponDefs();
        if (list && list.length)
          defs = list.map((d) => ({
            id: Number(d.id),
            name: typeof d.name === 'string' ? d.name : '未命名',
            faceValueFen: num(d.faceValueFen) ?? 0,
            thresholdFen: num(d.thresholdFen) ?? 0,
            validityType: d.validityType ?? null,
            validDays: typeof d.validDays === 'number' ? d.validDays : null,
            totalLimit: typeof d.totalLimit === 'number' ? d.totalLimit : null,
            issuedCount: typeof d.issuedCount === 'number' ? d.issuedCount : 0,
            status: d.status ?? 'unknown',
          }));
      } catch {
        /* 跳过该视角 */
      }

      // 组装纯文本（AI 只负责「说人话 + 给策略」）
      const lines: string[] = [];
      lines.push('经营与留存数据 · 近30天（按出餐日，单位已折算为元/人）');
      lines.push('');

      const d = dash;
      const dashBits: string[] = [];
      if (d.gmvFen != null) dashBits.push(`GMV ${fen2yuan(d.gmvFen)}`);
      if (d.orderCount != null) dashBits.push(`${d.orderCount} 单`);
      if (d.quantity != null) dashBits.push(`${d.quantity} 份`);
      if (d.avgOrderAmountFen != null) dashBits.push(`客单价 ${fen2yuan(d.avgOrderAmountFen)}`);
      if (d.activeUserCount != null) dashBits.push(`活跃 ${d.activeUserCount} 人`);
      if (d.activeBuildingCount != null) dashBits.push(`楼栋 ${d.activeBuildingCount}`);
      if (d.repeatUserCount != null)
        dashBits.push(
          d.repeatRate != null
            ? `复购 ${d.repeatUserCount} 人（${pct(d.repeatRate)}）`
            : `复购 ${d.repeatUserCount} 人`,
        );
      if (d.refundCount != null)
        dashBits.push(
          d.refundRate != null
            ? `退款 ${d.refundCount} 单（${pct(d.refundRate)}）`
            : `退款 ${d.refundCount} 单`,
        );
      if (dashBits.length) lines.push('【整体看板】' + dashBits.join(' · '));

      const r = ret;
      const retBits: string[] = [];
      if (r.activeUserCount != null) retBits.push(`活跃 ${r.activeUserCount} 人`);
      if (r.newUserCount != null) retBits.push(`新客 ${r.newUserCount} 人`);
      if (r.returningUserCount != null) retBits.push(`回流 ${r.returningUserCount} 人`);
      if (r.repeatUserCount != null) retBits.push(`复购 ${r.repeatUserCount} 人`);
      if (r.repeatRate != null) retBits.push(`复购率 ${pct(r.repeatRate)}`);
      if (retBits.length) lines.push('【留存分层】' + retBits.join(' · '));
      // 派生：可唤醒沉睡用户 ≈ 活跃 - 复购
      if (r.activeUserCount != null && r.repeatUserCount != null) {
        lines.push(
          `→ 可唤醒沉睡用户 ≈ 活跃 - 复购 = ${r.activeUserCount - r.repeatUserCount} 人（来过但未复购）`,
        );
      }
      if (r.cohorts && r.cohorts.length) {
        lines.push('按首单所在周分群：');
        for (const c of r.cohorts.slice(-3)) {
          const start = c.cohortStart ? c.cohortStart.slice(5) : '?';
          const cnt = c.newUserCount ?? 0;
          const tail = c.observable
            ? c.retentionRate1 != null
              ? `次周留 ${pct(c.retentionRate1)}`
              : '次周留存无法计算'
            : '窗口未走完，暂不给留存率';
          lines.push(`· ${start} 那周：新客 ${cnt} 人，${tail}`);
        }
      }

      if (buildings.length) {
        lines.push('');
        lines.push('【楼栋表现 TOP ' + buildings.length + '】');
        buildings.forEach((b, i) => {
          const bits: string[] = [];
          bits.push(fen2yuan(b.gmvFen));
          bits.push(`${b.orderCount} 单`);
          if (b.gmvShare) bits.push(pct(b.gmvShare));
          lines.push(`${i + 1}. ${b.name}  ${bits.join(' · ')}`);
        });
      }

      if (defs.length) {
        lines.push('');
        lines.push('【现有券种（可复用，勿凭空造 id）】');
        defs.forEach((c) => {
          const v =
            c.validityType === 'days' && c.validDays
              ? `领取后${c.validDays}天`
              : (c.validityType ?? '');
          const th = c.thresholdFen > 0 ? `门槛${fen2yuan(c.thresholdFen)}` : '无门槛';
          lines.push(
            `#${c.id} ${c.name} 面额${fen2yuan(c.faceValueFen)} ${th} 有效期${v || '—'} 已发${c.issuedCount ?? 0} 状态${c.status ?? '?'}`,
          );
        });
      }

      if (warnings.length) {
        lines.push('');
        lines.push('【数据提示】' + warnings.join('；'));
      }

      if (!dashBits.length && !retBits.length && !buildings.length)
        return '近 30 天经营与留存数据这次没取到（可能权限不足或还没开团）。可在后台看板查看，或稍后重试。';

      const plain = lines.join('\n');

      // 写临时数据文件，交给脚本做 AI 提案 + 落盘
      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_cs_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `发券策略数据已生成，但写入临时文件失败（磁盘权限）。可在后台看板查看原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-coupon-strategy.mjs');
      if (!existsSync(script)) {
        return `发券策略（原始数据，AI 脚本未找到）：\n\n${plain}`;
      }

      return new Promise<string>((resolve) => {
        let settled = false;
        const finish = (m: string): void => {
          if (!settled) {
            settled = true;
            resolve(m);
          }
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('node', [script, '--plain-file', plainFile], {
            cwd: repoRoot,
            env: { ...process.env },
          });
        } catch (e) {
          finish(
            `发券策略生成启动失败：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          );
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('发券策略生成超时（>90s）。原始数据已在后台看板，可稍后重试触发。');
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `发券策略生成出错：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          if (out.trim()) {
            try {
              unlinkSync(plainFile);
            } catch {
              /* noop */
            }
            finish(out.trim());
          } else
            finish(
              `发券策略生成未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n可在后台看板查看原始数据。`,
            );
        });
      });
    };
    return run();
  }

  /** 选一个可写目录放临时数据文件（与脚本侧同源逻辑）：挂载卷优先，回退 releases，再退系统临时目录 */
  private pickWritableDir(repoRoot: string): string {
    const candidates = [
      join(repoRoot, 'data', 'uploads', 'daily'),
      join(repoRoot, 'releases', 'daily'),
      join(tmpdir(), 'abox-daily'),
    ];
    for (const c of candidates) {
      try {
        mkdirSync(c, { recursive: true });
        writeFileSync(join(c, '.w'), '');
        unlinkSync(join(c, '.w'));
        return c;
      } catch {
        /* 不可写，试下一个 */
      }
    }
    return candidates[candidates.length - 1];
  }

  /**
   * 从当前模块位置推导仓库根（abox-onebox）。dist/src 路径层级一致（均 4 段到 repo root），
   * 并用 existsSync 兜底：任一候选命中脚本即采用，避免部署结构/启动 cwd 差异导致解析失败。
   */
  private resolveRepoRoot(): string {
    const candidates: string[] = [];
    if (typeof __dirname !== 'undefined') candidates.push(resolve(__dirname, '../../../../'));
    candidates.push(resolve(process.cwd(), '..', '..'));
    candidates.push(process.cwd());
    for (const c of candidates) {
      if (existsSync(join(c, 'scripts', 'gen-campaign.mjs'))) return c;
    }
    return candidates[0];
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
    granted: readonly string[] = [],
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
      if (modules(tier, granted).some((m) => m.module === key))
        return { kind: 'module', module: key };
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
    granted: readonly string[] = [],
  ): string {
    if (cat.kind === 'modules') {
      const ms = modules(tier, granted);
      const total = allItems().length;
      const usable = usableCount(tier, granted);
      const cells = ms.map((m) => `${m.module}(${m.allowed}/${m.total})`);
      const rows: string[] = [];
      for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3).join(' · '));
      const head =
        granted.length > 0
          ? `后台一共 ${total} 项能力，你（${TIER_LABEL[tier]}）能直接用 ${usable} 项（含单独放给你的 ${granted.length} 项）。`
          : `后台一共 ${total} 项能力，你（${TIER_LABEL[tier]}）能直接用 ${usable} 项。`;
      return [
        head,
        `括号里是「你能用 / 全部」。`,
        '',
        ...rows,
        '',
        '说「看 orders」看明细；说「找 退款」直接搜。选中后我只问缺的参数。',
      ].join('\n');
    }

    if (cat.kind === 'module') {
      const items = itemsOfModule(cat.module, tier, true, granted);
      if (items.length === 0)
        return `「${cat.module}」里没有你能直接做的操作。换别的模块，或让负责人放权。`;
      // ⚠️ 必须把候选写进会话，否则他回「1」时无处可选 —— 现象是「现在没有等你确认的事」
      this.putOp(userId, { code: '', params: {}, options: items, picking: 'op' });
      return this.optionLines(`「${cat.module}」里你能做的（回数字选）：`, items, tier, granted);
    }

    const hits = search(cat.kw, tier, 8, granted);
    if (hits.length === 0)
      return [
        `没找到和「${cat.kw}」相关的操作。`,
        '可以发「操作目录」看有哪些模块，或者换个说法（比如「退款」「套餐」「团长」）。',
      ].join('\n');
    this.putOp(userId, { code: '', params: {}, options: hits, picking: 'op' });
    return this.optionLines(`找到 ${hits.length} 个（回数字选）：`, hits, tier, granted);
  }

  private optionLines(
    head: string,
    items: CatalogItem[],
    tier: Tier,
    granted: readonly string[] = [],
  ): string {
    const lines = [head];
    items.forEach((it, i) => {
      const perm = canExec(tier, it.entry, { granted, code: it.code });
      const risk = RISK_LABEL[riskOf(it.entry)];
      // 放权来的项单独标出来：让他知道「这项是专门给我的」，而不是以为人人都有
      const tag = perm.ok ? (isGranted(tier, it.code, granted) ? `${risk}·放权` : risk) : '不可用';
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

  /** 选中一个端点：只读的问齐必填（有的话）就查，写入的逐个问完再出草稿 */
  private async beginOp(
    userId: string,
    item: CatalogItem,
    binding: Binding,
    tier: Tier,
  ): Promise<string> {
    const perm = canExec(tier, item.entry, {
      granted: binding.grantedOps ?? [],
      code: item.code,
    });
    if (!perm.ok)
      return `「${displayName(item.entry)}」你现在做不了：\n${perm.reason || '权限不足'}`;

    const op: OpState = { code: item.code, params: {}, options: undefined, picking: undefined };

    if (item.entry.method === 'GET') {
      // ⚠️ 只读端点也可能带**路径参数**（订单详情 `/admin/orders/:orderNo`、
      //    用户详情 `/admin/users/:id` …）。以前这里一律空参直接查，结果
      //    `/admin/orders/` 命中的是**列表**路由 —— 标题写着「订单详情」，
      //    回来的是整张订单列表。数据是错的，也不报错（2026-11-02 线上实测）。
      //    所以：有必填参数就先问，问齐了再查。
      const need = this.askNext(op);
      if (need) {
        this.putOp(userId, op);
        return need;
      }
      return this.runGetOp(userId, op, binding);
    }

    const ask = this.askNext(op);
    if (ask) {
      this.putOp(userId, op);
      return ask;
    }
    this.putOp(userId, op);
    return this.opDraftCard(op, tier, binding);
  }

  /** 问下一个还没填的必填参数；都齐了返回 null */
  private askNext(op: OpState): string | null {
    const item = find(op.code);
    if (!item) return null;

    const next = item.entry.params.find((p) => p.required && p.name !== '*' && !op.params[p.name]);
    if (next) {
      op.asking = next.name;
      // ⚠️ 160 不是随手写的：目录里 hint 的上限是 140，而取值恰恰排在最后
      //    （如「角色：super_admin / admin / …；取值：super_admin,admin,operator,…」117 字）——
      //    截到 100 会把**取值尾巴**切掉，用户看到的是半句话（`…financ`）。
      const hint = next.hint ? `\n（${next.hint.slice(0, 160)}）` : '';
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
    if (ask) {
      this.putOp(userId, op);
      return ask;
    }
    // 只读端点的参数问齐了就直接查：它没有副作用，不必再让人回一次 1
    if (find(op.code)?.entry.method === 'GET') return this.runGetOp(userId, op, binding);
    this.putOp(userId, op);
    return this.opDraftCard(op, tier, binding);
  }

  private opDraftCard(op: OpState, tier: Tier, binding: Binding): string {
    const item = find(op.code);
    if (!item) return '这个操作找不到了。发「操作目录」重来。';
    const perm = canExec(tier, item.entry, {
      granted: binding.grantedOps ?? [],
      code: item.code,
    });

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
      return `办好了：${displayName(item.entry)}\n${this.summarizeResult(res.data, op.code)}`;
    }
    return `没成功：${chatErrorText(res.code, res.message)}\n（${item.entry.method} ${item.entry.path}）`;
  }

  /** 只读端点执行（参数已齐）。只读没有副作用，不需要草稿卡确认。 */
  private async runGetOp(userId: string, op: OpState, binding: Binding): Promise<string> {
    this.sessions.delete(userId);
    const item = find(op.code);
    if (!item) return '这个操作找不到了。发「操作目录」重来。';
    const res = await this.proxy.execCatalog(op.code, op.params, binding, displayName(item.entry));
    if (res.code !== 0) return `没查到：${chatErrorText(res.code, res.message)}`;
    return `「${displayName(item.entry)}」的结果：\n${this.summarizeResult(res.data, op.code)}`;
  }

  /**
   * 通用出参说人话。
   *
   * 实现在 `result-summary.ts`（纯函数 + 单测）：按返回形态分「分页信封 / 数组 / 单对象」
   * 三路，字段走白名单。**不再 dump JSON** —— 认不出就实话说认不出，
   * 因为用户行里有 `passwordHash` 这类不该出现在群聊里的东西。
   */
  private summarizeResult(data: unknown, code?: string): string {
    return summarizeData(data, code);
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

  /**
   * 统计口径问答（经营数据 / 楼栋排行 / 菜品热度 / 留存 / 页面停留）
   *
   * 三个视角要两次取数（`dashboard` 与 `buildingRank` 要环比），其余一次。
   *
   * ⚠️ **环比失败不影响本期结论**：本期数字是真的，只是少了参照。故这里退化成
   *    「只报本期 + 说明没取到上期」，而不是整条报错 —— 报错会让老板以为数据都没有。
   *
   * ⚠️ 所有数字都来自端点，本方法**不计算任何业务口径**（GMV 怎么算、退款率分母是谁，
   *    全在 `StatsService` 里）。机器人这一层只做「取 → 说人话 → 比大小」。
   */
  /**
   * 「钱的口径」能不能给这个人看；能看返回 null，不能看返回那句该说的人话。
   *
   * ⚠️ 判据**只有一处**：`canExec`（与「从目录点进去」完全同源）。
   *    这里若另写一份 if，就会出现「问句被拦、目录能进」的缝 ——
   *    2026-11-02 之前正是这个缝：`query()` 根本不看 tier，同事问一句就能看 GMV。
   *
   * ⚠️ 挂不上判据时**不查**（宁可少给一次，也不把营收毛利漏出去）：
   *    `QUERY_META` 只有 endpoint、没有目录编码，靠 `codeOfPath` 反查；
   *    端点改名后反查会落空，落空时放行等于静默越权。
   */
  private statsDenied(qCode: string, binding: Binding): string | null {
    const tier: Tier = binding.tier === 'owner' ? 'owner' : 'staff';
    if (tier === 'owner') return null;

    const meta = lookupQuery(qCode);
    const code = meta ? codeOfPath(meta.endpoint, 'GET') : undefined;
    const item = code ? find(code) : undefined;
    if (!item) {
      this.logger.warn(`统计判权挂不上：${qCode} → 目录里找不到同路径端点，已按「不给」处理`);
      return '这项数据的权限我判不了（目录里对不上端点），先不查。请让负责人看一眼。';
    }

    const perm = canExec(tier, item.entry, { granted: binding.grantedOps, code });
    return perm.ok ? null : perm.reason || '这项数据默认只给负责人看。';
  }

  private async replyStats(it: StatsIntent, binding: Binding, now: Date): Promise<string> {
    // 先判权再取数：取完再拦等于已经把数发出去了
    const denied = this.statsDenied(STATS_QCODE[it.which], binding);
    if (denied) return denied;

    const q = STATS_QCODE[it.which];
    const today = bjTodayStr(now);
    if (!today) return '取不到今天的日期，我先不动。稍后再试。';

    const endDate = endDateOf(it, today);
    const params = { range: it.range, date: endDate };
    const unreadable =
      '数据取到了，但我没能把它说成人话（结构对不上）。请让负责人在后台看一眼，或把这条报给技术。';
    const noPrev = '\n\n（上一档没取到，这次先不给环比）';

    if (it.which === 'dashboard') {
      const cur = await this.proxy.query(q, params, binding);
      if (cur.code !== 0) return `没查到：${chatErrorText(cur.code, cur.message)}`;
      const head = summarizeDashboard(cur.data);
      if (!head) return unreadable;

      const prev = await this.proxy.query(
        q,
        { range: it.range, date: prevEndDateOf(it, endDate) },
        binding,
      );
      if (prev.code !== 0) return head + noPrev;
      const cmp = compareDashboard(cur.data, prev.data);
      return cmp.length ? [head, ...cmp].join('\n') : head + noPrev;
    }

    if (it.which === 'buildingRank') {
      const cur = await this.proxy.query(q, params, binding);
      if (cur.code !== 0) return `没查到：${chatErrorText(cur.code, cur.message)}`;
      // 上期取不到时传 null：榜单照常出，只是不点名跌幅（不能因为拿不到参照就不给榜）
      const prev = await this.proxy.query(
        q,
        { range: it.range, date: prevEndDateOf(it, endDate) },
        binding,
      );
      return summarizeBuildingRank(cur.data, prev.code === 0 ? prev.data : null) ?? unreadable;
    }

    if (it.which === 'dishHeat') {
      const cur = await this.proxy.query(q, params, binding);
      if (cur.code !== 0) return `没查到：${chatErrorText(cur.code, cur.message)}`;
      return summarizeDishHeat(cur.data) ?? unreadable;
    }

    if (it.which === 'retention') {
      const cur = await this.proxy.query(q, params, binding);
      if (cur.code !== 0) return `没查到：${chatErrorText(cur.code, cur.message)}`;
      return summarizeRetention(cur.data) ?? unreadable;
    }

    const cur = await this.proxy.query(q, params, binding);
    if (cur.code !== 0) return `没查到：${chatErrorText(cur.code, cur.message)}`;
    return summarizePageDuration(cur.data) ?? unreadable;
  }

  private async queryOrders(date: string | null, binding: Binding, now: Date): Promise<string> {
    // ⚠️ 参数名必须是 `mealDate`：`/admin/orders` 的 DTO 就这一个日期字段，
    //    传 `date` 会被白名单校验挡下（`property date should not exist`），
    //    而现象只是「没查到」——「今天多少单」因此一直是坏的，且很难从报错看出是字段名问题。
    const res = await this.proxy.query('q_orders', date ? { mealDate: date } : {}, binding);
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
