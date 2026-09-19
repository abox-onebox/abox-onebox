import { TakeoutPlatform, TAKEOUT_PLATFORM_LABEL } from '@abox/shared-types';

/**
 * `ab_supplier.takeout_links` 的**唯一读取口**
 *
 * ## 为什么必须抽出来（而不是各模块自己 `s.takeoutLinks?.meituan?.url`）
 *
 * 这一列有 **三个消费方**：运营后台 D33「外卖平台店铺链接配置」、用户端 U5「今日这盒 ·
 * 溯源」、以及后续可能的管理端报表。同一列 JSON 被三处各解析一遍，就必然出现
 * 「后台显示已入驻、端上却是灰的」这类**两边都不报错**的漂移 —— 本项目已反复踩过
 * 同一族缺陷（#63 / #67 / #76 / #79 / #84 / #92 / #93 / #94 的共同形状：
 * **同一件事两份表述，不被自动化执行的那一份必然悄悄错掉**）。
 *
 * ## 落库形状的两个坑（本函数负责吸收）
 *
 * ① **键缺失 ≠ 未入驻**：三平台**永远**返回满三条，未配置的 `configured=false`。
 *    筛掉未配置项会让「缺京东」这件事在界面上**看不见** —— 而运营恰恰需要看见它
 *    （缺平台是要去谈的，不是不存在的）。
 * ② `__recommended` 复用了 `{ url, shopId }` 的形状，但它的 `url` 里存的是
 *    **平台 key**（`meituan` / `taobao` / `jd`），**不是链接**。命名有误导性，
 *    但避免为它单开一层结构 —— 故在此显式收口，读的人不必知道这个约定。
 *
 * 读侧**同时**校验推荐合法性：写侧（`SupplierAdminService.setTakeoutLinks`）已经会在
 * 「推荐了但没配链接」时删掉悬空推荐，但**直接改库 / 改种子 / 历史数据**都能绕过写侧。
 * 读侧兜底才能保证「用户端永远拿不到一个点了没反应的推荐入口」。
 */

/** 落库后的单平台条目 */
export interface StoredTakeoutLink {
  url: string | null;
  shopId?: string | null;
}

/** 归一化后的单平台条目（三个消费方共用） */
export interface TakeoutLinkEntry {
  platform: TakeoutPlatform;
  /** 平台中文名（"美团外卖"）· 与后台 P33 配置页同一份文案（`TAKEOUT_PLATFORM_LABEL`） */
  label: string;
  /** 小程序路径或 H5 地址；未入驻为 null */
  url: string | null;
  /**
   * 平台内店铺标识（运营核对用）
   *
   * ⚠️ 后台接口回带、**用户端不得下发**（《接口规范》§3.2 C8：端上只要「能不能跳」，
   *    不要「店号是多少」）。由消费方自行决定是否带出。
   */
  shopId: string | null;
  configured: boolean;
}

export interface TakeoutLinksRead {
  /** **恒为 3 条**（美团 / 淘宝 / 京东，顺序固定），未配置的 `configured=false` */
  links: TakeoutLinkEntry[];
  /** 推荐平台；悬空（推荐了但该平台未配置）或值非法时为 null */
  recommended: TakeoutPlatform | null;
  configuredCount: number;
}

const KNOWN_PLATFORMS = Object.values(TakeoutPlatform) as string[];

/**
 * 读取并归一化 `ab_supplier.takeout_links`
 *
 * @param raw 实体上的原始 JSON 值（未初始化 / NULL / 脏数据都要能安全吞下）
 */
export function readTakeoutLinks(raw: unknown): TakeoutLinksRead {
  const src = (raw ?? {}) as Record<string, StoredTakeoutLink | undefined>;

  const links: TakeoutLinkEntry[] = Object.values(TakeoutPlatform).map((p) => {
    const url = src[p]?.url ?? null;
    return {
      platform: p,
      label: TAKEOUT_PLATFORM_LABEL[p],
      url,
      shopId: src[p]?.shopId ?? null,
      configured: !!url,
    };
  });

  // `__recommended.url` 里是平台 key；既要认得出，也要挡得住脏值
  const rawRecommended = src.__recommended?.url ?? null;
  const recommended =
    rawRecommended &&
    KNOWN_PLATFORMS.includes(rawRecommended) &&
    links.some((l) => l.platform === rawRecommended && l.configured)
      ? (rawRecommended as TakeoutPlatform)
      : null;

  return {
    links,
    recommended,
    configuredCount: links.filter((l) => l.configured).length,
  };
}
