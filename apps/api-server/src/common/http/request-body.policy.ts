/**
 * 请求体（HTTP body）策略 —— **判据真源**
 *
 * ## 为什么要有这个文件
 *
 * 2026-10-27 生产事故：`GET /api/v1/orders/:orderNo` 与 `pay-result` 返回
 * `{"code":10001,"message":"Unexpected token '\"', \"\"eyJhbGciO\"... is not valid JSON"}`，
 * 而 `GET /api/v1/orders`（列表）正常。服务端日志 0 条、健康检查全绿。
 *
 * 根因链路（已实跑复现，见 `test/unit/request-body.spec.ts` 的「必报/必不报」用例）：
 *   ① 调用方对 GET 发了 `Content-Type: application/json` + 请求体，且体是**顶层 JSON 字符串**
 *      （`JSON.stringify(<jwt>)` → `"eyJhbGciO…"`）；
 *   ② `body-parser` 的 `strict:true` 要求顶层必须是 `{` 或 `[`，命中
 *      `createStrictSyntaxError()` —— 它用**掩码串重新 JSON.parse 一遍**再把原文替换回去，
 *      于是产出的文案是英文、带、且**不含 `status/type`**（`normalizeJsonSyntaxError`
 *      会把除 message/stack 之外的自有属性全部删掉）；
 *   ③ `@nestjs/core` 的 `RoutesResolver#mapExternalException` 把
 *      **任何** `SyntaxError`/`URIError` 一律映射为 `BadRequestException(err.message)`；
 *   ④ `AllExceptionsFilter` 把 400 → `code:10001`（PARAM_INVALID），并把这条英文原文原样下发。
 *      ⇒ 传输层的错被**伪装成参数校验失败**，不落日志、健康检查看不见、还能"自愈"。
 *
 * ## 这个文件收口的两件事
 *
 *   1. **哪些方法有请求体语义** —— GET / HEAD / OPTIONS 按 RFC 9110 §9.3 不定义请求体内容
 *      语义：它们携带的体永远**不该**影响处理结果。多出来的体一律丢弃（并 **drain**，
 *      避免残留字节在 keep-alive 连接上被下一个请求误读），而不是 400。
 *   2. **体不合法时怎么报** —— 对外只发**同一句中文**（不再泄漏引擎原文）；判据在此一处，
 *      服务端日志保留引擎原文用于定位。
 *
 * ⛔ 这里**不放宽任何业务判据**：有请求体语义的方法（POST/PUT/PATCH/DELETE）体不合法
 *    依然报错、依然是 10001 —— 变的只是「报出来的话」和「痕迹可见」。
 */

/** 有请求体内容语义的方法（RFC 9110 §9.3）；其余方法一律视为无体 */
const METHODS_WITH_BODY_SEMANTICS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/**
 * 对外文案（有请求体语义 + 体不合法）
 *
 * ⚠️ 这句话必须同时覆盖两类失败：`body-parser` 开了 `strict:true`，它既会因为
 *    「这段不是 JSON」失败，也会因为「是 JSON 但顶层不是对象/数组」失败
 *    （顶层字符串 `"abc"`、数字 `1`、`true` 一律判失败）。
 *    若文案只写「不是合法 JSON」，调用方拿到 `"abc"` 这种**合法 JSON** 会被误导去
 *    校对 JSON 语法，永远查不出「顶层必须是对象」这条真实原因。
 */
export const MALFORMED_BODY_MESSAGE =
  '请求体必须是 JSON 对象（{} 或 []），请检查 Content-Type 与请求内容';

/** 请求体失败裁决：调用方按 `kind` 决定动作，不在别处重写这些判断 */
export type BodyFailureVerdict =
  /** 该方法不定义请求体语义 → 丢弃这个体，继续正常处理（并记录日志） */
  | { kind: 'ignore' }
  /** 该方法定义请求体语义且体不可用 → 用受控文案拒绝（并记录引擎原文） */
  | { kind: 'reject'; message: string; rawMessage: string };

/**
 * 判定某个方法是否有请求体语义
 *
 * @param method 大写化的 HTTP 方法；`undefined` 视为无体（保守：宁可不解析，不可误解析）
 */
export function hasRequestBodySemantics(method: string | undefined): boolean {
  if (!method) return false;
  return METHODS_WITH_BODY_SEMANTICS.has(method.toUpperCase());
}

/**
 * 这个请求**实际**携带了请求体吗（只看传输层事实，不看语义）
 *
 * ⚠️ 为什么需要它：「GET 带了体」必须**留痕** —— 2026-10-27 事故里服务端日志 0 条，
 *    排查全靠猜。但若不加区分地对**每个** GET 打日志，正常流量（无体）会把日志刷爆，
 *    而刷爆之后真正的告警就没人看了 ——「每次都告警」等价于「没有告警」。
 *    ⇒ 只在**确实有体**时才告警，判据放这里（纯函数，可单测）。
 *
 * @param contentLength `Content-Length` 原始值（可能缺失）
 * @param transferEncoding `Transfer-Encoding` 原始值（`chunked` 时没有 Content-Length）
 */
export function carriesBody(
  contentLength: string | undefined,
  transferEncoding?: string | undefined,
): boolean {
  if (transferEncoding && transferEncoding.trim().length > 0) return true;
  if (contentLength == null) return false;
  const n = Number(contentLength.trim());
  return Number.isFinite(n) && n > 0;
}

/**
 * 请求体解析失败怎么处置
 *
 * ⚠️ 入参 `err` **必须**是本文件唯一调用方（`request-body.middleware`）从
 *    `body-parser` 回调里拿到的那个错误 —— 因此这里不需要靠 `status/type` 去"猜"
 *    它是不是 body 层的错（`normalizeJsonSyntaxError` 已把这些标记删干净了，猜也猜不到）。
 *    「它是不是 body 层的错」由**调用位置**保证，不由错误形状保证。
 */
export function judgeBodyFailure(method: string | undefined, err: unknown): BodyFailureVerdict {
  const rawMessage = err instanceof Error ? err.message : String(err);
  if (!hasRequestBodySemantics(method)) {
    return { kind: 'ignore' };
  }
  return { kind: 'reject', message: MALFORMED_BODY_MESSAGE, rawMessage };
}
