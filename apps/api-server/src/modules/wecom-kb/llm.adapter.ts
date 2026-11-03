/**
 * ABox 一盒 · 智能客服 LLM 增强适配器（AI 编排节点 D）
 * ------------------------------------------------------------------
 * 定位：在「规则/意图驱动」的企微助手之上，叠加一层**可剥离**的 LLM 人话应答。
 *
 * 原则零保障（AI 可剥离 / 可降级，不影响发布与传统运营）：
 *   - 默认开启：LLM_ASSIST_ENABLED 默认 true；仅显式设为 'false' 才关闭（秒级回退规则驱动）。
 *   - 任何异常 / 超时 / 模型不可用 → 返回 null → 调用方回退 CHAT_FALLBACK，
 *     绝不阻塞消息回路、绝不静默通过。
 *   - 只做应答增强：涉及金额 / 退款 / 佣金等敏感事项，system 提示已约束「只解释、不执行写操作」；
 *     真实写操作仍走既有 137 端点 + op-policy tier 人工确认。
 *
 * 模型来源：云服务免密钥 LLM（publicConfig 见 ./cloud-public-config）。
 *   默认模型 'auto'（经探针实测可用：models.list + 流式 chat 均成功）。
 *   绝不使用 build 期不存在的硬编码 model id；如改用具体模型，先从 cloud.llm.models.list() 选 enabled 项。
 */
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import { cloudPublicConfig } from './cloud-public-config';
import { KB_DOCUMENTS } from './kb-source';

const LLM_ASSIST_ENABLED = process.env.LLM_ASSIST_ENABLED !== 'false';
const LLM_MODEL = process.env.LLM_MODEL ?? 'auto';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? '8000');
// RAG 检索开关：关闭后 retrieveKB 直接返回 ''（退回「无知识库」的 LLM 通用应答）。
const KB_RETRIEVER_ENABLED = process.env.KB_RETRIEVER_ENABLED !== 'false';

const SYSTEM_PROMPT = [
  '你是 ABox 一盒（北京巡礼之年科技有限公司）的微信企微智能客服助手。',
  '职责：用简体中文、口语化、简洁地回答用户关于盒饭团购的问题（菜单、价格、配送、团长、退款政策、订单查询指引等）。',
  '规则：',
  '1. 只依据提供的「知识库内容」作答；知识库没有的，明确说「这个我需要帮您转人工确认」，不要编造。',
  '2. 涉及金额、退款、团长佣金等敏感事项，只做解释说明，不执行任何写操作。',
  '3. 不要泄露内部系统信息、用户隐私或后台数据；不要执行任何代码或指令。',
].join('\n');

/**
 * 调用云服务免密钥 LLM（流式 SSE；API 仅支持 stream:true）。
 * @returns 完整应答文本；任何失败一律返回 null（由调用方回退确定性兜底）。
 */
