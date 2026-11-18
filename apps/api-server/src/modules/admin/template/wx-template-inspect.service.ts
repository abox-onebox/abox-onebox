import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import { ErrorCode } from '../../../common/constants/error-code';
import { BizException } from '../../../common/exceptions/biz.exception';
import { WxAccessTokenService } from '../../../providers/wx-access-token.service';
import { MESSAGE_TEMPLATE_SPEC_MAP, WX_BIZ_FIELD_LABEL } from './message-template.specs';

/** access_token 失效类错误码 —— 与发送侧同一组，清缓存重试一次即可恢复 */
const TOKEN_INVALID_CODES = new Set([40001, 40014, 42001]);

/** 微信侧返回的模板（只声明用得到的字段） */
interface WxTemplateRaw {
  priTmplId: string;
  title: string;
  content: string;
  /** 2 = 一次性订阅，3 = 长期订阅 */
  type?: number;
}

export interface WxTemplateKeyword {
  /** 微信关键词编号，如 `time1` */
  code: string;
  /** 模板上展示的中文标签，如「截单时间」 */
  label: string;
}

export interface TemplateVerifyResult {
  /** 是否可直接用于该场景（集合完全相等才算） */
  ok: boolean;
  templateId: string;
  /** 模板标题（微信侧） */
  title: string | null;
  /** 模板类型：2 一次性订阅 / 3 长期订阅 */
  type: number | null;
  /** 模板上**实际**有哪些关键词（顺序同模板） */
  actual: WxTemplateKeyword[];
  /** 本场景**需要**哪些关键词（来自 `wxFields` 声明） */
  expected: WxTemplateKeyword[];
  /** 场景要、模板没有的编号 */
  missing: string[];
  /** 模板有、场景没数据的编号 */
  extra: string[];
  /** 给运营看的一句话结论（可直接展示） */
  message: string;
}

// =====================================================================
// 纯函数（导出供单测直接钉住规则，不经 HTTP、不经库）
// =====================================================================

/**
 * 从模板 `content` 解析出关键词
 *
 * 微信给的形如：
 * ```
 * 截单时间:{{time1.DATA}}
 * 温馨提示:{{thing2.DATA}}
 * ```
 * 每行「标签 + 冒号 + 占位符」。标签缺失时退回用编号本身当标签（**不编造中文**）。
 *
 * ⚠️ 编号**不一定带数字**（见过 `{{enum.DATA}}` / `{{phrase.DATA}}`），
 *    所以正则用 `\w+` 而不是 `\w+\d`，否则这类模板会被解析成 0 个关键词，
 *    进而虚报「模板缺全部字段」。
 */
export function parseTemplateKeywords(content: string): WxTemplateKeyword[] {
  const out: WxTemplateKeyword[] = [];
  const seen = new Set<string>();
  const re = /\{\{\s*(\w+)\.DATA\s*\}\}/g;

  for (const line of String(content ?? '').split('\n')) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const code = m[1];
      if (seen.has(code)) continue; // 同一编号出现两次只算一个
      seen.add(code);
      const label = line
        .slice(0, m.index)
        .replace(/[:：]\s*$/, '')
        .trim();
      out.push({ code, label: label || code });
    }
  }
  return out;
}

/**
 * 场景声明需要的关键词
 *
 * ⚠️ 用 `wxFields` 的**值**（微信编号），不是键（业务字段名）——
 *    键是 `cutoffAt` 这种业务名，真正要匹配的是 `time1`。
 *    写成 `Object.keys()` 会让每次校验都报「模板缺 cutoffAt」，是一条恒红的假结论。
 */
export function expectedKeywordsOf(wxFields: Record<string, string>): WxTemplateKeyword[] {
  return Object.entries(wxFields).map(([bizField, code]) => ({
    code,
    label: WX_BIZ_FIELD_LABEL[bizField] ?? bizField,
  }));
}

/**
 * 比出「缺什么 / 多什么」
 *
 * 微信要求模板里的**每个**关键词都必须给值：缺一个 → 47003；多一个（我们没有对应数据）→ 同样 47003。
 * 所以判定是**集合完全相等**，不是「包含即可」。
 */
