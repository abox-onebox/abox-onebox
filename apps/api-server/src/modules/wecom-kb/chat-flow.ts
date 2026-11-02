import { parseMealDate } from './name-match';

/**
 * 把同事的一句话认成「他想干什么」（纯函数，零 IO）
 *
 * 设计取舍：**不做自由语义理解，只认业务动作词 + 实体词**。
 *   · 目标用户就几个人、句式高度重复（「给 X 上明天的 Y 套餐」「今天多少单」「退 X 单」）；
 *   · 确定性关键词判断没有延迟、不花钱、不会把「别退款」听成「退款」；
 *   · 真认不出来时走「菜单 + 回数字」，比硬猜安全 —— 后台一动就是真金白银。
 *
 * 否定的处理是硬要求：出现「别/不要/暂不/先别」时，**一律不执行写操作**，
 * 只说“我理解你在取消/否定，需要执行请去掉否定词重新说”。
 */

export type ChatIntent =
  | { kind: 'help' }
  | { kind: 'assign'; date: string | null; dateExplicit: boolean }
  | { kind: 'orders'; date: string | null }
  | { kind: 'myRequests' }
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'negated'; raw: string }
  | { kind: 'genCampaign'; brief: string }
  | { kind: 'genDailyReport' }
  | { kind: 'unknown'; raw: string };

const RE_CONFIRM = /^(1|好|好的|好嘞|确认|确定|执行|对|是|可以|行|干吧|办吧|就这样|ok|yes)$/i;
const RE_CANCEL = /^(2|不|不用|不要|取消|算了|先不|停|别|n|no)$/i;
const RE_NEGATION = /(别|不要|不用|暂不|先别|先不|无需|甭)/;

export function isConfirm(text: string): boolean {
  return RE_CONFIRM.test(text.trim());
}

export function isCancel(text: string): boolean {
  return RE_CANCEL.test(text.trim());
}

export function hasNegation(text: string): boolean {
  return RE_NEGATION.test(text);
}

/** 认意图。`now` 用于解析「明天」这类相对日期，传真实当前时刻。 */
export function parseIntent(raw: string, now: Date): ChatIntent {
  const t = (raw || '').trim();
  if (!t) return { kind: 'unknown', raw: t };

  if (isConfirm(t)) return { kind: 'confirm' };
  if (isCancel(t)) return { kind: 'cancel' };

  // AI 编排节点 B · 文案与素材生成（企微触发）：认出「生成招募页/文案 + 需求」即走该节点。
  // ⚠️ 必须早于后面的 orders/assign 判定 —— 需求里若误带「套餐/订单」等词也不应被截走。
  const genCampaign =
    /^(?:生成招募页|生成文案|招募文案|招募页|写招募文案|生成海报|出招募页|campaign)\s*[:：]?\s*(.*)$/i.exec(
      t,
    );
  if (genCampaign) return { kind: 'genCampaign', brief: genCampaign[1].trim() };

  // AI 编排节点 E · 运营日报（企微触发）：认出「日报/每日简报」即走该节点。
  // ⚠️ 必须带「日报」二字（避免与统计问句「经营情况/经营数据」混淆）；「生成招募页」已在前置分支处理。
  if (
    /(生成|出|报一下|来一份|给我|看|要|今日|经营|运营|每日|daily)?\s*(今日|经营|运营|每日|daily)?\s*(日报|每日简报|运营日报|经营日报)/i.test(
      t,
    )
  )
    return { kind: 'genDailyReport' };

  if (/^(帮助|help|\?|？|菜单|能干什么|会什么|怎么用|使用说明)$/.test(t)) return { kind: 'help' };

  const d = parseMealDate(t, now);

  // 否定：出现否定词就绝不进写操作（「别退款」「先不排套餐」）
  if (hasNegation(t) && /(套餐|上架|下架|退|改|排|分配)/.test(t)) {
    return { kind: 'negated', raw: t };
  }

  if (/(我的申请|我的审批|审批进度|申请进度|批到哪)/.test(t)) return { kind: 'myRequests' };

  if (/(订单|多少单|几单|查单|下单量|销量)/.test(t)) {
    return { kind: 'orders', date: d.date };
  }

  if (/(套餐|排餐|分配|上架|下架|换餐)/.test(t)) {
    return { kind: 'assign', date: d.date, dateExplicit: d.explicit };
  }

  return { kind: 'unknown', raw: t };
}

/**
 * 首次搭话 / 发「帮助」时回的东西：先说人话，再给例子
 *
 * ⚠️ 刻意与 `command-parser.ts` 的 `HELP_TEXT`（结构化指令版）**分开命名**：
 *    那两个是两种使用方式（人话 vs 指令），混用会让「到底哪份才是给同事看的」失焦。
 */
