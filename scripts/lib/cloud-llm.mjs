#!/usr/bin/env node
/**
 * ABox 一盒 · 云服务 LLM 调用层（脚本版 · 供节点 A/B 复用）
 * ------------------------------------------------------------------
 * 复用「ABox内部助手」已激活的云服务 publicConfig（keyless，公钥可随源码分发）。
 *
 * ⚠️ 必须用官方 SDK（@tencent-ai/workbuddy-cloud-sdk），不能手写 HTTP：
 *    服务端走 PKCE 会话握手——请求需同时带 `x-wb-webapp-access-key: <publishableKey>`
 *    与 `Authorization: Bearer <sessionToken>`（sessionToken 由 SDK 经 /.cloud/auth 换取）。
 *    裸 fetch 只发 Bearer<publishableKey> 会被 401 invalid_client。握手由 SDK 托管。
 *
 * 原则零保障（AI 可剥离、可降级，不影响发布与传统运营）：
 *   - 本模块只负责「把文本送进 LLM、把流式响应拼回文本」；任何失败都向上抛 Error，
 *     由调用方决定降级（转发门禁 / 占位模板），绝不静默吞错、绝不阻塞主流程。
 *   - 调用方须自行用 try/catch 包住 callLLM，并在异常时回到非 AI 路径。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'cloud-public-config.json');

let _cfg = null;
function loadConfig() {
  if (_cfg) return _cfg;
  try {
    _cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    _cfg = { endpoint: '', publishableKey: '' };
  }
  return _cfg;
}

export const DEFAULT_MODEL = 'auto';

let _client = null;
function getClient() {
  if (_client) return _client;
  const { endpoint, publishableKey } = loadConfig();
  if (!endpoint || !publishableKey) {
    throw new Error('CLOUD_CONFIG_MISSING: scripts/cloud-public-config.json 缺失或为空');
  }
  _client = createWorkBuddyCloud({ endpoint, publishableKey });
  return _client;
}

/**
 * 调用云服务 LLM，返回拼接后的完整文本。
 * @param {object} opts
 * @param {string} opts.system 系统提示
 * @param {string} opts.user   用户内容（如 diff、brief）
 * @param {string} [opts.model] 模型，默认 auto
 * @param {number} [opts.timeoutMs] 超时（毫秒），默认 8000
 * @param {number} [opts.temperature] 温度，默认 0.3
 * @returns {Promise<string>}
 */
export async function callLLM({
  system,
  user,
  model = DEFAULT_MODEL,
  timeoutMs = 8000,
  temperature = 0.3,
}) {
  const client = getClient();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let answer = '';
    const stream = await client.llm.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: true,
      temperature,
    });
    // 服务端流式：可能是异步可迭代（AsyncIterable）或 ReadableStream
    if (typeof (stream[Symbol.asyncIterator] ?? stream[Symbol.iterator]) === 'function') {
      for await (const chunk of stream) {
        const d = chunk?.choices?.[0]?.delta?.content;
        if (d) answer += d;
        if (ac.signal.aborted) break;
      }
    } else {
      // 兜底：非流式对象（理论上不会发生，SDK 强制 stream:true）
      const d = stream?.choices?.[0]?.message?.content;
      if (d) answer += d;
    }
    if (!answer.trim()) throw new Error('LLM_EMPTY: 模型返回为空');
    return answer;
  } catch (e) {
    if (ac.signal.aborted && !(e?.name === 'AbortError')) {
      throw new Error(`LLM_TIMEOUT(${timeoutMs}ms): ${e?.message || e}`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 LLM 文本中稳健抽取第一个 JSON 对象（容忍 ```json 围栏与前后废话）。
 * 失败抛错，由调用方降级。
 */
export function extractJson(text) {
  if (!text) throw new Error('EMPTY_TEXT');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('NO_JSON_OBJECT');
  return JSON.parse(candidate.slice(start, end + 1));
}
