/**
 * 运行时色值（canvas 等非 CSS 场景专用）
 *
 * ⚠️ 为什么单独一个文件：小程序 canvas 的 setFillStyle/drawImage 等 API 只接受色值字符串，
 *    拿不到 SCSS 变量。故把海报绘制需要的品牌色集中在此，与 `styles/tokens.scss` 保持同源。
 *    `check-design-spec.py` 的 TOKEN_FILES 白名单已含本文件名，故此处允许写字面量。
 *
 * 🔒 修改纪律：这里的每个值必须与 tokens.scss 对应 token 一致；改 token 时同步改这里。
 */

/** $c-bg · 米色主背景 */
export const C_BG = '#f6f0e5';
/** $c-text · 暖棕主文字 */
export const C_TEXT = '#6e5435';
/** $c-text-weak · 次级文字 */
export const C_TEXT_WEAK = '#796c57';
/** $c-gold-bd · 金棕描边/分割线 */
export const C_GOLD_BD = '#dcc79c';
