/**
 * composables/use-subscribe-message —— 微信订阅消息授权（M4-3 · 4.10 贯通）
 *
 * ## 为什么需要一个「预加载 + 同步请求」的两段式
 *
 * 微信订阅消息是**一次性授权**：用户没点过「允许」，服务端推了也白推
 * （微信回 `43101 用户拒绝接收`）。所以必须在**用户还有交互的那一刻**要授权。
 *
 * ⚠️ 而 `requestSubscribeMessage` **只能在用户点击的同步流程里调用**：
 *    先 `await` 一个网络请求、拿到模板 ID 再调，微信会直接以
 *    `fail can only be invoked by user TAP gesture` 拒绝 —— 手势窗口在 `await`
 *    之后就关了。这是本文件存在的**唯一理由**，也是最容易被写错的地方：
 *
 * ```
 * ❌ async function submit() { const ids = await load(); await request(ids); … }   // 手势已失效
 * ✅ onLoad → preload() 缓存；submit() 内 requestFor([...]) —— 同步调用、不 await
 * ```
 *
 * ## 三个纪律
 *
 * 1. **模板 ID 来自服务端**（`GET /me/subscribe/templates`），**端上不硬编码** ——
 *    硬编码 = 第二份真相，运营换模板后端上还在请求旧 ID，两边都不报错。
 * 2. **列表为空就什么都不做**（一期常态：没有微信模板 ID）。**绝不拿假 ID 去试**。
 * 3. **授权失败绝不阻塞主流程**：申请团长 / 申请退款该成功还是成功 ——
 *    授权只是「将来能不能收到通知」，不能因为它失败而让业务动作失败。
 */
import { ref } from 'vue';

import { fetchSubscribeTemplates, type SubscribeTemplateItem } from '@/api/user';

/** `uni.requestSubscribeMessage` 的最小形状（避免依赖 types 包的具体版本） */
interface RequestSubscribeOptions {
  tmplIds: string[];
  success?: (res: Record<string, unknown> & { errMsg?: string }) => void;
  fail?: (err: { errMsg?: string }) => void;
}

type RequestSubscribeFn = (options: RequestSubscribeOptions) => void;

/** 授权结果（`accept` / `reject` / `ban` / `filter`）—— 仅用于日志 */
type SubscribeResults = Record<string, string>;

/**
 * 模块级缓存：**一次小程序会话只拉一次**
 *
 * 模板 ID 由运营在后台改，改完重新进入小程序即可生效；在页面间反复拉取只会
 * 让「点击那一刻」更可能落空（缓存未就绪 → 跳过授权）。
 */
let cache: SubscribeTemplateItem[] | null = null;
let loading: Promise<void> | null = null;

/** 取平台实现（非微信小程序平台 / 单元测试环境下为 `undefined`） */
function subscribeApi(): RequestSubscribeFn | undefined {
  const fn = (uni as unknown as { requestSubscribeMessage?: RequestSubscribeFn })
    .requestSubscribeMessage;
  return typeof fn === 'function' ? fn.bind(uni) : undefined;
}

export function useSubscribeMessage() {
  const ready = ref(cache !== null);

  /**
   * 预加载模板清单（**页面 `onLoad` 调用**，不要在点击回调里调）
   *
   * 失败静默：拿不到清单 = 这次不请求授权，业务动作照常。
   */
  async function preload(): Promise<void> {
    if (cache !== null) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const res = await fetchSubscribeTemplates();
        cache = res.list ?? [];
      } catch {
        // 静默：订阅授权是**增强能力**，拉不到清单不应在首页弹错误
        cache = [];
      } finally {
        ready.value = true;
        loading = null;
      }
    })();
    return loading;
  }

  /**
   * 请求指定场景的订阅授权（**同步调用，不要 `await`**）
   *
   * @param scenes 想请求的场景键（如 `['leader_apply']`）；只请求**服务端已确认可请求**的那些
   * @param onResults 授权结果回调（仅日志/埋点用 —— U15 上报一期未实装）
   * @returns 本次实际请求的模板 ID 列表（空 = 没有可请求的，什么都没发生）
   */
  function requestFor(scenes: string[], onResults?: (results: SubscribeResults) => void): string[] {
    const api = subscribeApi();
    if (!api) return []; // 非微信小程序平台（H5 / 支付宝等）—— 不存在此能力

    const wanted = new Set(scenes);
    const tmplIds = (cache ?? []).filter((t) => wanted.has(t.scene)).map((t) => t.templateId);
    // 一期常态：清单为空 → 直接返回。**不要**在这里伪造 ID 去调微信。
    if (!tmplIds.length) return [];

    api({
      tmplIds,
      success: (res) => onResults?.(pickResults(res, tmplIds)),
      fail: () => {
        // 用户拒绝 / 手势失效都可能走到这里 —— 两者都不该影响业务动作
        onResults?.(Object.fromEntries(tmplIds.map((id) => [id, 'failed'])));
      },
    });
    return tmplIds;
  }

  return { preload, requestFor, ready };
}

/** 从微信回包里挑出模板维度的结果（其余 `errMsg` 之类不进结果） */
function pickResults(res: Record<string, unknown>, tmplIds: string[]): SubscribeResults {
  const out: SubscribeResults = {};
  for (const id of tmplIds) {
    const v = res[id];
    if (typeof v === 'string') out[id] = v;
  }
  return out;
}
