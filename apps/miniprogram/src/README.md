# miniprogram · 开发须知

- **同端叠加身份**：用户端与团长端是**同一个小程序**，团长只是叠加身份（L10）。
  逻辑上不得拆成两个小程序工程。
- **tabBar 采用自定义底部条**（`components/ab-bottom-bar`），不用 uni-app 原生 tabBar：
  团长入口需按身份**动态出现**，原生 tabBar 无法满足。
- **设计 token**：统一写在 `src/styles/tokens.scss`，由 `src/uni.scss` 自动注入全项目。
- **页面归属**：以《项目目录结构 v2.0》§十 映射表为准，37 页一一对应。
- **口径纪律**：任何数值/文案与 `docs/` 冲突时，以 `docs/` 为准。
