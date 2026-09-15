/** 环境常量（构建期注入，见 .env.example） */
export const ENV = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1',
  wxMiniAppId: import.meta.env.VITE_WX_MINI_APPID || '',
  /** 是否演示模式（原型同款假数据开关） */
  demoMode: import.meta.env.MODE !== 'production',
} as const;
