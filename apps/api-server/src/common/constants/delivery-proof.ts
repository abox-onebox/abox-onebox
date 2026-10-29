/**
 * 配送送达凭证（`ab_delivery_proof`）的口径常量与判据（Q3 · 2026-10-29）
 *
 * ## 为什么判据要抽成这里的纯函数
 * 凭证写入口在 `DeliveryService`（**全仓没有单测**）—— 判据写在方法里，
 * 「什么样的 url 能进库」就没有任何机械检查会拦得住它，改坏了也不报错。
 * 抽成纯函数 + 单测，是本项目 P3 / H9 / T1T2 三轮沿用的同一条纪律。
 *
 * ## ⚠️ `kind` 是分类标签，不是状态
 * 不做状态机、不校验转换 —— 一份凭证不会从「现场照」流转成「签收单」。
 * 故这里只有「值在不在允许集合里」这一个判据，没有 `canTransit` 之类的东西。
 */

/** 凭证类型（与 `ab_delivery_proof.kind` 的列值域**逐字一致**） */
export const DELIVERY_PROOF_KINDS = ['photo', 'sign', 'other'] as const;

export type DeliveryProofKind = (typeof DELIVERY_PROOF_KINDS)[number];

/** 类型中文（服务端下发 · 端上不维护第二份映射，与 `DELIVERY_STATUS_LABEL` 同纪律） */
export const DELIVERY_PROOF_LABEL: Record<string, string> = {
  photo: '现场照',
  sign: '签收单',
  other: '其它',
};

/** 缺省类型（DTO 未传 `kind` 时用） */
export const DEFAULT_DELIVERY_PROOF_KIND: DeliveryProofKind = 'photo';

/** url 长度上限（与 `ab_delivery_proof.url VARCHAR(512)` **同值** —— 改列先改这里） */
export const DELIVERY_PROOF_URL_MAX = 512;

/** 凭证列表的筛选范围 */
export const DELIVERY_PROOF_SCOPES = ['alive', 'deleted', 'all'] as const;

export type DeliveryProofScope = (typeof DELIVERY_PROOF_SCOPES)[number];

export const DEFAULT_DELIVERY_PROOF_SCOPE: DeliveryProofScope = 'alive';

/**
 * 归一化 `scope`
 *
 * ⚠️ 刻意用**字符串三态**而不是 `withDeleted` 布尔开关：query 里的布尔串经
 *    `@Type(() => Boolean)` 会把 `'false'` 转成 **`true`**（非空字符串一律为真），
 *    是「传了 false 却筛出全部」的经典陷阱（`finance.dto.ts` 对账查询已因此不收布尔）。
 *    三态还多表达了「只看已撤销」这一档 —— 而那正是举证时要查的。
 */
export function normalizeProofScope(raw: unknown): DeliveryProofScope {
  return typeof raw === 'string' && (DELIVERY_PROOF_SCOPES as readonly string[]).includes(raw)
    ? (raw as DeliveryProofScope)
    : DEFAULT_DELIVERY_PROOF_SCOPE;
}

export function isProofKind(v: unknown): v is DeliveryProofKind {
  return typeof v === 'string' && (DELIVERY_PROOF_KINDS as readonly string[]).includes(v);
}

export type ProofUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * 校验并归一化凭证 url
 *
 * ## 三条判据（逐条都有对应事故形状，别合并）
 * ① **非空**（trim 后）—— 空串写进库里，端上渲染成一个「图裂了但列表显示有凭证」的
 *    假状态：运营以为传过了、举证时打开是空白。这比「没有凭证」更糟。
 * ② **长度 ≤ 512** —— 与列定义同宽。超限会被 MySQL 截成 512（`STRICT` 未开时
 *    **只 warning 不报错**），存进去的是个**打不开的半截地址**，而写库是「成功」的。
 * ③ **形态**：只放行站内 `/static/...` 或 `http(s)` 绝对地址。
 *    · 挡 `javascript:` / `data:` —— 前者是 XSS 载体，后者会把整张图塞进字段
 *      （绕过存储、撑爆行），而两者在 URL 栏里**都长得像链接**，人眼分不出。
 *    · 挡空白与控制字符（含换行）—— 换行是「日志注入 / 请求拆分」的经典载体，
 *      且 trim 只去首尾，中间的换行必须显式判。
 *
 * ⚠️ **刻意不校验「这个 url 真的能下载」**：写入时做网络请求会让写库依赖外网可用性
 *    （网络抖一下 = 凭证传不上），且地址可能来自尚未生效的 CDN。能不能打开是**看的时候**
 *    才知道的事，不是写的时候该拦的。
 */
export function checkProofUrl(raw: unknown): ProofUrlCheck {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'url 必须是字符串' };
  }
  const url = raw.trim();
  if (!url) {
    return { ok: false, reason: 'url 不能为空' };
  }
  if (url.length > DELIVERY_PROOF_URL_MAX) {
    return { ok: false, reason: `url 长度不能超过 ${DELIVERY_PROOF_URL_MAX} 个字符` };
  }
  // 控制字符（含 \n \r \t）：trim 只去首尾，中间的必须显式判
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) {
    return { ok: false, reason: 'url 不能包含换行或控制字符' };
  }
  const isStatic = url.startsWith('/static/');
  const isHttp = /^https?:\/\/[^\s]+$/i.test(url);
  if (!isStatic && !isHttp) {
    return {
      ok: false,
      reason: 'url 必须是站内 /static/ 路径，或 http(s) 开头的绝对地址',
    };
  }
  return { ok: true, url };
}

/** 归一化 `kind`：未传 / 非法 → 缺省值（**不报错**，类型只是标签，不值得拦住上传） */
export function normalizeProofKind(raw: unknown): DeliveryProofKind {
  return isProofKind(raw) ? raw : DEFAULT_DELIVERY_PROOF_KIND;
}

/** 类型中文（未知值原样返回 —— 老数据可能出现新值，显示成空白比显示成「未知」更好排查） */
export function proofKindText(kind: string): string {
  return DELIVERY_PROOF_LABEL[kind] ?? kind;
}
