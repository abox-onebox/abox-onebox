/**
 * api/support —— 客服入口（U17 · 《接口规范》§3.5）
 *
 * 【2026-09-15 口径】一期**不做在线客服**：所有「联系运营 / 联系客服」入口
 * （退出团长、余额争议、提现异常、发票与协议问题）统一跳「客服微信号」页面，
 * 由用户手动添加客服微信、**人工解决**。
 *
 * ⚠️ 微信号 / 电话 / 服务时间**全部由服务端下发**（运营在后台 `ab_config` 维护）——
 *    端上不得内置任何硬编码联系方式，否则换号时必须重新发版。
 */
import { http } from './request';

export interface SupportContact {
  /** 客服微信号（用户手动搜索添加） */
  wechatId: string;
  /** 客服微信二维码图片 URL；为空则端上**隐藏二维码区**（不占位、不伪造） */
  wechatQrcodeUrl: string | null;
  /** 客服电话；为空则隐藏 */
  phone: string | null;
  /** 服务时间文案，如「工作日 9:00 – 18:00」 */
  hours: string;
  /** 提示文案（端上不自造，服务端下发） */
  tips: string;
}

/** U17 · 客服入口配置（登录即可访问，不要求团长身份） */
export function fetchSupportContact(): Promise<SupportContact> {
  return http.get<SupportContact>('/me/support');
}
