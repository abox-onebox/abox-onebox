/**
 * api/user —— 个人中心（《接口规范》§3.5）
 *
 * 本期（M4-3）实装 **订阅授权清单**（§3.5 新增读侧，与 U15 同节）。
 * U12 用户信息 / U13 余额 / U14 余额明细 / U16 协议正文 仍待 M4 后续批次。
 */
import { http } from './request';

/** 一条「可请求订阅授权」的场景（服务端已按四条件筛过，端上不要再判） */
export interface SubscribeTemplateItem {
  /** 场景键（仅用于日志/埋点，**不要**拿它做业务分支） */
  scene: string;
  /** 场景中文名（端上不维护第二份文案） */
  label: string;
  /** 微信订阅消息模板 ID —— 直接作为 `requestSubscribeMessage` 的 `tmplIds` */
  templateId: string;
}

export interface SubscribeTemplateList {
  list: SubscribeTemplateItem[];
  /**
   * 口径说明（服务端下发，端上不复制）
   *
   * ⚠️ 列表为空**通常是正常的**：一期尚无微信模板 ID，没有可授权的对象。
   *    端上此时应**什么都不做**，而不是拿假 ID 去调微信。
   */
  note: string;
}

/**
 * 读取「当前可以让用户授权」的订阅消息场景
 *
 * ⚠️ 模板 ID 由运营在后台配置，**端上不得硬编码** —— 硬编码等于第二份真相：
 *    运营换了模板，端上还在请求旧 ID，两边都不报错。
 */
export function fetchSubscribeTemplates(): Promise<SubscribeTemplateList> {
  return http.get<SubscribeTemplateList>('/me/subscribe/templates');
}
