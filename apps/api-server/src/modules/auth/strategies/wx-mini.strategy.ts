/**
 * 说明：本文件不使用 Passport 策略。
 *
 * 小程序登录是**主动式**流程（不接受浏览器跳转 / 无回调 URL）：
 *   wx.login() 取 code → 服务端调 code2session 换 openid → 建号/查号 → 签发 JWT
 * 因此由 AuthService 直接调用 WxMiniProvider 完成，无需 passport 策略。
 *
 * 微信能力实现见：src/providers/wx-mini/（mock 与 real 两套，按 PROVIDER_MODE 切换）
 */
export const WX_MINI_STRATEGY_NOTE = 'see providers/wx-mini + auth.service.ts';
