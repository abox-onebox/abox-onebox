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

const LLM_ASSIST_ENABLED = process.env.LLM_ASSIST_ENABLED !== 'false';
const LLM_MODEL = process.env.LLM_MODEL ?? 'auto';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? '8000');

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

/** 知识库检索占位：待 abox-kb 暴露查询接口后接入 RAG。 */
export async function retrieveKB(_query: string): Promise<string> {
  return '';
}

export const isLlmAssistEnabled = (): boolean => LLM_ASSIST_ENABLED;