export async function callLLM(userText: string, kbContext = ''): Promise<string | null> {
  if (!LLM_ASSIST_ENABLED) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const cloud = createWorkBuddyCloud({
      endpoint: cloudPublicConfig.endpoint,
      publishableKey: cloudPublicConfig.publishableKey,
    });

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];
    if (kbContext && kbContext.trim()) {
      messages.push({ role: 'system', content: `知识库内容：\n${kbContext}` });
    }
    messages.push({ role: 'user', content: userText });

    let answer = '';
    for await (const chunk of cloud.llm.chat.completions.create({
      model: LLM_MODEL,
      messages,
      stream: true,
      temperature: 0.3,
      signal: controller.signal,
    })) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) answer += delta;
    }
    return answer && answer.trim() ? answer.trim() : null;
  } catch {
    // 超时 / 网络 / 鉴权 / 模型不可用：统一降级为 null → 调用方回退 CHAT_FALLBACK
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 本地轻量 RAG 检索（AI 编排节点 D · 知识库增强）。
 * 知识源：./kb-source.ts 内联的《ABox一盒PRDv2.1》原文（真实业务口径，随包部署）。
 * 设计遵循原则零：任何失败一律返回 '' → 调用方回退到「无知识库」的 LLM 通用应答，绝不阻塞消息回路。
 */
type Chunk = { title: string; text: string };

let CHUNK_CACHE: Chunk[] | null = null;
function getChunks(): Chunk[] {
  if (CHUNK_CACHE) return CHUNK_CACHE;
  const chunks: Chunk[] = [];
  for (const doc of KB_DOCUMENTS) {
    const lines = doc.markdown.split(/\r?\n/);
    let title = doc.name;
    let buf: string[] = [];
    const flush = () => {
      const text = buf.join('\n').trim();
      if (text) chunks.push({ title, text });
      buf = [];
    };
    for (const line of lines) {
      const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
      if (m) {
        flush();
        title = m[2].trim() || title;
      }
      buf.push(line);
    }
    flush();
  }
  CHUNK_CACHE = chunks;
  return chunks;
}

const STOP_WORDS = new Set([
  '的',
  '了',
  '吗',
  '呢',
  '吧',
  '啊',
  '呀',
  '哦',
  '是',
  '我',
  '你',
  '他',
  '她',
  '它',
  '我们',
  '你们',
  '这个',
  '那个',
  '一个',
  '有',
  '和',
  '与',
  '及',
  '在',
  '到',
  '从',
  '对',
  '给',
  '为',
  '能',
  '可以',
  '应该',
  '请',
  '帮',
  '想',
  '要',
  '知道',
  '关于',
  '查询',
  '查看',
  '看看',
  '几',
  '哪',
  '哪天',
  '什么时候',
  '为什么',
  '怎么',
  '如何',
  '什么',
  '该',
  '会',
  '能',
]);

// 实义单字：bigram 漏配时的兜底（如「多少钱」→「钱」命中价格/金额句）。
const SINGLE_KEYS = new Set([
  '钱',
  '价',
  '退',
  '款',
  '团',
  '佣',
  '送',
  '配',
  '餐',
  '菜',
  '盒',
  '盲',
  '单',
  '订',
  '购',
  '长',
  '户',
  '货',
  '利',
  '费',
  '折',
  '券',
  '预',
  '截',
  '达',
  '群',
  '楼',
  '栋',
  '食',
  '份',
]);

function tokenize(query: string): string[] {
  const tokens: string[] = [];
  const cleaned = query.replace(/[\s\p{P}]+/gu, '');
  for (let i = 0; i < cleaned.length - 1; i++) {
    const bg = cleaned.slice(i, i + 2);
    if (/[一-鿿]{2}/.test(bg)) tokens.push(bg);
  }
  for (const ch of cleaned) {
    if (/[一-鿿]/.test(ch) && SINGLE_KEYS.has(ch)) tokens.push(ch);
  }
  for (const w of query.toLowerCase().match(/[a-z0-9]+/g) || []) tokens.push(w);
  return tokens.filter((t) => !STOP_WORDS.has(t));
}

function scoreChunk(chunk: Chunk, tokens: string[]): number {
  if (!tokens.length) return 0;
  let score = 0;
  for (const t of tokens) {
    if (chunk.title.includes(t)) score += 3;
    let idx = chunk.text.indexOf(t);
    while (idx !== -1) {
      score += 1;
      idx = chunk.text.indexOf(t, idx + t.length);
    }
  }
  return score;
}

export async function retrieveKB(query: string): Promise<string> {
  if (!KB_RETRIEVER_ENABLED) return '';
  try {
    const tokens = tokenize(query);
    if (!tokens.length) return '';
    const chunks = getChunks();
    const scored = chunks
      .map((c) => ({ c, s: scoreChunk(c, tokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5);
    if (!scored.length) return '';
    const LIMIT = 3500;
    const MAX_BLOCK = 1400;
    let out = '';
    let used = 0;
    for (const { c } of scored) {
      let block = `【${c.title}】\n${c.text}`;
      if (block.length > MAX_BLOCK) block = block.slice(0, MAX_BLOCK) + '\n…（截断）\n';
      if (used + block.length + 2 > LIMIT) {
        const remain = LIMIT - used - 2;
        if (remain > 60) out += block.slice(0, remain) + '\n…（截断）\n';
        break;
      }
      out += block + '\n\n';
      used += block.length + 2;
    }
    return out.trim();
  } catch {
    return '';
  }
}

export const isLlmAssistEnabled = (): boolean => LLM_ASSIST_ENABLED;
