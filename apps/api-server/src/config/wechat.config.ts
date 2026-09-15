import { registerAs } from '@nestjs/config';

/**
 * 微信生态与第三方资金通道配置
 *
 * 小程序（登录）· 微信支付 V3（用户实付收款）
 * 灵活用工平台（团长佣金代发 + 代扣个税 · C11）
 *   —— 供应商 / 集散中心走人工对公转账日结，不接 API（C11）
 *
 * PROVIDER_MODE=mock 时以上全部可留空，自动走本地假实现。
 */
export interface WechatConfig {
  mini: { appId: string; appSecret: string };
  pay: {
    mchId: string;
    apiV3Key: string;
    serialNo: string;
    privateKeyPath: string;
    notifyUrl: string;
  };
  flex: {
    name: string;
    appId: string;
    appSecret: string;
    apiBase: string;
    /** 平台服务费率（通常 6%–8%，由哪方承担见合规清单待确认项） */
    serviceFeeRate: number;
  };
  subscribe: { templates: Record<string, string> };
}

export default registerAs(
  'wechat',
  (): WechatConfig => ({
    mini: {
      appId: process.env.WX_MINI_APPID ?? '',
      appSecret: process.env.WX_MINI_SECRET ?? '',
    },
    pay: {
      mchId: process.env.WXPAY_MCH_ID ?? '',
      apiV3Key: process.env.WXPAY_API_V3_KEY ?? '',
      serialNo: process.env.WXPAY_SERIAL_NO ?? '',
      privateKeyPath: process.env.WXPAY_PRIVATE_KEY_PATH ?? '',
      notifyUrl: process.env.WXPAY_NOTIFY_URL ?? '',
    },
    flex: {
      name: process.env.FLEX_PLATFORM_NAME ?? '',
      appId: process.env.FLEX_PLATFORM_APP_ID ?? '',
      appSecret: process.env.FLEX_PLATFORM_APP_SECRET ?? '',
      apiBase: process.env.FLEX_PLATFORM_API_BASE ?? '',
      serviceFeeRate: Number(process.env.FLEX_PLATFORM_SERVICE_FEE_RATE ?? 0),
    },
    subscribe: {
      templates: {
        mealPublished: process.env.WX_TPL_MEAL_PUBLISHED ?? '',
        deliveryArrived: process.env.WX_TPL_DELIVERY_ARRIVED ?? '',
        commissionSettled: process.env.WX_TPL_COMMISSION_SETTLED ?? '',
      },
    },
  }),
);