export const CHAT_HELP = [
  '我是后台助手，你在企微里说一句，我照做。',
  '',
  '最常用的三件：',
  '1  给楼排套餐 / 换套餐 —— 说楼名 + 哪天 + 哪个套餐',
  '2  查订单 —— 说哪天',
  '3  看我的审批进度',
  '',
  '要看数据（自动带上期对比与超线提醒）：',
  '· 经营情况 —— GMV、单量、退款率、毛利',
  '· 楼栋排行 · 菜品热度 · 留存 · 页面停留',
  '· 可指定档位：「近 30 天经营情况」「昨天的经营数据」',
  '',
  '要用后台其它功能：',
  '· 发「操作目录」看全部功能（按模块分组，只列你能用的）',
  '· 或直接搜：「找 退款」「找 团长」「找 优惠券」',
  '· 出招募物料：发「生成招募页 <一句话需求>」（AI 起草文案与海报，草稿需人工终审）',
  '· 出运营日报：发「生成今日日报」（AI 汇总近 7 天经营数据，给总览·亮点·风险·行动建议）',
  '选好之后我只问缺的那几个参数，回 1 才真执行。',
  '',
  '直接说事，例如：',
  '「给量子大厦 A 座上明天的 A 套餐」',
  '「今天多少单」',
  '',
  '动钱、动单、动团长这类敏感操作，同事只能提交申请，等负责人批了才生效。',
].join('\n');

/** 认不出意图时：不猜，给能做的事 + 例子 */
export const CHAT_FALLBACK = [
  '这句我没听准。可以这样说：',
  '「给量子大厦 A 座上明天的 A 套餐」',
  '「今天多少单」',
  '「我的审批」',
  '',
  '发「帮助」看全部。',
].join('\n');

export const CHAT_NEGATED =
  '听起来你是在取消或否定这件事，我什么都没做。\n要真执行的话，去掉「别 / 不要」这类词，重新说一遍。';

/**
 * 后台错误码 → 同事能听懂的一句话（纯函数，便于单测）
 *
 * ⚠️ 码义以 `common/constants/error-code.ts` 为准：
 *    30003 是**订单状态机**拒绝（已出餐/已退款），不是「截单」——
 *    把截单话术挂在 30003 上会让人以为「改个日期就能过」，实际是这单不能再动。
 *    截单是 30013（MEAL_PUBLISH_AFTER_CUTOFF）。
 */
export function chatErrorText(code: number, msg?: string): string {
  const map: Record<number, string> = {
    30011: '这天这栋楼已经排过套餐了。要换套餐得改原来那条，我暂时做不了，请让负责人在后台改。',
    30013: '这天已经截单了（出餐日 0 点截单），排上也下不了单。换一天吧。',
    30003: '这条记录现在的状态不允许这么改，可能已经出餐或退款了。',
    20012: '那栋楼已经有团长了，转交要先指定现任团长。',
    10002: '我这边身份过期了，你再说一遍，我重新登录一次。',
    404: '这个东西找不到了，可能刚被删掉。',
  };
  return map[code] || msg || '后台没成功，也没说原因。';
}

/**
 * 把 `GET /admin/orders` 的出参说成人话
 *
 * ⚠️ 汇总在 **`summary`** 下（`totalCount` / `validCount` / `validQuantity`），
 *    顶层只有分页字段 —— 读顶层永远拿不到数，表现是「有返回但说不出话」。
 *    `valid*` 已剔除取消/退款等无效单，是老板要看的那个数。
 */
export function summarizeOrderData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const s = (d.summary && typeof d.summary === 'object' ? d.summary : {}) as Record<
    string,
    unknown
  >;
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  const valid = num(s.validCount);
  const total = num(s.totalCount);
  const qty = num(s.validQuantity);
  const abnormal = num(s.abnormalCount);
  if (valid == null && total == null && qty == null) return null;

  const parts: string[] = [];
  if (valid != null) parts.push(`${valid} 单`);
  else if (total != null) parts.push(`${total} 单`);
  if (qty != null) parts.push(`${qty} 份`);
  let text = parts.join('，');
  if (total != null && valid != null && total > valid) {
    text += `（另有 ${total - valid} 单已取消/退款）`;
  }
  if (abnormal != null && abnormal > 0) text += `，其中异常 ${abnormal} 单要人看`;
  return text;
}

/**
 * 是不是「结构化指令」（`执行 publish_assignment id=123` 那种）。
 *
 * 两种入口都保留：人话给同事，结构化指令给负责人和排障用。
 * 但**「帮助」不算指令** —— 它走人话版菜单，因为第一次用的人看到的应该是「说一句就能干活」，
 * 而不是一串 `opCode` 参数表。
 */
export function looksLikeStructuredCommand(text: string): boolean {
  const v = (text || '').trim().split(/\s+/)[0];
  return [
    '执行',
    '提交',
    '查询',
    '撤回',
    '审批通过',
    '审批拒绝',
    'exec',
    'submit',
    'query',
    'recall',
    'approve',
    'reject',
  ].includes(v);
}
