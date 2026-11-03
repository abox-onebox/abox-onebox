import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'path';
import { isAfterCutoff, todayBj } from '../../common/utils/time';
import { Cron } from '@nestjs/schedule';
import { OpProxyService, Binding } from './op-proxy.service';
import { NameResolverService, GroupResolve, ItemResolve } from './name-resolver.service';
import { WecomBindingService } from './wecom-binding.service';
import { WecomSvcTokenService } from './wecom-svc-token.service';
import { WecomTokenService } from './wecom-token.service';
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
  execTierOf,
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
import { summarizeLeaderHealth, describeLeader, type LeaderHealthItem } from './leader-health';
import { computeHealthScore, weakestDimension, type HealthScoreInput } from './health-score';
import { pickCommunityTargets, describeTargets, AMPLIFY_MIN_ORDERS } from './community-plan';
import { clusterRefunds, describeRefundCluster } from './refund-cluster';
import { preflight, describePreflight, type PreflightResult } from './preflight';

/** 取首行非空文本，截断到 80 字，用于编排摘要的一行预览 */
function firstLineOf(text: string): string {
  const line = (text || '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!line) return '（无内容）';
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
}

/** 全自动编排单节点结果 */
export interface DailyNodeResult {
  key: string;
  title: string;
  text: string;
  ok: boolean;
  /**
   * 本次因「数据体检不通过」而跳过（不是失败，也不是没跑）。
   *
   * 必须与 ok=false 分开：ok=false 是要人去看的故障；skipped 是**预期的**省略，
   * 混在一起会让摘要里出现一片 ❌，看起来像系统坏了。
   */
  skipped?: boolean;
}

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

  /**
   * 每日编排封面用的健康度徽标（如「经营健康度：72/100 黄色 · 需关注（较上次 +4）」）。
   *
   * 为什么用实例字段而不是把 `composeDigest` 改成 async：
   *   摘要要同步拼出来（试跑台直接拿返回值），让摘要去反解析节点文本里的分数更脆
   *   （文案一改就失效）。所以由节点 O 自己把徽标写好，摘要只负责读。
   * ⚠️ 每次 `runDailyNodes` 开头必须清空 —— 今天节点失败就该没有徽标，
   *   绝不能挂着昨天的分数出现在今天的封面（那是最容易骗到人的一种错）。
   * ⚠️ 一期单 API 实例 + 编排串行，所以这个字段安全；多实例部署时要改成按天落库。
   */
  private lastHealthBadge: string | null = null;

  /**
   * 最近一次编排前的数据体检结论（供摘要首段用）
   *
   * 与 lastHealthBadge 同理：每次 runDailyNodes 开头重算，不留上一轮的结论。
   */
  private lastPreflight: PreflightResult | null = null;

  constructor(
    private readonly resolver: NameResolverService,
    private readonly proxy: OpProxyService,
    private readonly bindingSvc: WecomBindingService,
    private readonly svcTokenSvc: WecomSvcTokenService,
    private readonly tokenSvc: WecomTokenService,
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
      case 'genDemandForecast':
        return this.genDemandForecast(binding, now);
      case 'genGrowthExperiment':
        return this.genGrowthExperiment(binding, now);
      case 'runOrchestrate':
        // 完整编排会跑过 nginx 60s 网关超时，故不在此 await（否则试跑台收到 504）。
        // 改为后台触发：结果由 triggerOwnerPush 推到真实负责人手机 + 写日志。
        void this.triggerOwnerPush().catch(() => {
          /* 异常已在其内部记日志，这里不重复 */
        });
        return (
          '已触发每日编排（与 09:00 同链路），预计 1~3 分钟后推送至负责人手机。\n' +
          '本试跑不阻塞等待；可在服务器日志 grep "已推送摘要给" 看成败。'
        );
      case 'genRiskRecon':
        return this.genRiskRecon(binding, now);
      case 'genChurnRecall':
        return this.genChurnRecall(binding, now);
      case 'genLeaderHealth':
        return this.genLeaderHealth(binding, now);
      case 'genHealthScore':
        return this.genHealthScore(binding, now);
      case 'genCommunityPlan':
        return this.genCommunityPlan(binding, now);
      case 'genRefundCluster':
        return this.genRefundCluster(binding, now);
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
   * 全自动编排（人仅兜底）· 每日 09:00 自动跑全部分析节点（见 dailyOrchestrate 的 @Cron）。
   *
   * 设计边界（原则零守住）：
   *   · 只跑「分析与提案」节点，零写操作 —— 发券/退款/调账/改套餐/招募发布均不在此自动执行；
   *   · 每个节点失败只标 ❌ 并继续，不阻断其余节点（降级不扩散）；
   *   · 结果推送到负责人企微，人只在 ⚠️/❌ 时兜底介入；
   *   · 复用既有 genXxx（各自取数/落盘/降级已分别验证），不新增任何写接口调用。
   */
  async runDailyNodes(binding: Binding, now: Date): Promise<DailyNodeResult[]> {
    const nodes: { key: string; title: string; run: () => Promise<string> }[] = [
      { key: 'daily', title: '运营日报', run: () => this.genDailyReport(binding, now) },
      { key: 'meal', title: '选品提案', run: () => this.genMealProposal(binding, now) },
      { key: 'recruit', title: '团长招募赋能', run: () => this.genRecruitProposal(binding, now) },
      { key: 'coupon', title: '动态发券策略', run: () => this.genCouponStrategy(binding, now) },
      {
        key: 'demand',
        title: '需求预测与产能预警',
        run: () => this.genDemandForecast(binding, now),
      },
      { key: 'growth', title: 'A/B 增长实验', run: () => this.genGrowthExperiment(binding, now) },
      { key: 'risk', title: '风控对账体检', run: () => this.genRiskRecon(binding, now) },
      {
        key: 'churn',
        title: '用户流失预警召回',
        run: () => this.genChurnRecall(binding, now),
      },
      {
        key: 'leader',
        title: '团长健康度与留存',
        run: () => this.genLeaderHealth(binding, now),
      },
      // 总分放最后一个跑：它要读对账/留存/团长覆盖，先让前面的节点把数据准备好
      // （但它是**独立取数**的，不依赖上面节点的文本 —— 节点失败不会连锁影响分数）
      { key: 'health', title: '经营健康度总分', run: () => this.genHealthScore(binding, now) },
      { key: 'community', title: '社群运营排期', run: () => this.genCommunityPlan(binding, now) },
      { key: 'refund', title: '退款根因聚类', run: () => this.genRefundCluster(binding, now) },
    ];
    const out: DailyNodeResult[] = [];
    // 每天重新生成封面徽标：若本节点今天失败，宁可**没有**徽标，也不能挂昨天的旧分数
    this.lastHealthBadge = null;

    // 先体检再跑：数据空壳时（没排餐 / 没订单）按判据跳过节点。
    // 不体检的后果是每天推一堆「GMV -100%」「全员流失」的假告警，负责人几天后就不看了。
    // 体检自身失败不阻断编排（catch 里按「全部未知」处理 ⇒ grade=ok ⇒ 照常跑）。
    const pf = await this.preflightData(now, binding);
    this.lastPreflight = pf;
    const skip = new Set(pf.skipNodes);
    if (skip.size) {
      this.logger.warn(
        `数据体检未通过（${pf.grade}），跳过 ${skip.size} 个节点：${pf.skipNodes.join(',')}`,
      );
    }

    for (const n of nodes) {
      if (skip.has(n.key)) {
        // 跳过**不是失败**：ok 仍为 true，另用 skipped 标记，避免摘要里出现一片 ❌
        out.push({
          key: n.key,
          title: n.title,
          text: '本次跳过（数据不足以支撑该分析）',
          ok: true,
          skipped: true,
        });
        continue;
      }
      try {
        const text = await n.run();
        out.push({
          key: n.key,
          title: n.title,
          text: typeof text === 'string' ? text : String(text),
          ok: true,
        });
      } catch (e) {
        out.push({
          key: n.key,
          title: n.title,
          text: '执行异常：' + (e instanceof Error ? e.message : String(e)),
          ok: false,
        });
      }
    }
    return out;
  }

  /**
   * 数据体检：编排前先问一句「现在有东西可算吗」
   *
   * 三项独立取数，各自 try/catch —— 任一项失败只让该项留 null（「不知道」），
   * **绝不当成 0**（那就是把接口抖动报成「今天一单没有」）。
   * 三个口径都是纯只读，不碰订单/支付/配送。
   */
  private async preflightData(now: Date, binding: Binding): Promise<PreflightResult> {
    const today = bjYmdPlus(now, 0);
    const end = bjYmdPlus(now, 6);

    let publishedCells: number | null = null;
    let assignedCells: number | null = null;
    let groupCount: number | null = null;
    try {
      const m = await this.resolver.getMealMatrix(today, end);
      const s = m?.stats;
      if (s) {
        // 逐个判 typeof：字段缺失时留 null（不知道），不是 0（确证为空）
        if (typeof s.publishedCells === 'number') publishedCells = s.publishedCells;
        if (typeof s.assignedCells === 'number') assignedCells = s.assignedCells;
        if (typeof s.groupCount === 'number') groupCount = s.groupCount;
      }
    } catch {
      /* 静默：判据留 null，不因此降级 */
    }

    let couponDefs: number | null = null;
    try {
      const c = await this.resolver.listCouponDefs();
      if (Array.isArray(c)) couponDefs = c.length;
    } catch {
      /* 静默 */
    }

    let orders7d: number | null = null;
    try {
      const r = await this.proxy.query(STATS_QCODE.dashboard, { range: '7d' }, binding);
      if (r.code === 0 && r.data) {
        const d = r.data as Record<string, unknown>;
        const m = d?.metrics as Record<string, unknown> | undefined;
        if (m && typeof m.orderCount === 'number') orders7d = m.orderCount;
      }
    } catch {
      /* 静默 */
    }

    return preflight({ publishedCells, assignedCells, groupCount, couponDefs, orders7d });
  }

  /** 跑全部节点 + 组摘要 + 推送负责人企微；返回摘要与「推送是否真成功」以便上层判断 */
  async runAndPushForUser(
    userId: string,
    binding: Binding,
  ): Promise<{ digest: string; pushed: boolean }> {
    const now = new Date();
    const results = await this.runDailyNodes(binding, now);
    const digest = this.composeDigest(results, now);
    let pushed = false;
    try {
      const r = await this.tokenSvc.sendText(userId, digest);
      pushed = r.ok;
      if (!pushed) {
        this.logger.error(
          'AI 编排推送被企业微信拒绝（摘要仍已生成）：' +
            (r.errcode ? 'errcode=' + r.errcode + ' ' : '') +
            (r.errmsg || ''),
        );
      }
    } catch (e) {
      this.logger.error(
        'AI 编排推送失败（摘要仍已生成）：' + (e instanceof Error ? e.message : String(e)),
      );
    }
    return { digest, pushed };
  }

  @Cron('0 9 * * *', { name: 'ai-daily-orchestrate', timeZone: 'Asia/Shanghai' })
  async dailyOrchestrate(): Promise<void> {
    try {
      const resolved = await this.resolveOwnerBinding();
      if (!resolved) return;
      const { userId, binding } = resolved;
      const { digest, pushed } = await this.runAndPushForUser(userId, binding);
      this.logger.log(
        'AI 每日编排完成，已推送摘要给 ' +
          userId +
          '（' +
          digest.length +
          ' 字，推送' +
          (pushed ? '成功' : '失败') +
          '）',
      );
    } catch (e) {
      this.logger.error('AI 每日编排异常：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * 手动（试跑台 / 调试）触发「真实负责人推送」。
   *
   * 与每日 09:00 Cron 走同一条 `resolveOwnerBinding → runAndPushForUser` 链路，
   * 唯一区别是它把结果回传给调用方（试跑台要展示「推没推成功」）。
   *
   * ⚠️ 为什么试跑台的「跑一次编排」要走这里、而不是用会话键：
   *    会话键（`sim:...`）不是真实企微 userid，`sendText` 必然被企业微信拒收，
   *    永远验不了「手机到底收没收到」。故试跑台直接推给**真实负责人**，
   *    这样在备案 / 回调还没通时也能完成「推送到达」这一环的实测。
   */
  async triggerOwnerPush(): Promise<{ pushed: boolean; reason?: string; digestLen: number }> {
    const resolved = await this.resolveOwnerBinding();
    if (!resolved) {
      return {
        pushed: false,
        reason: '未找到负责人绑定（无 WECOM_OWNER_USERID，后台绑定表里也没有 owner 级绑定）',
        digestLen: 0,
      };
    }
    const { userId, binding } = resolved;
    const { digest, pushed } = await this.runAndPushForUser(userId, binding);
    this.logger.log(
      '手动触发编排完成，已推送摘要给 ' +
        userId +
        '（' +
        digest.length +
        ' 字，推送' +
        (pushed ? '成功' : '失败') +
        '）',
    );
    if (!pushed) {
      return {
        pushed: false,
        reason:
          '编排已生成摘要，但企业微信下发失败（重点查 WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET 是否配置，' +
          '以及该 userid 是否是应用可见范围内的成员）',
        digestLen: digest.length,
      };
    }
    return { pushed: true, digestLen: digest.length };
  }

  /**
   * 触发「提审材料包」生成（AI 编排节点 C · 后台触发入口）
   *
   * C 节点脚本 scripts/gen-launch-pack.mjs 写完却无触发入口（无 CI、无企微、无定时），等同孤儿。
   * 本方法补上「后台手动」入口，与 triggerOwnerPush 同构：resolve 仓库根 → spawn 脚本 → 读回生成的 md → 返回内容。
   * 脚本自身已做「原则零」降级：gate.mjs 调用失败只标 ⚠️ 继续；读取失败也不抛错。
   * ⚠️ 不传 date 时与脚本一致用 UTC 当日（对齐脚本内 new Date().toISOString().slice(0,10)）。
   */
  async genLaunchPack(opts: { date?: string; noGate?: boolean } = {}): Promise<{
    ok: boolean;
    path?: string;
    content?: string;
    stdout: string;
  }> {
    const repoRoot = this.resolveRepoRoot();
    const outDir = this.pickWritableDir(repoRoot);
    const script = join(repoRoot, 'scripts', 'gen-launch-pack.mjs');
    if (!existsSync(script)) {
      return { ok: false, stdout: '提审包脚本未找到：' + script };
    }
    const packDate = opts.date || new Date().toISOString().slice(0, 10);
    const args = [script, '--out', outDir];
    if (opts.date) args.push('--date', opts.date);
    if (opts.noGate) args.push('--no-gate');

    return new Promise<{ ok: boolean; path?: string; content?: string; stdout: string }>(
      (resolve) => {
        let settled = false;
        const finish = (r: {
          ok: boolean;
          path?: string;
          content?: string;
          stdout: string;
        }): void => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('node', args, { cwd: repoRoot, env: { ...process.env } });
        } catch (e) {
          finish({
            ok: false,
            stdout: '提审包启动失败：' + (e instanceof Error ? e.message : String(e)),
          });
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish({
            ok: false,
            stdout: '提审包生成超时（>120s），可能 gate.mjs 卡住，可加 --no-gate 重试',
          });
        }, 120_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish({
            ok: false,
            stdout: '提审包执行错误：' + (e instanceof Error ? e.message : String(e)),
          }),
        );
        child.on('close', () => {
          clearTimeout(timer);
          const file = join(outDir, `ABox一盒_提审包_${packDate}.md`);
          let content: string | undefined;
          let ok = false;
          try {
            if (existsSync(file)) {
              content = readFileSync(file, 'utf8');
              ok = true;
            }
          } catch {
            /* 读回失败 */
          }
          finish({
            ok,
            path: existsSync(file) ? file : undefined,
            content,
            stdout: out + (err ? '\n[stderr]\n' + err : ''),
          });
        });
      },
    );
  }

  private async resolveOwnerBinding(): Promise<{ userId: string; binding: Binding } | null> {
    const envId = (process.env.WECOM_OWNER_USERID || '').trim();
    let userId = envId;
    if (!userId) {
      const owners = (await this.bindingSvc.list()).filter((b) => b.tier === 'owner');
      userId = owners[0]?.userId ?? '';
    }
    if (!userId) {
      this.logger.warn('未找到负责人绑定（无 WECOM_OWNER_USERID 也无 owner 级绑定），跳过今日编排');
      return null;
    }
    const wb = await this.bindingSvc.get(userId);
    if (!wb) {
      this.logger.warn('负责人绑定不存在 userId=' + userId + '，跳过今日编排');
      return null;
    }
    const tier = wb.tier === 'owner' ? 'owner' : 'staff';
    const grantedOps = wb.grantedOps || [];
    const execTier = execTierOf(tier, grantedOps);
    const svcToken = await this.svcTokenSvc.get(execTier);
    const execToken = svcToken ?? wb.operatorToken ?? null;
    if (!execToken) {
      this.logger.warn('负责人执行令牌缺失（svc token 与 operatorToken 均为空），跳过今日编排');
      return null;
    }
    const binding: Binding = {
      operatorName: wb.operatorName,
      operatorToken: execToken,
      approverToken: wb.approverToken,
      tier,
      grantedOps,
    };
    return { userId, binding };
  }

  private composeDigest(results: DailyNodeResult[], now: Date): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const lines: string[] = [];
    lines.push(`【ABox AI 每日编排】${y}-${m}-${d} 09:00`);
    // 封面一行：今日经营健康度（由节点 O 在本次编排里写好；未跑/失败则不出这一行）
    if (this.lastHealthBadge) lines.push(this.lastHealthBadge);

    const done = results.filter((r) => !r.skipped);
    const omitted = results.filter((r) => r.skipped);
    lines.push(
      omitted.length
        ? `本次执行 ${done.length} 个节点，跳过 ${omitted.length} 个（数据不足以支撑该分析）`
        : `共 ${done.length} 个分析节点已自动生成草稿（均须人工确认后执行）`,
    );

    // 体检结论放在明细之前：负责人先看「今天该干什么」，再看各节点摘要。
    // 降级时这一段是核心 —— 它把「为什么跳过」和「下一步动作」说清楚，
    // 否则负责人看到节点少了只会以为系统坏了。
    const pfText = this.lastPreflight ? describePreflight(this.lastPreflight) : '';
    if (pfText) {
      lines.push('');
      lines.push(pfText);
    }

    lines.push('');
    for (const r of done) {
      let mark = '✅';
      if (!r.ok) mark = '❌';
      else if (/高风险|需关注|需人工核|异常|超阈值/.test(r.text)) mark = '⚠️';
      lines.push(`${mark} ${r.title}：${firstLineOf(r.text)}`);
    }
    lines.push('');
    lines.push('— 完整草稿已落盘后台；在企微回复「生成X」可查看/确认。AI 草稿，执行前请人工复核。');
    return lines.join('\n');
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

  /**
   * AI 编排节点 I · 需求预测与产能预警（企微触发）
   * ------------------------------------------------------------------
   * 复用既有取数链：dashboard(30d) 的日级序列 trend + buildingRank(30d) + dishHeat(30d) + 供应商日产能，
   * 在 service 端**预计算**周几规律 / 近期动能 / 历史峰值 / 产能基线（LLM 不擅长精确算术，前置算好更稳），
   * 再 spawn 独立脚本 `gen-demand-forecast.mjs` 产出 7 天预测 + 产能利用率 + 分楼栋/菜品预警 + 行动建议。
   *
   * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
   *   · 纯增量分支，不动订单/支付/配送核心；
   *   · 取数走既有 `proxy.query`（零新增 DI 依赖）+ `resolver.listSuppliers()`（产能基线）；
   *   · 四数据源各自 try/catch：任一取不到都不中断；
   *   · 脚本缺失/超时/异常 → 降级回显「原始数据」，绝不阻塞应答；
   *   · 只产出草稿（releases/demand-forecast/），由人工确认后指导备料/排产/招募，绝不自动改产能或下单。
   */
  private genDemandForecast(binding: Binding, now: Date): Promise<string> {
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

      const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined;

      // 1. 整体看板 + 日级趋势（趋势是需求预测的核心时序）
      type TrendPt = { date?: string; orderCount?: number; quantity?: number; gmvFen?: number };
      let trend: TrendPt[] = [];
      let warnings: string[] = [];
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.dashboard,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const d = cur.data as Record<string, unknown>;
          const tr = d?.trend;
          if (Array.isArray(tr))
            trend = tr
              .map((p) => {
                const pp = p as Record<string, unknown>;
                return {
                  date: typeof pp.date === 'string' ? pp.date : undefined,
                  orderCount: num(pp.orderCount),
                  quantity: num(pp.quantity) ?? num(pp.orderCount),
                  gmvFen: num(pp.gmvFen),
                };
              })
              .filter((p) => p.date);
          const w = d?.warnings;
          if (Array.isArray(w))
            warnings = w.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
        }
      } catch {
        /* 跳过该视角 */
      }

      // 2. 楼栋表现
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
            buildings = buildings.slice(0, 5);
          }
        }
      } catch {
        /* 跳过该视角 */
      }

      // 3. 菜品热度（用既有 summarize 文本，与 F 节点一致）
      let dishText = '';
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.dishHeat,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const txt = summarizeDishHeat(cur.data);
          if (txt) dishText = txt;
        }
      } catch {
        /* 跳过该视角 */
      }

      // 4. 供应商产能基线
      type Sup = {
        id: number;
        name?: string | null;
        status?: number;
        capacityPerDay?: number | null;
      };
      let suppliers: Sup[] = [];
      try {
        const list = await this.resolver.listSuppliers();
        if (list && list.length)
          suppliers = list.map((s) => ({
            id: Number(s.id),
            name: s.name,
            status: typeof s.status === 'number' ? s.status : undefined,
            capacityPerDay: typeof s.capacityPerDay === 'number' ? s.capacityPerDay : null,
          }));
      } catch {
        /* 跳过该视角 */
      }

      // ===== 预计算（service 端做算术，脚本只做解读）=====
      const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const MON_FIRST = [1, 2, 3, 4, 5, 6, 0]; // getUTCDay: 0=周日
      const wkSum = new Array(7).fill(0);
      const wkCnt = new Array(7).fill(0);
      for (const p of trend) {
        if (p.date && p.quantity != null) {
          const [y, m, d] = p.date.split('-').map(Number);
          if (y && m && d) {
            const wd = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
            wkSum[wd] += p.quantity;
            wkCnt[wd] += 1;
          }
        }
      }
      const wkAvg = wkSum.map((s, i) => (wkCnt[i] > 0 ? Math.round(s / wkCnt[i]) : 0));
      let peakWk = 1;
      let valleyWk = 1;
      for (const i of MON_FIRST) {
        if (wkAvg[i] > wkAvg[peakWk]) peakWk = i;
        if (wkAvg[i] < wkAvg[valleyWk]) valleyWk = i;
      }

      const qtyOf = (p: TrendPt) => p.quantity ?? 0;
      const last7 = trend.slice(-7);
      const prev7 = trend.slice(-14, -7);
      const avg = (arr: TrendPt[]) =>
        arr.length ? Math.round(arr.reduce((s, p) => s + qtyOf(p), 0) / arr.length) : undefined;
      const last7Avg = avg(last7);
      const prev7Avg = avg(prev7);
      let growth: number | undefined;
      if (last7Avg != null && prev7Avg != null && prev7Avg > 0)
        growth = Math.round(((last7Avg - prev7Avg) / prev7Avg) * 1000) / 10;

      let peakQty = 0;
      let peakDate = '';
      for (const p of trend) {
        const q = qtyOf(p);
        if (q > peakQty) {
          peakQty = q;
          peakDate = p.date ?? '';
        }
      }

      // 未来 7 天需求预测（service 端算，避免 LLM 算术误差）：周几规律 × 动量系数
      const [ty, tm, td] = today.split('-').map(Number);
      const overallAvg = trend.length
        ? Math.round(trend.reduce((s, p) => s + qtyOf(p), 0) / trend.length)
        : 0;
      let momentum = 1;
      if (overallAvg > 0 && last7Avg != null && last7Avg > 0)
        momentum = Math.round((last7Avg / overallAvg) * 100) / 100;
      momentum = Math.min(1.3, Math.max(0.7, momentum)); // 限制极端外推
      const next7: { date: string; wd: number; est: number }[] = [];
      for (let k = 0; k < 7; k++) {
        const dt = new Date(Date.UTC(ty, tm - 1, td + k, 12, 0, 0));
        const wd = dt.getUTCDay();
        const dstr = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
          dt.getUTCDate(),
        ).padStart(2, '0')}`;
        const est = wkCnt[wd] > 0 ? Math.round(wkAvg[wd] * momentum) : 0;
        next7.push({ date: dstr, wd, est });
      }
      const fcTotal = next7.reduce((s, x) => s + x.est, 0);
      const fcPeak = next7.reduce((m, x) => Math.max(m, x.est), 0);
      const fcPeakDate = next7.reduce((a, b) => (a.est >= b.est ? a : b)).date;

      const activeSuppliers = suppliers.filter((s) => s.status === 1);
      const withCap = activeSuppliers.filter(
        (s) => typeof s.capacityPerDay === 'number' && s.capacityPerDay! > 0,
      );
      const totalCapacity = withCap.reduce((s, x) => s + (x.capacityPerDay as number), 0);
      const capacityMissing = totalCapacity <= 0;

      // ===== 组装纯文本 =====
      const lines: string[] = [];
      lines.push('需求预测与产能预警数据 · 近30天（按出餐日）');
      lines.push('');

      if (trend.length) {
        lines.push('【近30天日级需求(份)】');
        for (const p of trend) lines.push(`${p.date}：${qtyOf(p)}`);
        lines.push('');
      }

      lines.push('【周几规律(近30天平均份)】');
      lines.push(MON_FIRST.map((i) => `${WEEK[i]} ${wkAvg[i]}`).join(' · '));
      lines.push(`→ 峰值在${WEEK[peakWk]}，谷值在${WEEK[valleyWk]}`);
      lines.push('');

      const mom: string[] = [];
      if (last7Avg != null) mom.push(`近7日均量 ${last7Avg} 份/日`);
      if (prev7Avg != null) mom.push(`前7日均量 ${prev7Avg} 份/日`);
      if (growth != null) mom.push(`环比 ${growth >= 0 ? '+' : ''}${growth}%`);
      if (peakQty > 0) mom.push(`历史峰值日量 ${peakQty} 份（${peakDate}）`);
      if (mom.length) {
        lines.push('【近期动能】' + mom.join(' · '));
        lines.push('');
      }

      if (next7.length) {
        lines.push('【未来7天需求预测(测算)】');
        lines.push(`动量系数 ≈ ${momentum}（近7日均量 ÷ 30日均量，>1 上行 / <1 下行）`);
        lines.push('日期 · 周几 · 预计份数');
        for (const x of next7) lines.push(`${x.date} · ${WEEK[x.wd]} · ${x.est}`);
        lines.push(`→ 7日合计 ≈ ${fcTotal} 份 · 预测峰值日 ${fcPeakDate} ${fcPeak} 份`);
        lines.push('');
      }

      if (buildings.length) {
        lines.push('【楼栋 TOP ' + buildings.length + '】（按 GMV）');
        buildings.forEach((b, i) => {
          const bits: string[] = [];
          bits.push(fen2yuan(b.gmvFen));
          bits.push(`${b.orderCount} 单`);
          if (b.gmvShare) bits.push(`${Math.round(b.gmvShare * 1000) / 10}%`);
          lines.push(`${i + 1}. ${b.name}  ${bits.join(' · ')}`);
        });
        lines.push('');
      }

      if (dishText) {
        lines.push('【菜品热度】');
        lines.push(dishText);
        lines.push('');
      }

      lines.push('【产能基线】');
      if (capacityMissing) {
        lines.push(
          `供应商总数 ${suppliers.length} · 活跃 ${activeSuppliers.length} · 已配置日产能的活跃供应商 0`,
        );
        lines.push(
          '→ 产能基线缺失（供应商 capacity_per_day 未配置），以下预警以「历史峰值日量」为参考阈值，需先补全产能配置再启用正式预警',
        );
        lines.push(
          `【产能利用率(参考)】预测峰值日 ${fcPeak} 份 ÷ 历史峰值 ${peakQty} 份 ≈ ${
            peakQty > 0 ? Math.round((fcPeak / peakQty) * 1000) / 10 : '—'
          }%`,
        );
      } else {
        lines.push(
          `供应商总数 ${suppliers.length} · 活跃 ${activeSuppliers.length} · 已配置日产能的活跃供应商 ${withCap.length}`,
        );
        lines.push(`总日产能 = Σ 活跃供应商 capacity_per_day = ${totalCapacity} 份/日`);
        const util = totalCapacity > 0 ? Math.round((fcPeak / totalCapacity) * 1000) / 10 : 0;
        lines.push(
          `【产能利用率(测算)】预测峰值日 ${fcPeak} 份 ÷ 总日产能 ${totalCapacity} 份 ≈ ${util}%`,
        );
      }
      lines.push('（产能口径：供应商每日产能之和；业务逻辑见 meal.service 产能上限预留）');
      lines.push('');

      if (warnings.length) lines.push('【数据提示】' + warnings.join('；'));

      if (!trend.length && !buildings.length && !dishText)
        return '近 30 天日级销量、楼栋与菜品数据这次都没取到（可能权限不足或还没开团）。可在后台看板查看，或稍后重试。';

      const plain = lines.join('\n');

      // 写临时数据文件，交给脚本做 AI 预测 + 落盘
      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_df_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `需求预测数据已生成，但写入临时文件失败（磁盘权限）。可在后台看板查看原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-demand-forecast.mjs');
      if (!existsSync(script)) {
        return `需求预测（原始数据，AI 脚本未找到）：\n\n${plain}`;
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
            `需求预测生成启动失败：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          );
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('需求预测生成超时（>90s）。原始数据已在后台看板，可稍后重试触发。');
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `需求预测生成出错：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          try {
            unlinkSync(plainFile);
          } catch {
            /* noop */
          }
          if (out.trim()) finish(out.trim());
          else
            finish(
              `需求预测生成未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n可在后台看板查看原始数据。`,
            );
        });
      });
    };
    return run();
  }

  private genGrowthExperiment(binding: Binding, now: Date): Promise<string> {
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
      const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined;

      // 1. 整体经营基线（dashboard 原始指标，供 AI 设计 lift 度量）
      let metrics: Record<string, unknown> = {};
      let warnings: string[] = [];
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.dashboard,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const d = cur.data as Record<string, unknown>;
          const m = d?.metrics as Record<string, unknown> | undefined;
          if (m) metrics = m;
          const w = d?.warnings;
          if (Array.isArray(w))
            warnings = w.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
        }
      } catch {
        /* 跳过该视角 */
      }

      // 2. 楼栋表现（自然 A/B 候选 + 差异分析）
      type Bld = {
        id: number;
        name: string;
        gmvFen: number;
        orderCount: number;
        gmvShare: number;
        userCount?: number;
      };
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
                userCount: num(rr.userCount),
              });
            }
            buildings = buildings.slice(0, 8);
          }
        }
      } catch {
        /* 跳过该视角 */
      }

      // 3. 套餐模板全量（人气分层，识别可试变体的头部套餐）
      let tpls: {
        id: number;
        name: string;
        priceFen?: number;
        statusText?: string;
        kind?: string;
        usedCount?: number;
      }[] = [];
      try {
        const list = await this.resolver.listTemplatesFull();
        if (list && list.length)
          tpls = list.map((t) => ({
            id: Number(t.id),
            name: t.name ?? `套餐#${t.id}`,
            priceFen: typeof t.priceFen === 'number' ? t.priceFen : undefined,
            statusText: t.statusText,
            kind: t.kind,
            usedCount: typeof t.usedCount === 'number' ? t.usedCount : undefined,
          }));
      } catch {
        /* 跳过该视角 */
      }

      // 4. 现有券种（可复用杠杆，不凭空造 id）
      type Coupon = {
        id: number;
        name: string;
        faceValueFen: number;
        thresholdFen: number;
        status?: string;
      };
      let coupons: Coupon[] = [];
      try {
        const list = await this.resolver.listCouponDefs();
        if (list && list.length)
          coupons = list.map((c) => ({
            id: Number(c.id),
            name: c.name,
            faceValueFen: num(c.faceValueFen) ?? 0,
            thresholdFen: num(c.thresholdFen) ?? 0,
            status: typeof c.status === 'string' ? c.status : undefined,
          }));
      } catch {
        /* 跳过该视角 */
      }

      // ===== 预计算（service 端做算术，脚本只做解读）=====
      // 楼栋差异：GMV 极差与客单价(测算)区间，识别自然 A/B 候选
      let bldStat = '';
      if (buildings.length) {
        const gmvSorted = [...buildings].sort((a, b) => b.gmvFen - a.gmvFen);
        const maxG = gmvSorted[0];
        const minG = gmvSorted[gmvSorted.length - 1];
        const ratio = minG.gmvFen > 0 ? Math.round((maxG.gmvFen / minG.gmvFen) * 10) / 10 : 0;
        const perOrder = buildings
          .filter((b) => b.orderCount > 0)
          .map((b) => b.gmvFen / b.orderCount);
        const minPO = perOrder.length ? Math.round(Math.min(...perOrder)) : 0;
        const maxPO = perOrder.length ? Math.round(Math.max(...perOrder)) : 0;
        bldStat = `楼栋数 ${buildings.length} · GMV 最高 ${maxG.name}（${fen2yuan(
          maxG.gmvFen,
        )}）/ 最低 ${minG.name}（${fen2yuan(minG.gmvFen)}）· 极差 ≈ ${ratio} 倍 · 楼均客单价(测算)区间 ${fen2yuan(
          minPO,
        )} ~ ${fen2yuan(maxPO)}`;
      }

      // 套餐人气分层：头部 vs 长尾，识别可试变体的对象
      let tplStat = '';
      if (tpls.length) {
        const withCnt = tpls.filter((t) => typeof t.usedCount === 'number');
        const sorted = [...withCnt].sort((a, b) => (b.usedCount ?? 0) - (a.usedCount ?? 0));
        const top = sorted.slice(0, 3);
        const tail = sorted.slice(-3);
        if (top.length && tail.length && (tail[0].usedCount ?? 0) > 0) {
          const spread = (top[0].usedCount ?? 0) / Math.max(1, tail[0].usedCount ?? 0);
          tplStat = `套餐数 ${tpls.length} · 头部人气 ${top
            .map((t) => `${t.name}(${t.usedCount})`)
            .join('、')} · 长尾 ${tail
            .map((t) => `${t.name}(${t.usedCount})`)
            .join('、')} · 头部/长尾人气差 ≈ ${Math.round(spread)} 倍`;
        } else if (top.length) {
          tplStat = `套餐数 ${tpls.length} · 人气最高 ${top
            .map((t) => `${t.name}(${t.usedCount ?? '—'})`)
            .join('、')}`;
        }
      }

      // ===== 组装纯文本 =====
      const lines: string[] = [];
      lines.push('A/B 增长实验设计数据 · 近30天（按出餐日，数值均为测算/观察）');
      lines.push('');

      if (Object.keys(metrics).length) {
        lines.push('【近30天整体经营基线】');
        for (const [k, v] of Object.entries(metrics)) {
          if (typeof v === 'number') lines.push(`· ${k}: ${v}`);
          else if (typeof v === 'string') lines.push(`· ${k}: ${v}`);
        }
        lines.push('');
      }

      if (buildings.length) {
        lines.push('【楼栋表现 TOP ' + buildings.length + '】（按 GMV）');
        buildings.forEach((b, i) => {
          const bits: string[] = [fen2yuan(b.gmvFen), `${b.orderCount} 单`];
          if (b.gmvShare) bits.push(`${Math.round(b.gmvShare * 1000) / 10}%`);
          if (b.userCount != null) bits.push(`${b.userCount} 人`);
          lines.push(`${i + 1}. ${b.name}  ${bits.join(' · ')}`);
        });
        lines.push('');
        lines.push('【楼栋差异(测算)】' + bldStat);
        lines.push('');
      }

      if (tpls.length) {
        lines.push('【套餐模板（含被排次数 · 人气代理）】');
        tpls.slice(0, 10).forEach((t) => {
          const bits: string[] = [];
          if (t.priceFen != null) bits.push(fen2yuan(t.priceFen));
          if (t.kind) bits.push(`类型:${t.kind}`);
          if (t.statusText) bits.push(t.statusText);
          bits.push(`被排${t.usedCount ?? '—'}次`);
          lines.push(`#${t.id} ${t.name}  ${bits.join(' · ')}`);
        });
        lines.push('');
        if (tplStat) {
          lines.push('【套餐人气分层(测算)】' + tplStat);
          lines.push('');
        }
      }

      if (coupons.length) {
        lines.push('【现有券种（可复用杠杆，勿凭空造 id）】');
        coupons.forEach((c) => {
          lines.push(
            `#${c.id} ${c.name} · 面额 ${fen2yuan(c.faceValueFen)} · 门槛 ${fen2yuan(
              c.thresholdFen,
            )} · ${c.status ?? '状态未知'}`,
          );
        });
        lines.push('');
      }

      lines.push('【可测杠杆说明（无需改代码）】');
      lines.push('· 文案位：招募页/朋友圈/社群话术（节点 B 已可生成草稿）可做图文/话术变体');
      lines.push('· 套餐：现有套餐模板可做「头部套餐图文变体」「价格锚点」对照');
      lines.push('· 券：复用上面「现有券种」#id 做面额/门槛/有效期变体（须经后台批量发券确认）');
      lines.push('· 楼栋：选「规模相近但表现差」的两栋楼做对照（见楼栋差异）');
      lines.push('');

      if (warnings.length) lines.push('【数据提示】' + warnings.join('；'));

      if (!Object.keys(metrics).length && !buildings.length && !tpls.length && !coupons.length)
        return '近 30 天的经营基线、楼栋、套餐与券种数据这次都没取到（可能权限不足或还没开团）。可在后台看板查看，或稍后重试。';

      const plain = lines.join('\n');

      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_ge_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `增长实验数据已生成，但写入临时文件失败（磁盘权限）。可在后台看板查看原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-growth-experiment.mjs');
      if (!existsSync(script)) {
        return `增长实验（原始数据，AI 脚本未找到）：\n\n${plain}`;
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
            `增长实验生成启动失败：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          );
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('增长实验生成超时（>90s）。原始数据已在后台看板，可稍后重试触发。');
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `增长实验生成出错：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          try {
            unlinkSync(plainFile);
          } catch {
            /* noop */
          }
          if (out.trim()) finish(out.trim());
          else
            finish(
              `增长实验生成未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n可在后台看板查看原始数据。`,
            );
        });
      });
    };
    return run();
  }

  /**
   * 节点 K · 风控对账体检（企微触发）
   *
   * 复用现有 svc token（operator 角色已在 FINANCE_VIEW_ROLES 内）直连四个**只读**财务端点，
   * 各自独立 try/catch：任一取数失败都不阻断其余，缺失即标「暂缺」—— 原则零（可剥离、可降级）。
   * 后端预汇总成纯文本，脚本侧只做 AI 解读；**绝不自动平账 / 调账 / 批退款 / 批提现**（人-only）。
   * 基准日取「昨日」（最近一个已闭合的支付日/出餐日），更贴近「今天该看什么」。
   */
  /**
   * AI 编排节点 M · 用户流失预警与智能召回（企微触发）
   * ------------------------------------------------------------------
   * 复用 `resolver.listUsers()` 拉全量用户的「下单次数/最近下单日/状态/绑楼」做逐户流失分群，
   * 叠加 D50 留存统计（整体背景）与现有券种（召回券接地），交给 `gen-churn-recall.mjs`
   * 做 AI 召回方案 + 落盘。
   *
   * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
   *   · 全段包在大 try 内，且各数据源各自 try/catch：任一失败只跳过该段，不整机失败；
   *   · 只取聚合计数 / 分布，绝不把个人昵称·手机号·openid 喂给 LLM（隐私红线）；
   *   · 脚本缺失/启动失败/超时/异常 → 降级为「直接回显原始汇总」，不阻塞应答；
   *   · 只提案不执行：召回券由人工在后台发，绝不自动发券 / 改用户状态 / 代绑楼；
   *   · 触发方式为企微命令，且已并入 L 每日编排（仅分析推送）。
   */
  private genChurnRecall(binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      // 北京日期（本地分量，绝不用 toISOString 退一天）
      // ⚠️ 必须用 `todayBj`（内部走 toISOString），不能「+8h 后读本地分量」：
      //    容器 TZ=Asia/Shanghai，本地分量本就含东八区，再 +8h 会在 16:00 后跨到「明天」，
      //    于是拿明天的日期去查统计（恒空）。2026-11-03 自证：16:27 时该写法得出 11-04。
      const endDate = todayBj(now);
      const RECENCY_THRESHOLD = 14; // 周一周盒：>14 天未下单 = 已错过 ≥2 周，判流失风险
      const nowMs = now.getTime();
      const daysBetween = (s: string | null): number | null => {
        if (!s) return null;
        const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
        if (!Number.isFinite(d.getTime())) return null;
        return Math.floor((nowMs - d.getTime()) / 86400000);
      };

      // 1. 全量用户流失分群
      let userSec = '（暂缺）';
      let seg: {
        total: number;
        normal: number;
        unbound: number;
        blacklist: number;
        canceled: number;
        neverOrdered: number;
        silentRisk: number;
        recentActive: number;
        unknownRecency: number;
        repeatUsers: number;
        avgOrdered: number;
        buckets: Record<string, number>;
      } | null = null;
      try {
        const users = await this.resolver.listUsers();
        if (users && users.length) {
          let normal = 0,
            unbound = 0,
            blacklist = 0,
            canceled = 0;
          let neverOrdered = 0,
            silentRisk = 0,
            recentActive = 0,
            unknownRecency = 0,
            repeatUsers = 0,
            orderedSum = 0,
            orderedN = 0;
          const buckets: Record<string, number> = {
            '15-30天': 0,
            '31-60天': 0,
            '61-90天': 0,
            '90天以上': 0,
          };
          for (const u of users) {
            const st = typeof u.status === 'number' ? u.status : -1;
            if (st === 1) normal++;
            else if (st === 2) blacklist++;
            else if (st === 3) canceled++;
            if (st === 1 && u.buildingId == null) unbound++;
            const oc = Number(u.orderCount ?? 0);
            if (st === 1) {
              if (oc <= 0) {
                neverOrdered++;
                continue;
              }
              orderedSum += oc;
              orderedN++;
              if (oc >= 2) repeatUsers++;
              const rec = daysBetween(u.lastOrderAt ?? null);
              if (rec == null) {
                unknownRecency++;
              } else if (rec > RECENCY_THRESHOLD) {
                silentRisk++;
                if (rec <= 30) buckets['15-30天']++;
                else if (rec <= 60) buckets['31-60天']++;
                else if (rec <= 90) buckets['61-90天']++;
                else buckets['90天以上']++;
              } else {
                recentActive++;
              }
            }
          }
          seg = {
            total: users.length,
            normal,
            unbound,
            blacklist,
            canceled,
            neverOrdered,
            silentRisk,
            recentActive,
            unknownRecency,
            repeatUsers,
            avgOrdered: orderedN ? Number((orderedSum / orderedN).toFixed(2)) : 0,
            buckets,
          };
          const lines: string[] = [];
          lines.push(
            `扫描用户 ${seg.total} 人 · 正常 ${seg.normal} · 黑名单 ${seg.blacklist} · 已注销 ${seg.canceled}`,
          );
          lines.push(`未绑楼（下不了单）：${seg.unbound} 人`);
          lines.push(`已下单用户中：`);
          lines.push(`  · 从未下单（含未绑楼导致的下不了单）：${seg.neverOrdered} 人`);
          lines.push(
            `  · 流失风险（> ${RECENCY_THRESHOLD} 天未下单）：${seg.silentRisk} 人 · 其中 ${unknownRecency} 人最近下单日缺失`,
          );
          lines.push(`  · 近期活跃（≤ ${RECENCY_THRESHOLD} 天）：${seg.recentActive} 人`);
          lines.push(
            `  · 复购用户（≥2 单）：${seg.repeatUsers} 人 · 已下单人均 ${seg.avgOrdered} 单`,
          );
          if (seg.silentRisk > 0) {
            lines.push(
              '  流失风险按沉默时长分布：' +
                Object.entries(seg.buckets)
                  .map(([k, v]) => `${k} ${v}`)
                  .join('、'),
            );
          }
          userSec = lines.join('\n');
        }
      } catch {
        /* 跳过该视角 */
      }

      // 2. D50 留存（整体背景）
      let retainSec = '（暂缺）';
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.retention,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const d = cur.data as {
            summary?: {
              activeUserCount?: number;
              newUserCount?: number;
              returningUserCount?: number;
              repeatUserCount?: number;
              repeatRate?: number;
            };
            cohorts?: Array<{
              cohortStart?: string;
              newUserCount?: number;
              retainedWeek1?: number | null;
              retentionRate1?: number | null;
              observable?: boolean;
            }>;
          };
          const s = d.summary ?? {};
          const lines: string[] = [];
          lines.push(
            `近 30 天：活跃 ${s.activeUserCount ?? '?'} · 新客 ${s.newUserCount ?? '?'} · 回流 ${s.returningUserCount ?? '?'} · 复购 ${s.repeatUserCount ?? '?'} · 复购率 ${s.repeatRate != null ? (s.repeatRate * 100).toFixed(1) + '%' : '?'}`,
          );
          const obs = (d.cohorts ?? []).filter((c) => c.observable && c.retentionRate1 != null);
          if (obs.length) {
            lines.push(
              '可观测 cohort 次周留存：' +
                obs
                  .map(
                    (c) =>
                      `${c.cohortStart?.slice(5) ?? '?'} ${(Number(c.retentionRate1) * 100).toFixed(0)}%(${c.retainedWeek1 ?? '?'}/${c.newUserCount ?? '?'})`,
                  )
                  .join('、'),
            );
          } else {
            lines.push('可观测 cohort 次周留存：暂无可观测样本（观察窗口未走完）');
          }
          retainSec = lines.join('\n');
        }
      } catch {
        /* 跳过该视角 */
      }

      // 3. 现有券种（召回券接地，避免 AI 凭空造 id）
      let couponSec = '（暂缺）';
      try {
        const defs = await this.resolver.listCouponDefs();
        if (defs && defs.length) {
          couponSec = defs
            .slice(0, 10)
            .map(
              (c) =>
                `  · #${c.id} ${c.name} 面额¥${((c.faceValueFen || 0) / 100).toFixed(2)} 门槛¥${((c.thresholdFen || 0) / 100).toFixed(2)}（${c.status ?? '?'})`,
            )
            .join('\n');
        }
      } catch {
        /* 跳过 */
      }

      const lines: string[] = [];
      lines.push(
        `用户流失预警与召回数据 · 基准日 ${endDate}（数值均为系统实读汇总，已脱敏，不含个人信息）`,
      );
      lines.push('');
      lines.push('【一、全量用户流失分群】');
      lines.push(userSec);
      lines.push('');
      lines.push('【二、D50 留存背景（近 30 天）】');
      lines.push(retainSec);
      lines.push('');
      lines.push('【三、现有可复用券种（召回券接地用）】');
      lines.push(couponSec);
      lines.push('');
      lines.push(
        '说明：以上为系统实读汇总；个人昵称/手机号/openid 未进入本数据。召回券需人工在后台发放，本节点不自动发券。',
      );

      const plain = lines.join('\n');

      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_churn_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `用户流失预警数据已生成，但写入临时文件失败（磁盘权限）。可在后台用户管理查看原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-churn-recall.mjs');
      if (!existsSync(script)) {
        return `用户流失预警（原始数据，AI 脚本未找到）：\n\n${plain}`;
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
            `用户流失预警生成启动失败：${e instanceof Error ? e.message : String(e)}。可在后台用户管理查看原始数据。`,
          );
          return;
        }

        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('用户流失预警生成超时（>90s）。原始数据已在后台用户管理，可稍后重试触发。');
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `用户流失预警生成出错：${e instanceof Error ? e.message : String(e)}。可在后台用户管理查看原始数据。`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          try {
            unlinkSync(plainFile);
          } catch {
            /* noop */
          }
          if (out.trim()) finish(out.trim());
          else
            finish(
              `用户流失预警生成未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n可在后台用户管理查看原始数据。`,
            );
        });
      });
    };
    return run();
  }

  /**
   * AI 编排节点 N · 团长健康度与流失风险（企微触发）
   * ------------------------------------------------------------------
   * 与节点 G 的分工：**G 负责招（缺口在哪），N 负责养（招来的人有没有掉队）**。
   * 数据只用 `resolver.listLeaders()`（`admin/leaders?view=roster&status=1`）一次取全，
   * 分档判据全部走纯函数 `leader-health.ts`（有单测，阈值改错会被拦下）。
   *
   * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
   *   · 全段包在大 try 内，楼群覆盖另起 try/catch：一是失败不影响另一段，不整机失败；
   *   · **不取姓名/手机号/nickname/openid**，输出用「楼栋名 + 团长#id」定位；
   *   · **不读佣金余额**（`total_commission` 是快照、`balance` 列恒 0，会算出假亏损），
   *     钱的口径归节点 K；
   *   · 脚本缺失/超时/异常 → 降级为回显原始汇总，不阻塞应答；
   *   · 只提案不执行：停职/换人/改佣金必须人工在后台做，本节点绝不写库；
   *   · 已并入 L 每日编排（仅分析推送）。
   */
  private genLeaderHealth(_binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      // 同上：用 todayBj，别用「+8h 后读本地分量」（TZ=Asia/Shanghai 会双平移）
      const today = todayBj(now);
      const nowMs = now.getTime();

      const BAND_LABEL: Record<string, string> = {
        new: '新上任（<7 天，不参与流失判定）',
        healthy: '健康（7 天内有出单）',
        watch: '待唤醒（8~14 天无单）',
        dormant: '沉睡（>14 天无单）',
        never: '从未出单（有任职、无任何订单记录）',
      };

      let rosterSec = '（暂缺）';
      let dormantSec = '（暂缺）';
      let blockSec = '（暂缺）';
      let promoteSec = '（暂缺）';
      let coverSec = '（暂缺）';
      let items: LeaderHealthItem[] = [];
      let total = 0;

      // 1. 名册汇总 + 三张清单
      try {
        const rows = await this.resolver.listLeaders();
        if (rows && rows.length) {
          const { items: judged, totals } = summarizeLeaderHealth(rows, nowMs);
          items = judged;
          total = totals.total;

          const lines: string[] = [];
          lines.push(
            `在职团长 ${totals.total} 人 · 覆盖楼栋 ${new Set(items.map((i) => i.buildingName ?? '?')).size} 个`,
          );
          for (const band of ['new', 'healthy', 'watch', 'dormant', 'never']) {
            const n = totals.byBand[band as keyof typeof totals.byBand] ?? 0;
            lines.push(`  · ${BAND_LABEL[band]}：${n} 人`);
          }
          lines.push(
            `本月单量分布：0 单 ${totals.orderBuckets['0']} 人 · 1-20 单 ${totals.orderBuckets['1-20']} 人 · ` +
              `21-60 单 ${totals.orderBuckets['21-60']} 人 · 61-100 单 ${totals.orderBuckets['61-100']} 人 · ` +
              `100 单以上 ${totals.orderBuckets['100+']} 人`,
          );
          lines.push(
            `卡点：未绑收款 ${totals.payoutUnbound} 人 · 协议待补签 ${totals.agreementStale} 人 · ` +
              `「沉睡且带卡点」（最该先打电话）${totals.blockedAndSilent} 人`,
          );
          rosterSec = lines.join('\n');

          // 沉睡 / 从未出单清单（never 排最前：从没出过单比久未出单更急）
          const silent = items
            .filter((i) => i.band === 'dormant' || i.band === 'never')
            .sort((a, b) => (b.silentDays ?? 9999) - (a.silentDays ?? 9999));
          dormantSec = silent.length
            ? silent
                .slice(0, 10)
                .map((i) => '  · ' + describeLeader(i))
                .join('\n') + (silent.length > 10 ? `\n  … 另有 ${silent.length - 10} 人` : '')
            : '  无（所有在职团长 14 天内都出过单）';

          // 卡点清单
          const blocked = items.filter((i) => i.blockers.length > 0);
          blockSec = blocked.length
            ? blocked
                .slice(0, 10)
                .map((i) => '  · ' + describeLeader(i))
                .join('\n') + (blocked.length > 10 ? `\n  … 另有 ${blocked.length - 10} 人` : '')
            : '  无（收款与协议都已齐备）';

          // 近晋级（推一把就能升级，最划算的激励抓手）
          const near = items.filter(
            (i) =>
              i.gapToNextLevel && i.gapToNextLevel.orders <= 10 && i.gapToNextLevel.referrals <= 1,
          );
          promoteSec = near.length
            ? near
                .slice(0, 8)
                .map((i) => '  · ' + describeLeader(i))
                .join('\n') + (near.length > 8 ? `\n  … 另有 ${near.length - 8} 人` : '')
            : '  无（暂无人接近下一等级门槛）';
        } else if (rows && rows.length === 0) {
          rosterSec = '在职团长 0 人（尚未任命任何团长）';
          dormantSec = '  无';
          blockSec = '  无';
          promoteSec = '  无';
        }
      } catch {
        /* 跳过该视角 */
      }

      // 2. 楼群覆盖（在营楼群里有多少已经有团长）
      try {
        const groups = await this.resolver.listGroups();
        if (groups && groups.length) {
          const activeGroups = groups.filter((g) => g.status === undefined || g.status === 1);
          // 团长 roster 只带 groupName（纯函数刻意没留 groupId），按名字对齐即可
          const coveredNames = new Set(
            activeGroups
              .filter((g) => items.some((i) => i.groupName != null && i.groupName === g.name))
              .map((g) => g.name),
          );
          const rate = activeGroups.length
            ? Math.round((coveredNames.size / activeGroups.length) * 1000) / 10
            : null;
          coverSec =
            `在营楼群 ${activeGroups.length} 个 · 已有团长 ${coveredNames.size} 个 · 覆盖率 ` +
            (rate == null ? '暂缺' : `${rate}%`) +
            (activeGroups.length - coveredNames.size > 0
              ? ` · 缺口 ${activeGroups.length - coveredNames.size} 个楼群（招募优先级见节点 G）`
              : '');
        }
      } catch {
        /* 跳过 */
      }

      const lines: string[] = [];
      lines.push(`团长健康度数据 · 基准日 ${today}（系统实读；不含姓名/手机号等个人信息）`);
      lines.push('');
      lines.push('【一、在职团长名册汇总】');
      lines.push(rosterSec);
      lines.push('');
      lines.push('【二、沉睡与从未出单清单（按沉默时长降序，最多 10 条）】');
      lines.push(dormantSec);
      lines.push('');
      lines.push('【三、卡点清单（未绑收款 / 协议待补签）】');
      lines.push(blockSec);
      lines.push('');
      lines.push('【四、近晋级清单（差 ≤10 单且 ≤1 人转正）】');
      lines.push(promoteSec);
      lines.push('');
      lines.push('【五、楼群覆盖】');
      lines.push(coverSec);
      lines.push('');
      lines.push(
        `说明：分档阈值 —— 新上任 <7 天不参与流失判定；7 天内健康；8~14 天待唤醒；>14 天沉睡；` +
          `有任职但无任何订单记录为「从未出单」。共判定 ${total} 人。` +
          `停职/换人/改佣金须人工在后台操作，本节点只提案不执行。`,
      );

      const plain = lines.join('\n');

      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_leader_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `团长健康度数据已生成，但写入临时文件失败（磁盘权限）。可在后台团长管理查看原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-leader-health.mjs');
      if (!existsSync(script)) {
        return `团长健康度（原始数据，AI 脚本未找到）：\n\n${plain}`;
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
            `团长健康度生成启动失败：${e instanceof Error ? e.message : String(e)}。可在后台团长管理查看原始数据。`,
          );
          return;
        }

        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('团长健康度生成超时（>90s）。原始数据已在后台团长管理，可稍后重试触发。');
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `团长健康度生成出错：${e instanceof Error ? e.message : String(e)}。可在后台团长管理查看原始数据。`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          try {
            unlinkSync(plainFile);
          } catch {
            /* noop */
          }
          if (out.trim()) finish(out.trim());
          else
            finish(
              `团长健康度生成未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n可在后台团长管理查看原始数据。`,
            );
        });
      });
    };
    return run();
  }

  /**
   * AI 编排节点 O · 经营健康度总分（Health Score）
   * ------------------------------------------------------------------
   * 把「散在七个节点里的判断」收成一个数与一个红黄绿，作为每日 09:00 推送的封面。
   * 五个维度各 20 分（增长 / 留存 / 资金 / 履约 / 组织），判据全在纯函数
   * `health-score.ts`（有单测）。
   *
   * 三条设计取舍：
   *   ① **独立取数，不读其它节点的文本**：节点互相依赖会让一次失败连锁扣分，
   *      而 AI 文案里抽数字最容易出错。这里只读接口原始数。
   *   ② **缺数据不计分母**：某维取不到就不进分母（总分按已测维度折算），
   *      并把「已测 N/5 维、缺哪几维」原样印出来。宁可少说，也不给一个假分的低分。
   *   ③ **只分析不执行**：分数低只影响封面颜色与建议，绝不触发任何写操作。
   *
   * 原则零：全段大 try，各数据源独立 try/catch；脚本缺失/超时即回显原始打分；
   * 历史分写盘失败只影响「较上次」，不影响今日结论。
   */
  private genHealthScore(binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      const today = bjTodayStr(now);
      if (!today) return '取不到今天的日期，我先不动。稍后再试。';
      // 昨天：bjYmdPlus 走 UTC 分量，天然免疫容器 TZ（别用「+8h 后读本地分量」）
      const yDate = bjYmdPlus(now, -1);
      const nowMs = now.getTime();

      // 与节点 E 日报同口径：近 7 天，截止最近一个闭合日
      const base = { which: 'dashboard' as const, range: '7d' as const, endShift: -1 };
      const endDate = endDateOf(base, today);
      const prevEnd = prevEndDateOf(base, endDate);

      const input: HealthScoreInput = {};
      const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      const metricsOf = (data: unknown): Record<string, unknown> | null => {
        const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
        const m = d?.metrics;
        return m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
      };
      const deltaRate = (cur: number | null, prev: number | null): number | null => {
        if (cur == null || prev == null || prev <= 0) return null;
        return (cur - prev) / prev;
      };
      const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

      // 1. 经营看板（增长维 + 履约维的退款率）
      let boardSec = '（暂缺）';
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.dashboard,
          { range: '7d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const m = metricsOf(cur.data);
          const board = summarizeDashboard(cur.data);
          const parts: string[] = [];
          if (board) parts.push(board);
          const prev = await this.proxy.query(
            STATS_QCODE.dashboard,
            { range: '7d', date: prevEnd },
            binding,
          );
          const pm = prev.code === 0 ? metricsOf(prev.data) : null;
          if (m) {
            input.gmvDeltaRate = deltaRate(num(m.gmvFen), num(pm?.gmvFen));
            input.orderDeltaRate = deltaRate(num(m.orderCount), num(pm?.orderCount));
            input.refundRate = num(m.refundRate);
          }
          if (pm) {
            const cmp = compareDashboard(cur.data, prev.data).join('\n').trim();
            if (cmp) parts.push(cmp);
          }
          boardSec = parts.length ? parts.join('\n') : '（看板结构认不出）';
        }
      } catch {
        /* 跳过该视角 */
      }

      // 2. 留存（复购率 + cohort 次周留存）
      let retainSec = '（暂缺）';
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.retention,
          { range: '30d', date: endDate },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const d = cur.data as {
            summary?: { repeatRate?: number; repeatUserCount?: number; newUserCount?: number };
            cohorts?: Array<{
              newUserCount?: number;
              retainedWeek1?: number | null;
              observable?: boolean;
            }>;
          };
          const s = d.summary ?? {};
          input.repeatRate = num(s.repeatRate);
          // 次周留存用「可观测 cohort 的加权留存」，比均值稳（小 cohort 不放大噪声）
          const obs = (d.cohorts ?? []).filter(
            (c) => c.observable && c.retainedWeek1 != null && Number(c.newUserCount) > 0,
          );
          if (obs.length) {
            const retained = obs.reduce((a, c) => a + Number(c.retainedWeek1 ?? 0), 0);
            const baseUsers = obs.reduce((a, c) => a + Number(c.newUserCount ?? 0), 0);
            input.week1Retention = baseUsers > 0 ? retained / baseUsers : null;
          }
          const lines: string[] = [];
          if (input.repeatRate != null) lines.push(`近 30 天复购率 ${pct(input.repeatRate)}`);
          if (input.week1Retention != null)
            lines.push(
              `可观测 cohort 加权次周留存 ${pct(input.week1Retention)}（${obs.length} 个 cohort）`,
            );
          if (!lines.length) lines.push('（留存数据暂缺）');
          retainSec = lines.join(' · ');
        }
      } catch {
        /* 跳过 */
      }

      // 3. 资金（对账平衡 + 退款积压 + 提现积压）
      let cashSec = '（暂缺）';
      try {
        const lines: string[] = [];
        const recon = await this.resolver.getReconciliation(yDate);
        if (recon?.summary) {
          input.reconBalanced = Boolean(recon.summary.balanced);
          lines.push(
            `支付日 ${recon.date ?? yDate}：${recon.summary.balanced ? '本地三头已平' : '存在不平'}` +
              (recon.summary.diffCount ? ` · 差异 ${recon.summary.diffCount} 笔` : ''),
          );
        }
        const refunds = await this.resolver.getRefunds('pending');
        if (refunds?.summary) {
          input.refundPendingCount = num(refunds.summary.pendingCount);
          lines.push(`退款待审批 ${refunds.summary.pendingCount ?? 0} 笔`);
        }
        const withdrawals = await this.resolver.getWithdrawals('review');
        if (withdrawals?.summary) {
          input.withdrawPendingCount = num(withdrawals.summary.pendingCount);
          lines.push(`提现待审批 ${withdrawals.summary.pendingCount ?? 0} 笔`);
        }
        if (lines.length) cashSec = lines.join(' · ');
      } catch {
        /* 跳过 */
      }

      // 4. 履约（应付未出单异常）
      let fulfillSec = '（暂缺）';
      try {
        const ex = await this.resolver.getShareExceptions(yDate);
        if (ex?.summary) {
          input.shareExceptionCount = num(ex.summary.count);
          fulfillSec =
            `出餐日 ${yDate} 应付未出单异常 ${ex.summary.count ?? 0} 项` +
            (ex.summary.supplierCount ? ` · 涉及供应商 ${ex.summary.supplierCount}` : '');
          if (input.refundRate != null) fulfillSec += ` · 近 7 天退款率 ${pct(input.refundRate)}`;
        }
      } catch {
        /* 跳过 */
      }

      // 5. 组织（团长覆盖 + 团长活跃）
      let orgSec = '（暂缺）';
      try {
        const lines: string[] = [];
        const rows = await this.resolver.listLeaders();
        if (rows && rows.length) {
          const { totals } = summarizeLeaderHealth(rows, nowMs);
          input.activeLeaderRate = totals.total > 0 ? totals.byBand.healthy / totals.total : null;
          lines.push(
            `在职团长 ${totals.total} 人 · 近 7 天有出单 ${totals.byBand.healthy} 人` +
              (input.activeLeaderRate != null ? `（活跃率 ${pct(input.activeLeaderRate)}）` : ''),
          );
          const groups = await this.resolver.listGroups();
          if (groups && groups.length) {
            const activeGroups = groups.filter((g) => g.status === undefined || g.status === 1);
            const covered = activeGroups.filter((g) =>
              rows.some((r) => r.groupName != null && r.groupName === g.name),
            );
            input.leaderCoverageRate = activeGroups.length
              ? covered.length / activeGroups.length
              : null;
            lines.push(
              `楼群覆盖 ${covered.length}/${activeGroups.length}` +
                (input.leaderCoverageRate != null ? `（${pct(input.leaderCoverageRate)}）` : ''),
            );
          }
        } else if (rows && rows.length === 0) {
          lines.push('在职团长 0 人（尚未任命）');
        }
        if (lines.length) orgSec = lines.join(' · ');
      } catch {
        /* 跳过 */
      }

      const result = computeHealthScore(input);

      // 历史分（趋势）：写盘失败不影响今日结论
      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const prevScore = this.readPrevHealthScore(tmpDir, endDate);
      if (result.score != null) this.appendHealthScore(tmpDir, endDate, result.score);

      const gradeZh =
        result.grade === 'green'
          ? '绿色'
          : result.grade === 'yellow'
            ? '黄色'
            : result.grade === 'red'
              ? '红色'
              : '—';
      const gradeNote =
        result.grade === 'green'
          ? '健康'
          : result.grade === 'yellow'
            ? '需关注'
            : result.grade === 'red'
              ? '高风险'
              : '未评级';
      let deltaText = '';
      if (result.score != null && prevScore != null) {
        const d = result.score - prevScore.score;
        deltaText = ` · 较上次（${prevScore.date.slice(5)} · ${prevScore.score} 分）${d === 0 ? '持平' : d > 0 ? `+${d}` : `${d}`}`;
      }

      const lines: string[] = [];
      lines.push(`经营健康度总分 · 基准窗口截止 ${endDate}（五维各 20 分，共 100）`);
      lines.push('');
      if (result.score == null) {
        lines.push('总分：未能计算（五个维度全部取不到数据）');
      } else {
        lines.push(`总分：${result.score} / 100 · ${gradeZh}（${gradeNote}）${deltaText}`);
        lines.push(
          `已测 ${result.measuredWeight / 20}/5 维 · 满分口径 ${result.measuredWeight} 分` +
            (result.missing.length ? ` · 缺失：${result.missing.join('、')}（不计入分母）` : ''),
        );
      }
      lines.push('');
      lines.push('【一、分维得分】');
      for (const d of result.dimensions) {
        const verdict = d.measured
          ? d.score / d.max >= 0.8
            ? '良好'
            : d.score / d.max >= 0.6
              ? '中性'
              : d.score / d.max >= 0.4
                ? '偏弱'
                : '偏差'
          : '数据暂缺';
        lines.push(`  · ${d.label} ${d.measured ? `${d.score}/20` : '—/20'}（${verdict}）`);
      }
      const weak = weakestDimension(result.dimensions);
      if (weak) lines.push(`  · 当前最短板：${weak.label}（${weak.score}/20）`);
      lines.push('');
      lines.push('【二、经营看板（近 7 天，含环比）】');
      lines.push(boardSec);
      lines.push('');
      lines.push('【三、留存】');
      lines.push(retainSec);
      lines.push('');
      lines.push('【四、资金】');
      lines.push(cashSec);
      lines.push('');
      lines.push('【五、履约】');
      lines.push(fulfillSec);
      lines.push('');
      lines.push('【六、组织（团长）】');
      lines.push(orgSec);
      lines.push('');
      lines.push(
        '说明：分维阈值与等级线（≥80 绿 / ≥60 黄 / <60 红）由系统纯函数判定；' +
          '缺失维度不计入分母，故「已测维度数」必须一并转述。分数只用于判断优先级，不触发任何自动操作。',
      );

      const plain = lines.join('\n');

      // 封面徽标（供 composeDigest 使用）
      this.lastHealthBadge =
        result.score == null
          ? '经营健康度：未能计算（数据缺失）'
          : `经营健康度：${result.score}/100 · ${gradeZh}（${gradeNote}）${deltaText}`;

      const plainFile = join(tmpDir, `_health_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `经营健康度已算出，但写入临时文件失败（磁盘权限）。原始打分：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-health-score.mjs');
      if (!existsSync(script)) {
        return `经营健康度（原始打分，AI 脚本未找到）：\n\n${plain}`;
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
            `经营健康度解读启动失败：${e instanceof Error ? e.message : String(e)}。原始打分：\n\n${plain}`,
          );
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('经营健康度解读超时（>90s）。原始打分：\n\n' + plain);
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `经营健康度解读出错：${e instanceof Error ? e.message : String(e)}。原始打分：\n\n${plain}`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          try {
            unlinkSync(plainFile);
          } catch {
            /* noop */
          }
          if (out.trim()) finish(out.trim());
          else
            finish(
              `经营健康度解读未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n\n原始打分：\n${plain}`,
            );
        });
      });
    };
    return run();
  }

  /**
   * 读上一份健康度分数（严格取「日期早于今天」的最大一条）。
   * 任何异常都返回 null：没有趋势只是少半句话，不该让整段结论失败。
   */
  private readPrevHealthScore(dir: string, date: string): { date: string; score: number } | null {
    try {
      const p = join(dir, 'health-score-history.json');
      if (!existsSync(p)) return null;
      const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return null;
      const rows = raw.filter(
        (r): r is { date: string; score: number } =>
          Boolean(r) &&
          typeof (r as { date?: unknown }).date === 'string' &&
          typeof (r as { score?: unknown }).score === 'number',
      );
      const older = rows.filter((r) => r.date < date).sort((a, b) => (a.date < b.date ? 1 : -1));
      return older[0] ?? null;
    } catch {
      return null;
    }
  }

  /** 追加当日分数（同日覆盖），只留最近 90 条；失败静默（不影响结论） */
  private appendHealthScore(dir: string, date: string, score: number): void {
    try {
      const p = join(dir, 'health-score-history.json');
      let rows: Array<{ date: string; score: number }> = [];
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
        if (Array.isArray(raw)) {
          rows = raw.filter(
            (r): r is { date: string; score: number } =>
              Boolean(r) &&
              typeof (r as { date?: unknown }).date === 'string' &&
              typeof (r as { score?: unknown }).score === 'number',
          );
        }
      }
      const next = [...rows.filter((r) => r.date !== date), { date, score }]
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .slice(-90);
      writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
    } catch {
      /* 趋势不可用，不影响今日结论 */
    }
  }

  /**
   * 节点 P · 社群/私域运营助手（企微触发 + 每日编排）
   * 只出「排期 + 话术 + 朋友圈文案」草案，**不自动发群、不自动发券、不加好友**。
   * 判据（哪几栋楼该放量/唤醒）在 community-plan.ts 纯函数里，这里只负责取数与拼装。
   */
  private genCommunityPlan(binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      const today = todayBj(now);
      const nowMs = now.getTime();

      // 1. 靶楼分层（复用 N 的 band 判据，不另写阈值）
      let tierSec = '（暂缺）';
      let detailSec = '（暂缺）';
      try {
        const rows = await this.resolver.listLeaders();
        if (rows && rows.length) {
          const { items } = summarizeLeaderHealth(rows, nowMs);
          const t = pickCommunityTargets(items);
          tierSec = [
            `在职团长 ${items.length} 人 · 其中新上任 ${t.newCount} 人（<7 天，不参与沉默判定）`,
            describeTargets(t),
            `放量门槛：本月 ≥ ${AMPLIFY_MIN_ORDERS} 单才归「放量」（有量可放大时，社群该加码而不是唤醒）`,
          ].join('\n');

          const d: string[] = [];
          if (t.focus.length) {
            d.push('主战场（本月单量最高，社群主推这里）：');
            for (const x of t.focus) {
              d.push(
                `  · ${x.buildingName ?? `团长#${x.leaderId}`} 本月 ${x.monthOrders} 单 · 累计 ${x.totalOrders} 单`,
              );
            }
          }
          if (t.wake.length) {
            d.push('待唤醒（8~14 天没单，一条群消息就能拉回）：');
            for (const x of t.wake) {
              d.push(
                `  · ${x.buildingName ?? `团长#${x.leaderId}`} 距最近出单 ${x.silentDays ?? '?'} 天 · 本月 ${x.monthOrders} 单`,
              );
            }
          }
          if (t.mustWake.length) {
            d.push('最该先救的沉默楼（历史有量，救回来的概率最高）：');
            for (const x of t.mustWake) {
              const silent = x.silentDays == null ? '从未出单' : `距最近出单 ${x.silentDays} 天`;
              d.push(
                `  · ${x.buildingName ?? `团长#${x.leaderId}`} 累计 ${x.totalOrders} 单 · ${silent} · 本月 ${x.monthOrders} 单`,
              );
            }
          }
          detailSec = d.length ? d.join('\n') : '（无需要单独点名的楼栋）';
        }
      } catch {
        /* 该视角跳过 */
      }

      // 2. 当期可排套餐（社群发的就是这张菜单，不能凭空编菜名）
      let menuSec = '（暂缺）';
      try {
        const tpls = await this.resolver.listTemplatesFull();
        if (tpls && tpls.length) {
          const picked = tpls.filter((t) => t.status === 1).slice(0, 8);
          menuSec =
            picked.length === 0
              ? '（当前没有启用中的套餐）'
              : `启用中套餐（共 ${tpls.filter((t) => t.status === 1).length} 个，列前 ${picked.length} 个）：\n` +
                picked
                  .map(
                    (t) =>
                      `  · ${t.name ?? '未命名'} ¥${((Number(t.priceFen) || 0) / 100).toFixed(2)}`,
                  )
                  .join('\n');
        }
      } catch {
        /* 跳过 */
      }

      // 3. 现有券种（话术里要提券就提这几张，不许编 id）
      let couponSec = '（暂缺）';
      try {
        const defs = await this.resolver.listCouponDefs();
        if (defs && defs.length) {
          couponSec = defs
            .slice(0, 8)
            .map(
              (c) =>
                `  · #${c.id} ${c.name} 面额¥${((c.faceValueFen || 0) / 100).toFixed(2)} 门槛¥${((c.thresholdFen || 0) / 100).toFixed(2)}（${c.status ?? '?'}）`,
            )
            .join('\n');
        }
      } catch {
        /* 跳过 */
      }

      // 4. 留存背景（群运营的抓手是复购，不是拉新）
      let retainSec = '（暂缺）';
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.retention,
          { range: '30d', date: today },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const txt = summarizeRetention(cur.data);
          if (txt) retainSec = txt;
        }
      } catch {
        /* 跳过 */
      }

      const lines: string[] = [];
      lines.push(`社群运营数据 · 基准日 ${today}（数值均为系统实读汇总，不含团长姓名/手机号）`);
      lines.push('');
      lines.push('【一、靶楼分层】');
      lines.push(tierSec);
      lines.push('');
      lines.push('【二、重点楼栋】');
      lines.push(detailSec);
      lines.push('');
      lines.push('【三、当期可排套餐】');
      lines.push(menuSec);
      lines.push('');
      lines.push('【四、现有券种】');
      lines.push(couponSec);
      lines.push('');
      lines.push('【五、留存背景（近 30 天）】');
      lines.push(retainSec);
      lines.push('');
      lines.push(
        '说明：分档阈值为系统判定（新上任 <7 天不参与沉默判定、7 天内健康、8~14 天待唤醒、>14 天沉睡）；放量/唤醒/沉默三档互斥。本节点只出提案，发群、发券、加好友均须人工执行。',
      );

      const plain = lines.join('\n');
      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_community_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `社群运营数据已生成，但写入临时文件失败（磁盘权限）。原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-community-plan.mjs');
      if (!existsSync(script)) {
        return `社群运营方案（原始数据，AI 脚本未找到）：\n\n${plain}`;
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
            `社群运营方案生成启动失败：${e instanceof Error ? e.message : String(e)}。原始数据见上。`,
          );
          return;
        }
        let out = '';
        child.stdout?.on('data', (b: Buffer) => {
          out += b.toString('utf8');
        });
        child.stderr?.on('data', () => {
          /* 脚本自会降级，stderr 只用于日志 */
        });
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish(
            out.trim() ||
              `社群运营方案生成超时（90 秒）。稍后再试，或直接在后台按上表人工编排。\n\n${plain}`,
          );
        }, 90_000);
        child.on('error', (e) => {
          clearTimeout(timer);
          finish(`社群运营方案生成失败：${e.message}。\n\n${plain}`);
        });
        child.on('close', () => {
          clearTimeout(timer);
          const text = out.trim();
          finish(text || `AI 未产出内容，附原始数据：\n\n${plain}`);
        });
      });
    };

    return run().catch(
      (e: unknown) =>
        `社群运营方案生成出错：${e instanceof Error ? e.message : String(e)}。这条不影响其他功能，稍后可重试。`,
    );
  }

  /**
   * 节点 Q · 退款根因聚类（企微触发 + 每日编排）
   * 聚类口径在 refund-cluster.ts 纯函数里（算数不进 LLM），这里只取数与拼装。
   * 只提案：不自动通过/驳回退款、不改订单状态。
   */
  private genRefundCluster(binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      const today = todayBj(now);
      const cutoffYmd = bjYmdPlus(now, -29); // 30 天窗口（含今天）

      // 1. 退款率背景（看板口径，与逐笔聚类不同源，必须分开说）
      let bgSec = '（暂缺）';
      try {
        const cur = await this.proxy.query(
          STATS_QCODE.dashboard,
          { range: '30d', date: today },
          binding,
        );
        if (cur.code === 0 && cur.data) {
          const txt = summarizeDashboard(cur.data);
          if (txt) bgSec = txt;
        }
      } catch {
        /* 跳过 */
      }

      // 2. 逐笔聚类
      let clusterSec = '（暂缺）';
      let sampleNote = '';
      try {
        const rows = await this.resolver.listRefundRows(100);
        if (rows && rows.length) {
          const r = clusterRefunds(rows, { cutoffYmd, windowDays: 30, topN: 8 });
          sampleNote = `样本：最近 ${rows.length} 笔退款里落在近 30 天窗口内的 ${r.total} 笔（接口无日期区间参数，非全量）`;
          if (r.total === 0) {
            clusterSec = `近 30 天窗口内没有退款样本（已拉到 ${rows.length} 笔，均早于 ${cutoffYmd}）。`;
          } else {
            const cl: string[] = [];
            // 一句话结论放最前，与摘要/降级话术共用同一个 describer（避免两处口径打架）
            cl.push(describeRefundCluster(r));
            cl.push(`笔均 ¥${((r.totalAmountFen || 0) / r.total / 100).toFixed(2)}`);
            cl.push(
              `未标注原因 ${r.unlabeled.count} 笔（${(r.unlabeled.share * 100).toFixed(1)}%）` +
                (r.unlabeled.warning
                  ? ' ⚠️ 超过三成，原因分布不可信，先把「退款原因」设成必填更值钱'
                  : ''),
            );
            cl.push('按原因聚类（笔数降序，占比以窗口内为分母）：');
            for (const c of r.clusters) {
              cl.push(
                `  · ${c.key} ${c.count} 笔 · ¥${((c.amountFen || 0) / 100).toFixed(2)}（笔均 ¥${((c.avgAmountFen || 0) / 100).toFixed(2)}）· 占 ${(c.share * 100).toFixed(1)}%`,
              );
              for (const s of c.samples) cl.push(`      原话：「${s}」`);
            }
            cl.push(
              '按金额分档：' + r.amountBuckets.map((b) => `${b.key} ${b.count} 笔`).join(' · '),
            );
            if (r.sourceMix.length) {
              cl.push('申请来源：' + r.sourceMix.map((s) => `${s.key} ${s.count} 笔`).join(' · '));
            }
            cl.push(
              `重复退款：涉及用户 ${r.repeat.distinctUsers} 人，其中退过 2 笔以上 ${r.repeat.repeatedUsers} 人（单人最多 ${r.repeat.maxPerUser} 笔）`,
            );
            clusterSec = cl.join('\n');
          }
        }
      } catch {
        /* 跳过 */
      }

      const lines: string[] = [];
      lines.push(`退款根因数据 · 基准日 ${today}（数值均为系统实读汇总，不含昵称/手机号）`);
      lines.push('');
      lines.push('【一、退款率背景（看板口径，近 30 天）】');
      lines.push(bgSec);
      lines.push('');
      lines.push('【二、逐笔退款聚类（近 30 天窗口）】');
      lines.push(clusterSec);
      if (sampleNote) {
        lines.push('');
        lines.push(sampleNote);
      }
      lines.push('');
      lines.push(
        '说明：聚类按后台归一的「退款原因」归类，缺失原因记为「未标注原因」，不做推断归类；两条口径（看板退款率 / 逐笔聚类）来源不同，不可互相校验金额。本节点只提案，退款审批与订单状态仍须人工在后台操作。',
      );

      const plain = lines.join('\n');
      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_refund_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `退款聚类数据已生成，但写入临时文件失败（磁盘权限）。原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-refund-cluster.mjs');
      if (!existsSync(script)) {
        return `退款根因分析（原始数据，AI 脚本未找到）：\n\n${plain}`;
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
            `退款根因分析生成启动失败：${e instanceof Error ? e.message : String(e)}。原始数据见上。`,
          );
          return;
        }
        let out = '';
        child.stdout?.on('data', (b: Buffer) => {
          out += b.toString('utf8');
        });
        child.stderr?.on('data', () => {
          /* 脚本自会降级 */
        });
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish(out.trim() || `退款根因分析生成超时（90 秒）。\n\n${plain}`);
        }, 90_000);
        child.on('error', (e) => {
          clearTimeout(timer);
          finish(`退款根因分析生成失败：${e.message}。\n\n${plain}`);
        });
        child.on('close', () => {
          clearTimeout(timer);
          const text = out.trim();
          finish(text || `AI 未产出内容，附原始数据：\n\n${plain}`);
        });
      });
    };

    return run().catch(
      (e: unknown) =>
        `退款根因分析生成出错：${e instanceof Error ? e.message : String(e)}。这条不影响其他功能，稍后可重试。`,
    );
  }

  private genRiskRecon(binding: Binding, now: Date): Promise<string> {
    const run = async (): Promise<string> => {
      // 北京日期（本地分量，绝不用 toISOString 退一天）
      // 同上：bjYmdPlus 走 UTC 分量，不受容器 TZ 影响
      const yDate = bjYmdPlus(now, -1);
      const fen2yuan = (fen: number): string => `¥${((fen || 0) / 100 || 0).toFixed(2)}`;

      // 1. 支付对账（核心）
      let recon = '（暂缺）';
      try {
        const r = await this.resolver.getReconciliation(yDate);
        if (r) {
          const s = r.summary ?? {};
          const lines: string[] = [];
          lines.push(`支付日 ${r.date ?? yDate}（${r.anchorLabel ?? '支付日'}）`);
          lines.push(
            `渠道：${r.channel?.source === 'bill' ? '已接入微信账单' : '本地三头核对（未接入微信账单，billAvailable=' + String(r.channel?.billAvailable ?? false) + '）'}`,
          );
          lines.push(
            `对账结论：${s.balanced ? '本地三头已平' : '存在不平'}` +
              `${s.diffCount ? ` · 差异 ${s.diffCount} 笔` : ''}` +
              (s.diffFen ? ` · 差额 ${fen2yuan(s.diffFen)}` : ''),
          );
          lines.push(
            `金额：订单侧 ${fen2yuan(s.orderFen ?? 0)} / 流水侧 ${fen2yuan(s.logFen ?? 0)} / 当日退款 ${fen2yuan(s.refundFen ?? 0)} / 净入账 ${fen2yuan(s.netFen ?? 0)}`,
          );
          lines.push(
            `笔数：订单 ${s.orderCount ?? 0} · 流水 ${s.logCount ?? 0} · 退款 ${s.refundCount ?? 0} · 逐笔匹配 ${s.matchedCount ?? 0}`,
          );
          if (Array.isArray(r.diffTypeStats) && r.diffTypeStats.length) {
            const hit = r.diffTypeStats.filter((d) => (d.count ?? 0) > 0);
            lines.push(
              '差异类型：' +
                (hit.length ? hit.map((d) => `${d.label} ${d.count}`).join('、') : '无'),
            );
          }
          if (r.lastRun) {
            // 最近一次执行的触发方式：manual=人工补跑，否则默认自动（与 admin tip 同源）
            const runNoun = r.lastRun.trigger === 'manual' ? '人工补跑' : '自动';
            lines.push(
              `最近${runNoun}对账：${r.lastRun.freshness ?? '?'}（${r.lastRun.date ?? '无'}）` +
                `${r.lastRun.diffCount ? ` · 差异 ${r.lastRun.diffCount} 笔` : ''}`,
            );
          }
          if (r.note) lines.push('口径说明：' + r.note);
          recon = lines.join('\n');
        }
      } catch {
        /* 跳过该视角 */
      }

      // 2. 退款积压 / 异常（D40）
      let refund = '（暂缺）';
      try {
        const r = await this.resolver.getRefunds('pending');
        if (r && r.summary) {
          const s = r.summary;
          refund = `待审批 ${s.pendingCount ?? 0} 笔 · 金额 ${fen2yuan(s.pendingAmountFen ?? 0)}（已通过 ${s.approvedCount ?? 0} · 已退款 ${s.refundedCount ?? 0} 笔 ${fen2yuan(s.refundedAmountFen ?? 0)} · 已驳回 ${s.rejectedCount ?? 0}）`;
        }
      } catch {
        /* 跳过 */
      }

      // 3. 应付未出单异常（S9）
      let share = '（暂缺）';
      try {
        const r = await this.resolver.getShareExceptions(yDate);
        if (r && r.summary) {
          const s = r.summary;
          const reasons =
            s.byReason && Object.keys(s.byReason).length
              ? Object.entries(s.byReason)
                  .map(([k, v]) => `${k}:${v}`)
                  .join('、')
              : '无';
          share = `未出单 ${s.count ?? 0} 项 · 涉及供应商 ${s.supplierCount ?? 0} · 商品 ${s.itemCount ?? 0} · 原因分布 ${reasons}`;
        }
      } catch {
        /* 跳过 */
      }

      // 4. 提现待审批（D45）
      let withdraw = '（暂缺）';
      try {
        const r = await this.resolver.getWithdrawals('review');
        if (r && r.summary) {
          const s = r.summary;
          withdraw = `待审批 ${s.pendingCount ?? 0} 笔 · 金额 ${fen2yuan(s.pendingAmountFen ?? 0)}（已批准 ${s.approvedCount ?? 0} 笔 ${fen2yuan(s.approvedAmountFen ?? 0)} · 提现占用冻结 ${fen2yuan(s.frozenByWithdrawFen ?? 0)}）`;
        }
      } catch {
        /* 跳过 */
      }

      const lines: string[] = [];
      lines.push(`风控对账体检数据 · 基准日 ${yDate}（数值均为系统实读，已汇总）`);
      lines.push('');
      lines.push('【一、支付对账（本地三头）】');
      lines.push(recon);
      lines.push('');
      lines.push('【二、退款积压 / 异常（D40）】');
      lines.push(refund);
      lines.push('');
      lines.push('【三、应付未出单异常（S9）】');
      lines.push(share);
      lines.push('');
      lines.push('【四、提现待审批（D45）】');
      lines.push(withdraw);
      lines.push('');
      lines.push(
        '说明：以上为系统实读汇总，差异需人工逐笔核对；一期未接入微信账单，本地三头平不代表与微信对平。',
      );

      const plain = lines.join('\n');

      const repoRoot = this.resolveRepoRoot();
      const tmpDir = this.pickWritableDir(repoRoot);
      const plainFile = join(tmpDir, `_rr_${Date.now()}.txt`);
      try {
        writeFileSync(plainFile, plain, 'utf8');
      } catch {
        return `风控对账数据已生成，但写入临时文件失败（磁盘权限）。可在后台看板查看原始数据：\n\n${plain}`;
      }

      const script = join(repoRoot, 'scripts', 'gen-risk-recon.mjs');
      if (!existsSync(script)) {
        return `风控对账（原始数据，AI 脚本未找到）：\n\n${plain}`;
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
            `风控对账生成启动失败：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          );
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
          finish('风控对账生成超时（>90s）。原始数据已在后台看板，可稍后重试触发。');
        }, 90_000);
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += String(d)));
        child.stderr?.on('data', (d) => (err += String(d)));
        child.on('error', (e) =>
          finish(
            `风控对账生成出错：${e instanceof Error ? e.message : String(e)}。可在后台看板查看原始数据。`,
          ),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          try {
            unlinkSync(plainFile);
          } catch {
            /* noop */
          }
          if (out.trim()) finish(out.trim());
          else
            finish(
              `风控对账生成未成功（退出码 ${code}）。${err ? '\n' + err.slice(0, 400) : ''}\n可在后台看板查看原始数据。`,
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
