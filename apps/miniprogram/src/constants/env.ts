/** 环境常量（构建期注入，见 .env.example） */
export const ENV = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1',
  wxMiniAppId: import.meta.env.VITE_WX_MINI_APPID || '',
  /**
   * 本地联调固定登录 code（**出厂默认身份**）
   *
   * `PROVIDER_MODE=mock` 时服务端接受 `dev:<userId>` 形态的 code，
   * 可反复登录**同一账号**（无需真实 AppID，也不必每次换 code），
   * 见 api-server `providers/wx-mini/mock-wx-mini.provider.ts`。
   *
   * ⭐ M5-15：本值只是**兜底**。实际取值走 `utils/dev-identity.ts` 的
   *    `currentDevCode()` = 本地身份记录 ?? 本值 —— 于是**本地联调可以换人**：
   *      H5 `http://<ip>:5180/?devCode=1002`（或小程序编译模式的 query）
   *    此前写死本值，导致「任何入口、任何设备都是 user#1001 李明」，
   *    人工测试无法验「普通用户 / 团员 / 团长」三种身份（见缺陷 #1）。
   *    ⚠️ 仅 `MODE !== 'production'` 生效；生产走真实 `uni.login`。
   */
  wxDevLoginCode: import.meta.env.VITE_WX_DEV_LOGIN_CODE || 'dev:1001',
  /** 是否演示模式（原型同款假数据开关） */
  demoMode: import.meta.env.MODE !== 'production',
} as const;