export function diffKeywords(
  actual: WxTemplateKeyword[],
  expected: WxTemplateKeyword[],
): { ok: boolean; missing: string[]; extra: string[] } {
  const actualCodes = actual.map((k) => k.code);
  const expectedCodes = expected.map((k) => k.code);
  const missing = expectedCodes.filter((c) => !actualCodes.includes(c));
  const extra = actualCodes.filter((c) => !expectedCodes.includes(c));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/**
 * 模板关键词校验：把「代码里写死的期望」与「微信侧真实模板」对一次账
 *
 * ## 为什么需要它
 *
 * 订阅消息的 `data` 必须**按微信模板的真实关键词编号**给值（`time1` / `thing2` …），
 * 而编号取决于运营在公众平台**怎么勾、怎么排** —— 同一个公共模板，勾的顺序不同，
 * 生成的编号就不同。代码侧只能"声明一个期望"（`wxFields`），**无从知道**实际落成了什么。
 *
 * 没有这层校验时，唯一的发现方式是：配好模板 → 触发一次发送 → 看 47003 → 回来问开发。
 * 7 个场景就要往返 7 次。
 *
 * 有它之后：填完模板 ID 点一下「校验」，当场知道对得上/差哪个。
 *
 * ## 只在错误的方向上给出**确定**结论
 *
 * · 集合不等 ⇒ **一定发不出去**（缺字段或多余字段都会 47003），可以直接判定不合格；
 * · 集合相等 ⇒ **仅说明编号齐了**，不代表语义对 —— 模板里 `time1` 可能叫「下单时间」，
 *   而我们填的是截单时刻。所以结果里一定带上 `actual` 的中文标签，由人再看一眼。
 *   这一点不写清楚，就会把"编号对上了"误读成"这条通知一定正确"。
 */
@Injectable()
export class WxTemplateInspectService {
  private readonly logger = new Logger('WxTemplateInspect');

  constructor(private readonly tokens: WxAccessTokenService) {}

  /**
   * 校验某个场景配的模板 ID
   *
   * @param scene    场景键（须在 `MESSAGE_TEMPLATE_SPEC_MAP` 中，否则报 10001）
   * @param templateId 微信模板 ID（运营在后台填的那串 43 位）
   */
  async inspect(scene: string, templateId: string): Promise<TemplateVerifyResult> {
    const spec = MESSAGE_TEMPLATE_SPEC_MAP[scene];
    if (!spec) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `未知通知场景「${scene}」—— 场景键须来自服务端声明`,
      );
    }

    const id = String(templateId ?? '').trim();
    if (!id) {
      throw new BizException(ErrorCode.PARAM_INVALID, '该场景还没有填微信模板 ID，先填再校验');
    }

    const raw = await this.findTemplate(id);
    const actual = parseTemplateKeywords(raw.content);
    const expected = expectedKeywordsOf(spec.wxFields ?? {});
    const { ok, missing, extra } = diffKeywords(actual, expected);

    return {
      ok,
      templateId: id,
      title: raw.title ?? null,
      type: raw.type ?? null,
      actual,
      expected,
      missing,
      extra,
      message: this.buildMessage({ ok, title: raw.title, actual, expected, missing, extra }),
    };
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  /** 拉当前小程序账号下的模板列表，取出指定那一个 */
  private async findTemplate(priTmplId: string): Promise<WxTemplateRaw> {
    if (!this.tokens.configured) {
      throw new BizException(
        ErrorCode.INTERNAL_ERROR,
        'WX_MINI_APPID / WX_MINI_SECRET 未配置，无法向微信核对模板',
      );
    }

    const list = await this.fetchTemplateList();
    const hit = list.find((t) => t.priTmplId === priTmplId);
    if (!hit) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `微信侧找不到模板 ID「${priTmplId}」：可能还没在「我的模板」里添加成功，` +
          '或它属于另一个小程序（模板 ID 与 AppID 绑定，不能跨账号复用）。' +
          `当前账号下一共有 ${list.length} 个模板。`,
      );
    }
    return hit;
  }

  private async fetchTemplateList(): Promise<WxTemplateRaw[]> {
    let token = await this.tokens.get();
    let data = await this.getOnce(token);

    // token 可能刚被顶掉（登录侧/别处刷新）：清缓存重试一次
    const code = Number(data?.errcode ?? 0);
    if (code !== 0 && TOKEN_INVALID_CODES.has(code)) {
      this.logger.warn(`access_token 失效（errcode=${code}），已刷新并重试一次`);
      this.tokens.invalidate();
      token = await this.tokens.get();
      data = await this.getOnce(token);
    }

    const errcode = Number(data?.errcode ?? 0);
    if (errcode !== 0) {
      throw new BizException(
        ErrorCode.INTERNAL_ERROR,
        `向微信获取模板列表失败：errcode=${errcode} errmsg=${String(data?.errmsg ?? '未知')}`,
      );
    }

    const list = Array.isArray(data?.data) ? data.data : [];
    return list as WxTemplateRaw[];
  }

  private async getOnce(accessToken: string): Promise<{
    errcode?: number;
    errmsg?: string;
    data?: unknown;
  }> {
    const { data } = await axios.get(
      'https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate' +
        `?access_token=${encodeURIComponent(accessToken)}`,
      { timeout: 8000 },
    );
    return data ?? {};
  }

  private buildMessage(r: {
    ok: boolean;
    title?: string;
    actual: WxTemplateKeyword[];
    expected: WxTemplateKeyword[];
    missing: string[];
    extra: string[];
  }): string {
    const fmt = (ks: WxTemplateKeyword[]): string =>
      ks.map((k) => `${k.label}(${k.code})`).join(' · ');

    if (r.ok) {
      return (
        `编号已对齐：${fmt(r.actual)}。` +
        '⚠️ 编号对得上只代表「不会因字段报 47003」，请再核对一眼括号里的中文标签与你的预期是否一致' +
        '（编号相同但含义可能不同，比如模板的 time1 是「下单时间」而我们要填的是截单时刻）。'
      );
    }

    const parts: string[] = [];
    if (r.missing.length) {
      const names = r.expected
        .filter((k) => r.missing.includes(k.code))
        .map((k) => `${k.label}(${k.code})`)
        .join('、');
      parts.push(`模板里缺 ${names}`);
    }
    if (r.extra.length) {
      const names = r.actual
        .filter((k) => r.extra.includes(k.code))
        .map((k) => `${k.label}(${k.code})`)
        .join('、');
      parts.push(`模板里多出 ${names}（本场景没有对应数据）`);
    }

    return (
      `不能直接用：${parts.join('；')}。` +
      '微信要求模板里的**每个**关键词都必须给值，缺一个或多一个都会返回 47003。' +
      '两条路：① 换一个关键词集合刚好为「' +
      fmt(r.expected) +
      '」的模板；② 保留这个模板，把多出来的那个词该填什么告诉我，我加一行映射。'
    );
  }
}
