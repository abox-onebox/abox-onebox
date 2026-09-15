/** 环境常量（构建期注入，见 .env.example） */
export const ENV = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1',
  wxMiniAppId: import.meta.env.VITE_WX_MINI_APPID || '',
  /**
   * 本地联调固定登录 code
   *
   * `PROVIDER_MODE=mock` 时服务端接受 `dev:<userId>` 形态的 code，
   * 可反复登录**同一账号**（无需真实 AppID，也不必每次换 code），
   * 见 api-server `providers/wx-mini/mock-wx-mini.provider.ts`。
   */
  wxDevLoginCode: import.meta.env.VITE_WX_DEV_LOGIN_CODE || 'dev:1001',
  /** 是否演示模式（原型同款假数据开关） */
  demoMode: import.meta.env.MODE !== 'production',
} as const;
