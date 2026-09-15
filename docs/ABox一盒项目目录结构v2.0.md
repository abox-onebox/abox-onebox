# ABox 一盒 · 项目目录结构 v2.0

> Monorepo · pnpm workspaces · 三个子项目：uni-app 小程序、NestJS 后端、Vue3 后台
> **端数口径（C7）**：4 角色 · 3 载体 —— 载体 = ① 小程序（用户 + 团长**同一端**，团长为叠加身份）② 供应商 Web ③ 运营后台 Web
> v2.0 依据：交接包 v1.1（锁定项 L1–L12 / 裁决 C1–C9）+ 原型 v4.9.1（37 页）+ PRD v2.1

---

## 〇、v2.0 相对 v1.0 的变更

| # | 变更 | 依据 |
| --- | --- | --- |
| 1 | **删除「楼长端」全部目录**（pages/floor-leader、views/floor-leader、modules/floor-leader、api/floor-leader.ts、shared-types/floor-leader） | L2：4 角色、**无楼长**，团长兼任取餐分发 |
| 2 | 端数表述由「三个子项目 5 端」更正为「**4 角色 · 3 载体**」 | C7 |
| 3 | 截单定时任务 `T-1 20:00` → **`T-1 24:00`** | L3 / PRD §1.2 |
| 4 | 套餐上架任务 `每日 09:00` → **`T-1 14:00`（开团）** | PRD §2.3：下单窗口 T-1 14:00–24:00 |
| 5 | 配送单生成任务 `T-1 22:00` → **`T 日 00:30`**（截单后生成） | 与 L3 时序一致 |
| 6 | 小程序页面目录**按 37 页权威地图重建**（原先是理想化占位，与原型不符） | 原型 v4.9.1 |
| 7 | 新增 **P38「今日这盒 · 商家溯源」** 页面与相关类型 | C8 |
| 8 | 新增 **集散中心配置** 模块（表驱动，默认 4 个可增删） | C4 / M34-05 |
| 9 | 后台删除 floor-leader 视图；新增 building（P37 五视图）与 supplier/distribution-center | C4 / 原型 P37 |
| 10 | 新增 §十「端-页-模块映射表」，作为开发期页面归属的唯一索引 | — |

---

## 一、根目录布局

```
abox-onebox/                            ← 项目根目录
├── .gitignore
├── .gitattributes
├── README.md
├── package.json                        ← 根 package.json，定义 workspaces
├── pnpm-workspace.yaml
├── .npmrc
├── .editorconfig
├── .prettierrc.json
├── .eslintrc.cjs
├── commitlint.config.cjs
├── docker-compose.yml                  ← 本地依赖（MySQL / Redis）
├── .env.example
├── docs/                               ← 项目文档（开发期唯一事实来源）
│   ├── ABox一盒PRDv2.1.md
│   ├── ABox一盒数据库ER设计v2.1.md
│   ├── ABox一盒接口规范v1.0.md          ← 阶段二产出
│   ├── ABox一盒订单状态机与全链路流转v1.0.md  ← 阶段二产出
│   ├── ABox一盒表结构评审意见v1.0.md       ← 阶段二产出（含 ab_leader_invite 等补齐 DDL）
│   ├── ABox一盒种子数据清单v1.0.md         ← 阶段二产出
│   ├── ABox一盒账号资源与密钥清单v1.0.md    ← 阶段三产出
│   ├── ABox一盒合规资质与协议清单v1.0.md    ← 阶段三产出
│   ├── ABox一盒设计token规范v1.0.html      ← 阶段一产出（原型的 tokens.scss 由它派生）
│   ├── ABox一盒MVP优化交接包v1.3.md        ← 口径权威（L1–L12 锁定项 / C1–C11 裁决）
│   ├── ABox一盒协作规范v1.0.md             ← 阶段四产出（分支 / 提交 / 评审 / DoD）
│   ├── ABox一盒开发里程碑计划v1.0.md        ← 阶段四产出（M1–M5 + 验收标准）
│   ├── ABox一盒开发基线冻结清单v1.0.md      ← 基线冻结（现行/废弃 + SHA-256）
│   ├── ABox一盒部署运维手册v1.0.md          ← 待产出（M5 前补齐）
│   └── api/                            ← 自动生成的接口文档（Swagger 输出）
├── scripts/                            ← 全局脚本
│   ├── setup.sh                        ← 一键初始化项目
│   ├── db-migrate.sh                   ← 数据库迁移
│   ├── db-seed.sh                      ← 种子数据
│   └── deploy.sh                       ← 一键部署
├── apps/
│   ├── miniprogram/                    ← uni-app 小程序（用户端 + 团长端「同端叠加身份」）
│   ├── admin-web/                      ← Vue3 后台（运营后台 + 供应商后台，按 role 过滤菜单）
│   └── api-server/                     ← NestJS 后端 API
└── packages/
    ├── shared-types/                   ← 前后端共享 TS 类型
    ├── shared-utils/                   ← 共享工具（时间处理、加密等）
    ├── eslint-config/                  ← 共享 ESLint 配置
    └── tsconfig/                       ← 共享 TS 配置
```

> ⚠️ **不再有独立「楼长端」工程**：原型与业务均为 4 角色，团长兼任取餐分发。

---

## 二、`apps/miniprogram` 小程序端（用户 + 团长同端）

```
apps/miniprogram/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.ts                  ← Tailwind for uni-app
├── src/
│   ├── main.ts                         ← 入口
│   ├── App.vue
│   ├── manifest.json                   ← uni-app 配置（AppID、名称）
│   ├── pages.json                      ← 页面路由
│   ├── uni.scss
│   ├── pages/
│   │   ├── index/                      ← P1  首页（含套餐详情卡片）
│   │   │   └── index.vue
│   │   ├── order-create/               ← P3  下单确认
│   │   │   ├── order-create.vue
│   │   │   └── components/
│   │   ├── pay-result/                 ← P4  支付结果
│   │   │   └── pay-result.vue
│   │   ├── order-detail/               ← P5  订单详情（状态机时间线）
│   │   │   └── order-detail.vue
│   │   ├── order-list/                 ← P6  订单列表
│   │   │   └── order-list.vue
│   │   ├── order-cancel/               ← P7  取消订单（截单前可自助退）
│   │   │   └── order-cancel.vue
│   │   ├── mine/                       ← P8  个人中心（含身份专区 / 申请团长）
│   │   │   └── mine.vue
│   │   ├── balance-detail/             ← P9  余额明细
│   │   │   └── balance-detail.vue
│   │   ├── leader-invite/              ← P10 团长邀请落地页（带团长 ID 参数）
│   │   │   └── leader-invite.vue
│   │   ├── traceability/               ← P38 今日这盒 · 商家溯源（C8）
│   │   │   ├── traceability.vue
│   │   │   └── components/supplier-card.vue
│   │   ├── leader/                     ← 团长端（叠加身份，同一小程序，非独立工程）
│   │   │   ├── workbench.vue           ← P11 工作台（战报 / 晋升进度 / 送达提醒）
│   │   │   ├── building.vue            ← P12 本楼概况
│   │   │   ├── orders.vue              ← P13 订单明细（含异常入口）
│   │   │   ├── refund.vue              ← P14 退款 / 异常处理（代退申请入口 · C6）
│   │   │   ├── pickup.vue              ← P15 取餐确认（一键分发）
│   │   │   ├── commission.vue          ← P16 佣金中心（4 级分佣）
│   │   │   ├── balance-log.vue         ← P17 余额流水
│   │   │   ├── withdraw.vue            ← P18 提现申请
│   │   │   ├── share.vue               ← P19 分享中心（微信群 / 海报二维码）
│   │   │   └── profile.vue             ← P20 团长资料（含退出团长身份）
│   │   └── webview/                    ← H5 容器（协议页 / 隐私政策）
│   ├── components/                     ← 通用组件
│   │   ├── meal-card/
│   │   ├── dish-card/
│   │   ├── supplier-card/              ← 溯源出品方卡片（C8）
│   │   ├── status-badge/
│   │   ├── countdown/
│   │   ├── empty-state/
│   │   ├── loading/
│   │   └── bottom-bar/
│   ├── composables/                    ← 组合式 API（hooks）
│   │   ├── use-wechat-pay.ts
│   │   ├── use-subscribe-message.ts    ← 微信订阅消息（退款结果必触达）
│   │   ├── use-countdown.ts            ← 截单倒计时（T-1 24:00）
│   │   ├── use-user.ts
│   │   ├── use-leader.ts               ← 团长叠加身份（isLeader 持久化）
│   │   └── use-request.ts
│   ├── stores/                         ← Pinia 状态
│   │   ├── user.ts
│   │   ├── cart.ts
│   │   ├── order.ts
│   │   └── leader.ts
│   ├── api/                            ← API 调用层
│   │   ├── request.ts                  ← axios 实例
│   │   ├── user.ts
│   │   ├── meal.ts
│   │   ├── order.ts
│   │   ├── leader.ts                   ← 团长端（含代退申请）
│   │   ├── traceability.ts             ← 今日这盒 / 出品方
│   │   ├── payment.ts
│   │   └── balance.ts
│   ├── utils/
│   │   ├── auth.ts                     ← 登录态管理
│   │   ├── format.ts                   ← 金额（¥25.80）、时间格式化
│   │   ├── storage.ts                  ← Storage 封装
│   │   └── router.ts                   ← 路由跳转
│   ├── constants/
│   │   ├── index.ts                    ← 统一定价 / 4 级佣金率 / 订单状态枚举
│   │   └── env.ts
│   └── styles/
│       ├── tokens.scss                 ← 设计 token（见《设计 token 规范 v1.0》）
│       ├── tailwind.css
│       └── common.scss
├── static/
│   ├── images/
│   ├── icons/
│   ├── fonts/                          ← 楷体 woff2（COS 托管，wx.loadFontFace 降级链）
│   └── tabs/
└── types/
    ├── meal.d.ts
    ├── order.d.ts
    └── user.d.ts
```

---

## 三、`apps/admin-web` 后台 Web（运营后台 + 供应商后台）

```
apps/admin-web/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── api/
│   │   ├── request.ts                  ← axios + 拦截器
│   │   ├── auth.ts
│   │   ├── meal.ts
│   │   ├── order.ts
│   │   ├── delivery.ts
│   │   ├── user.ts
│   │   ├── leader.ts                   ← 团长管理（含申请流水）
│   │   ├── supplier.ts
│   │   ├── distribution-center.ts      ← 集散中心配置（C4）
│   │   ├── finance.ts
│   │   └── stats.ts
│   ├── router/
│   │   ├── index.ts
│   │   ├── routes.ts
│   │   └── guards.ts                   ← 鉴权守卫（运营 / 供应商 role 过滤）
│   ├── stores/                         ← Pinia
│   │   ├── auth.ts
│   │   ├── app.ts
│   │   └── permission.ts
│   ├── layouts/
│   │   ├── default-layout.vue          ← TopBar + Sidebar + Content
│   │   └── login-layout.vue
│   ├── views/
│   │   ├── login/
│   │   ├── dashboard/                  ← 工作台
│   │   ├── meal/                       ← 套餐编排（M31 · P27–P29）
│   │   │   ├── matrix.vue              ← P27 日期 × 楼群 二维矩阵
│   │   │   ├── edit.vue                ← P28 创建 / 编辑套餐
│   │   │   └── template.vue            ← P29 套餐模板库
│   │   ├── order/                      ← 订单中心（M32 · P30–P31）
│   │   │   ├── list.vue                ← P30 列表（全部 / 异常订单 Tab）
│   │   │   └── detail.vue              ← P31 详情（含审批退款 · C6）
│   │   ├── leader/                     ← 团长管理（M33 · P32）
│   │   │   ├── list.vue                ← 团长名录（4 级 + 等级/佣金）
│   │   │   ├── apply.vue               ← 申请流水（提交即生效 · C3）
│   │   │   └── detail.vue
│   │   ├── supplier/                   ← 供应商管理（M34 · P33）
│   │   │   ├── list.vue                ← P33 供应商列表（合作 4 + 备选 6）
│   │   │   ├── edit.vue
│   │   │   ├── dishes.vue              ← 菜品库（分类：主菜/素菜/配菜/汤品/主食）
│   │   │   ├── distribution-center.vue ← 集散中心配置（C4 · 默认 4 个可增删）
│   │   │   └── takeout-links.vue       ← 外卖平台店铺链接配置（美团/淘宝/京东）
│   │   ├── building/                   ← 办公楼管理（M33 · P37 · 5 视图）
│   │   │   ├── overview.vue
│   │   │   ├── list.vue                ← 12 栋办公楼
│   │   │   ├── groups.vue              ← 5 楼群划分
│   │   │   ├── leader-binding.vue      ← 团长 ↔ 办公楼绑定
│   │   │   └── delivery-map.vue        ← 集散中心 → 办公楼 配送映射（R1–R4）
│   │   ├── finance/                    ← 财务结算（M35 · P34）
│   │   │   ├── overview.vue
│   │   │   ├── commission.vue          ← 团长佣金结算（4 级阶梯）
│   │   │   ├── supplier-share.vue      ← 供应商应付结算（¥14.00 菜品成本 + ¥5.00 集散）
│   │   │   ├── refund.vue              ← 退款管理（三段式审批）
│   │   │   └── reconciliation.vue      ← 对账中心
│   │   ├── stats/                      ← 数据统计（M36 · P35）
│   │   │   ├── core-metrics.vue
│   │   │   ├── building-rank.vue
│   │   │   ├── dish-heat.vue
│   │   │   └── retention.vue
│   │   └── system/                     ← 系统管理（M37 · P36）
│   │       ├── admin-user.vue
│   │       ├── role.vue
│   │       ├── operation-log.vue
│   │       ├── config.vue              ← 统一售价 ¥25.80 / 4 级佣金 / 截单 T-1 24:00
│   │       └── message-template.vue    ← 订阅消息模板
│   ├── components/                     ← 通用组件
│   │   ├── table/
│   │   ├── search-form/
│   │   ├── chart/                      ← ECharts 封装
│   │   ├── upload/
│   │   └── editor/
│   ├── composables/
│   ├── utils/
│   ├── constants/
│   └── styles/
└── public/
```

> **供应商端**（商家后台）共用此工程，通过 `role` 字段做菜单过滤（仅 P21–P26 对应视图），**无需独立部署**。
> 原「楼长管理」视图（floor-leader）**已删除**（L2）。

---

## 四、`apps/api-server` NestJS 后端

```
apps/api-server/
├── package.json
├── tsconfig.json
├── nest-cli.json
├── .env.example
├── src/
│   ├── main.ts                         ← 启动入口
│   ├── app.module.ts
│   ├── common/                         ← 公共模块
│   │   ├── decorators/
│   │   │   ├── user.decorator.ts
│   │   │   ├── roles.decorator.ts
│   │   │   └── idempotent.decorator.ts ← 幂等键（下单 / 结算）
│   │   ├── guards/
│   │   │   ├── auth.guard.ts
│   │   │   ├── roles.guard.ts
│   │   │   └── wx-signature.guard.ts
│   │   ├── interceptors/
│   │   │   ├── logging.interceptor.ts
│   │   │   ├── transform.interceptor.ts
│   │   │   └── timeout.interceptor.ts
│   │   ├── filters/
│   │   │   ├── http-exception.filter.ts
│   │   │   └── validation.filter.ts
│   │   ├── pipes/
│   │   │   └── validation.pipe.ts
│   │   ├── middleware/
│   │   │   ├── request-id.middleware.ts
│   │   │   └── rate-limit.middleware.ts
│   │   └── utils/
│   │       ├── crypto.ts               ← AES 加密手机号
│   │       ├── order-no.ts             ← 订单号生成
│   │       ├── time.ts
│   │       └── response.ts
│   ├── config/
│   │   ├── config.module.ts
│   │   ├── database.config.ts
│   │   ├── redis.config.ts
│   │   ├── wechat.config.ts            ← 微信支付 / 小程序 / 订阅消息配置
│   │   └── app.config.ts
│   ├── database/
│   │   ├── database.module.ts
│   │   ├── data-source.ts              ← TypeORM data source
│   │   ├── migrations/                 ← 数据库迁移
│   │   │   └── 1700000000000-init.ts
│   │   └── seeds/                      ← 种子数据（¥25.80 / 4 级佣金 / 4 集散中心 / 12 楼）
│   │       └── seed.ts
│   ├── modules/
│   │   ├── auth/                       ← 鉴权（小程序登录、后台登录）
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── strategies/
│   │   │   │   ├── wx-mini.strategy.ts
│   │   │   │   └── jwt.strategy.ts
│   │   │   └── dto/
│   │   ├── user/
│   │   ├── building/                   ← 办公楼 / 楼群
│   │   ├── supplier/                   ← 供应商 + 菜品
│   │   │   ├── supplier.module.ts
│   │   │   ├── supplier.controller.ts
│   │   │   ├── supplier.service.ts
│   │   │   ├── dish/
│   │   │   ├── takeout-link/           ← 外卖平台链接（美团/淘宝/京东）
│   │   │   └── dto/
│   │   ├── distribution-center/        ← 集散中心配置（C4 · 表驱动，默认 4 个）
│   │   │   ├── distribution-center.module.ts
│   │   │   ├── distribution-center.controller.ts
│   │   │   ├── distribution-center.service.ts
│   │   │   └── dto/
│   │   ├── meal/                       ← 套餐编排
│   │   │   ├── meal.module.ts
│   │   │   ├── meal.controller.ts
│   │   │   ├── meal.service.ts
│   │   │   └── dto/
│   │   ├── traceability/               ← 今日这盒 · 出品方溯源（C8 · 只读聚合）
│   │   │   ├── traceability.module.ts
│   │   │   ├── traceability.controller.ts
│   │   │   └── traceability.service.ts
│   │   ├── order/                      ← 订单
│   │   │   ├── order.module.ts
│   │   │   ├── order.controller.ts
│   │   │   ├── order.service.ts
│   │   │   ├── order-state-machine.ts  ← 状态机（用户 5 态 / 团长 6 态 / 后台 8 态）
│   │   │   └── dto/
│   │   ├── delivery/                   ← 配送单
│   │   │   ├── delivery.module.ts
│   │   │   ├── delivery.controller.ts
│   │   │   ├── delivery.service.ts
│   │   │   └── dto/
│   │   ├── team-leader/                ← 团长端（叠加身份）
│   │   │   ├── team-leader.module.ts
│   │   │   ├── team-leader.controller.ts
│   │   │   ├── team-leader.service.ts
│   │   │   ├── level.service.ts        ← 4 级升降级判定（C2 双条件）
│   │   │   ├── invite.service.ts       ← 推荐裂变与晋级审计
│   │   │   ├── share.service.ts        ← 小程序码生成
│   │   │   └── dto/
│   │   ├── payment/                    ← 微信支付集成
│   │   │   ├── payment.module.ts
│   │   │   ├── payment.controller.ts   ← 回调
│   │   │   ├── payment.service.ts
│   │   │   ├── wxpay.service.ts        ← 微信支付 SDK 封装
│   │   │   ├── wxpay-config.ts
│   │   │   └── dto/
│   │   ├── finance/                    ← 财务
│   │   │   ├── finance.module.ts
│   │   │   ├── finance.controller.ts
│   │   │   ├── commission.service.ts   ← 团长佣金（8/9/10/12%）
│   │   │   ├── supplier-share.service.ts ← 供应商应付结算（菜品成本 ¥14.00；**日结**：T+1 生成应付，财务按日付款 · C11）
│   │   │   ├── refund.service.ts       ← 退款三段式（申请 → 审批 → 实退 · C6）
│   │   │   ├── reversal.service.ts     ← 反向冲减（已结算后退款回退）
│   │   │   ├── reconciliation.service.ts ← 对账
│   │   │   ├── withdraw.service.ts     ← 提现申请与审批（申请 → 审批 → 生成打款批次）
│   │   │   ├── payout.service.ts       ← 佣金出款批次（**C11**：灵活用工平台代发 + 个税代扣；一期清单导出 + 回执登记）
│   │   │   └── dto/
│   │   ├── message/                    ← 消息推送
│   │   │   ├── message.module.ts
│   │   │   ├── message.service.ts
│   │   │   ├── wechat-template.service.ts
│   │   │   └── templates/
│   │   ├── stats/                      ← 数据统计
│   │   │   ├── stats.module.ts
│   │   │   ├── stats.controller.ts
│   │   │   └── stats.service.ts
│   │   └── admin/                      ← 后台管理
│   │       ├── admin.module.ts
│   │       ├── admin.controller.ts
│   │       ├── admin.service.ts
│   │       ├── admin-user/
│   │       ├── role/
│   │       ├── operation-log/
│   │       ├── config/
│   │       └── dashboard/
│   ├── tasks/                          ← 定时任务（时间点已按 L3 / PRD §1.2 校正）
│   │   ├── tasks.module.ts
│   │   ├── schedule.service.ts         ← @nestjs/schedule
│   │   ├── meal-publish.task.ts        ← T-1 14:00 套餐上架（开团）
│   │   ├── cutoff.task.ts              ← T-1 24:00 截单（锁定订单 + 推备料量）
│   │   ├── delivery-generate.task.ts   ← T 日 00:30 生成配送单
│   │   ├── auto-confirm.task.ts        ← T 日 14:00 自动确认收货（关键锚点 2）
│   │   ├── commission-settle.task.ts   ← T+1 02:00 佣金结算
│   │   ├── supplier-share.task.ts      ← T+1 02:00 生成供应商应付结算单
│   │   ├── reconciliation.task.ts      ← 每日 04:00 对账
│   │   └── leader-expire.task.ts       ← 每日 03:00 见习团长 30 天未促单失效（C2）
│   ├── queues/                         ← 消息队列消费者（MVP 用 Redis + BullMQ）
│   │   ├── queues.module.ts
│   │   ├── order-paid.consumer.ts
│   │   ├── refund-apply.consumer.ts
│   │   └── settle-orders.consumer.ts
│   └── health/
│       └── health.controller.ts        ← /health
├── test/
│   ├── unit/
│   └── e2e/
└── public/
    └── qrcodes/                        ← 小程序码缓存
```

> **已删除**：`modules/floor-leader/`（L2 无楼长）。
> **队列说明**：交接包 D 方向结论 —— MVP 体量（≈500 单/天）**不引入 RabbitMQ**，用 Redis + BullMQ 足够；`rabbitmq.config.ts` 与 `amqplib` 依赖相应移除。

---

## 五、`packages/shared-types` 共享类型（关键）

```
packages/shared-types/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── api/
│   │   ├── common.ts                   ← 统一响应结构
│   │   ├── user.ts
│   │   ├── meal.ts
│   │   ├── order.ts
│   │   ├── delivery.ts
│   │   ├── team-leader.ts              ← 团长（含 level 等级）
│   │   ├── supplier.ts
│   │   ├── distribution-center.ts      ← 集散中心（C4）
│   │   ├── traceability.ts             ← 今日这盒出品方（C8）
│   │   └── finance.ts
│   ├── enums/
│   │   ├── order-status.ts             ← 用户 5 态 / 团长 6 态 / 后台 8 态
│   │   ├── meal-status.ts
│   │   ├── role.ts
│   │   ├── leader-level.ts             ← 见习 / 正式 / 金牌 / 首席
│   │   ├── payout-channel.ts           ← 佣金出款通道（C11：灵活用工代发 / 已停用的微信商家转账）
│   │   └── dish-slot.ts                ← 主菜 / 素菜 / 配菜 / 汤品 / 主食
│   └── dto/                            ← 共享 DTO（前后端共用）
│       ├── create-order.dto.ts
│       └── ...
```

> **已删除**：`api/floor-leader.ts`（L2 无楼长）。

---

## 六、Docker Compose（本地依赖）

```yaml
# docker-compose.yml
services:
  mysql:
    image: mysql:8.0
    container_name: abox-mysql
    restart: always
    ports:
      - "3306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: root123
      MYSQL_DATABASE: abox_onebox
      TZ: Asia/Shanghai
    volumes:
      - ./data/mysql:/var/lib/mysql
      - ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql
    command:
      --character-set-server=utf8mb4
      --collation-server=utf8mb4_unicode_ci
      --default-time-zone=+08:00

  redis:
    image: redis:7-alpine
    container_name: abox-redis
    restart: always
    ports:
      - "6379:6379"
    volumes:
      - ./data/redis:/data
```

> 相对 v1.0 **移除 RabbitMQ**（D 方向结论：MVP 不引入消息中间件，Redis + BullMQ 足够）。

---

## 七、关键技术依赖版本（建议锁定）

### 7.1 后端 `apps/api-server/package.json`

```json
{
  "dependencies": {
    "@nestjs/core": "^10.3.0",
    "@nestjs/common": "^10.3.0",
    "@nestjs/platform-express": "^10.3.0",
    "@nestjs/config": "^3.1.0",
    "@nestjs/jwt": "^10.2.0",
    "@nestjs/passport": "^10.0.0",
    "@nestjs/schedule": "^4.0.0",
    "@nestjs/swagger": "^7.3.0",
    "@nestjs/typeorm": "^10.0.0",
    "typeorm": "^0.3.17",
    "mysql2": "^3.6.5",
    "ioredis": "^5.3.2",
    "bullmq": "^5.1.0",
    "passport-jwt": "^4.0.1",
    "class-validator": "^0.14.0",
    "class-transformer": "^0.5.1",
    "axios": "^1.6.0",
    "wechatpay-node-v3": "^2.1.0",
    "tencentcloud-sdk-nodejs": "^4.0.0",
    "qrcode": "^1.5.3",
    "dayjs": "^1.11.10",
    "winston": "^3.10.0",
    "nest-winston": "^1.9.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.3.0",
    "@nestjs/testing": "^10.3.0",
    "@types/node": "^20.10.0",
    "@types/express": "^4.17.21",
    "typescript": "^5.3.0",
    "ts-node": "^10.9.0",
    "jest": "^29.7.0",
    "supertest": "^6.3.0"
  }
}
```

### 7.2 小程序 `apps/miniprogram/package.json`

```json
{
  "dependencies": {
    "@dcloudio/uni-app": "3.0.0-4000020250101001",
    "@dcloudio/uni-app-plus": "3.0.0-4000020250101001",
    "@dcloudio/uni-components": "3.0.0-4000020250101001",
    "@dcloudio/uni-h5": "3.0.0-4000020250101001",
    "@dcloudio/uni-mp-weixin": "3.0.0-4000020250101001",
    "vue": "^3.4.0",
    "pinia": "^2.1.0",
    "dayjs": "^1.11.10",
    "axios": "^1.6.0"
  },
  "devDependencies": {
    "@dcloudio/types": "^3.4.0",
    "@dcloudio/uni-automator": "3.0.0-4000020250101001",
    "@dcloudio/vite-plugin-uni": "3.0.0-4000020250101001",
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "@vue/tsconfig": "^0.5.1"
  }
}
```

### 7.3 后台 `apps/admin-web/package.json`

```json
{
  "dependencies": {
    "vue": "^3.4.0",
    "vue-router": "^4.2.0",
    "pinia": "^2.1.0",
    "element-plus": "^2.4.0",
    "@element-plus/icons-vue": "^2.3.0",
    "axios": "^1.6.0",
    "echarts": "^5.4.0",
    "vue-echarts": "^6.6.0",
    "dayjs": "^1.11.10",
    "nprogress": "^0.2.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.0",
    "vite": "^5.0.0",
    "typescript": "^5.3.0",
    "vue-tsc": "^1.8.0",
    "unplugin-auto-import": "^0.17.0",
    "unplugin-vue-components": "^0.26.0"
  }
}
```

---

## 八、一键初始化脚本 `scripts/setup.sh`

```bash
#!/bin/bash
set -e

echo "🚀 初始化 ABox 一盒项目..."

# 1. 安装依赖
pnpm install

# 2. 启动本地依赖
docker compose up -d

# 3. 等待 MySQL 就绪
echo "⏳ 等待 MySQL 启动..."
sleep 10

# 4. 复制环境变量
cp .env.example .env
cp apps/api-server/.env.example apps/api-server/.env

# 5. 运行数据库迁移
pnpm --filter api-server db:migrate

# 6. 导入种子数据
pnpm --filter api-server db:seed

# 7. 启动开发服务器
echo "✅ 初始化完成！"
echo ""
echo "📌 启动命令："
echo "  pnpm dev              # 同时启动前后端"
echo "  pnpm dev:api          # 仅启动 API"
echo "  pnpm dev:mp           # 仅启动小程序"
echo "  pnpm dev:admin        # 仅启动后台"
```

---

## 九、目录命名规范

| 类型 | 规范 | 示例 |
| --- | --- | --- |
| 文件名 | kebab-case | `meal-card.vue`、`order.service.ts` |
| 组件名 | PascalCase | `MealCard.vue` |
| 类名 | PascalCase | `OrderService` |
| 变量/函数 | camelCase | `getOrderById` |
| 常量 | UPPER_SNAKE | `MAX_QUANTITY_PER_ORDER` |
| 数据库表名 | snake_case | `ab_order_item` |
| 数据库字段 | snake_case | `team_leader_id` |
| 接口路径 | kebab-case | `/api/v1/set-meals` |
| 环境变量 | UPPER_SNAKE | `WECHAT_PAY_MCH_ID` |

---

## 十、端-页-模块映射表（开发期唯一索引）

> 原型 37 页 ↔ PRD 模块编号 ↔ 代码落点，三者一一对应。开发时以此表为归属依据。

### 10.1 小程序载体（用户端 + 团长端 · 同一端）

| 原型页 | 功能 | PRD 模块 | 代码落点 |
| --- | --- | --- | --- |
| P1 | 首页（套餐详情） | M01-01 | `pages/index/` |
| P3 | 下单确认 | M02-01/02 | `pages/order-create/` |
| P4 | 支付结果 | M02-04 | `pages/pay-result/` |
| P5 | 订单详情 | M03-02 | `pages/order-detail/` |
| P6 | 订单列表 | M03-01/04 | `pages/order-list/` |
| P7 | 取消订单 | M03-03 | `pages/order-cancel/` |
| P8 | 个人中心 | M04-01 | `pages/mine/` |
| P9 | 余额明细 | M04-03 | `pages/balance-detail/` |
| P10 | 团长邀请落地 | M01-03 | `pages/leader-invite/` |
| **P38** | **今日这盒 · 商家溯源** | **M01-04** | **`pages/traceability/`** |
| P11 | 团长工作台 | M11-01/02 | `pages/leader/workbench.vue` |
| P12 | 本楼概况 | M12-01 | `pages/leader/building.vue` |
| P13 | 订单明细 | M12-02/03 | `pages/leader/orders.vue` |
| P14 | 退款 / 异常处理 | M12-04 | `pages/leader/refund.vue` |
| P15 | 取餐确认 | M13-01/03 | `pages/leader/pickup.vue` |
| P16 | 佣金中心 | M14-01 | `pages/leader/commission.vue` |
| P17 | 余额流水 | M14-02 | `pages/leader/balance-log.vue` |
| P18 | 提现申请 | M14-03/04 | `pages/leader/withdraw.vue` |
| P19 | 分享中心 | M11-03 | `pages/leader/share.vue` |
| P20 | 团长资料 | M15-01/02/03 | `pages/leader/profile.vue` |

### 10.2 供应商 Web 载体

| 原型页 | 功能 | PRD 模块 | 代码落点（admin-web，role=supplier） |
| --- | --- | --- | --- |
| P21 | 商家工作台 | M21-01 | `views/dashboard/`（供应商视图） |
| P22 | 出餐确认 | M21-02/03 | `views/order/`（出餐视图） |
| P23 | 我的菜品 | M22-01 | `views/supplier/dishes.vue` |
| P24 | 上架申请 | M22-02 | `views/supplier/edit.vue` |
| P25 | 应付结算明细 | M23-01/02 | `views/finance/supplier-share.vue` |
| P26 | 商家资料 | M24-01/02 | `views/supplier/edit.vue`（资料页） |

### 10.3 运营后台 Web 载体

| 原型页 | 功能 | PRD 模块 | 代码落点（admin-web，role=admin） |
| --- | --- | --- | --- |
| P27 | 套餐矩阵 | M31-01 | `views/meal/matrix.vue` |
| P28 | 新建套餐 | M31-02/03 | `views/meal/edit.vue` |
| P29 | 套餐模板 | M31-04 | `views/meal/template.vue` |
| P30 | 订单中心 | M32-01/02/06 | `views/order/list.vue` |
| P31 | 订单详情 | M32-03/04/05 | `views/order/detail.vue` |
| P32 | 团长管理 | M33-03/04/05 | `views/leader/` |
| P33 | 供应商管理 | M34-01/02/03/04/05 | `views/supplier/` |
| P34 | 财务结算 | M35-01…08 | `views/finance/` |
| P35 | 数据看板 | M36-01…04 | `views/stats/` |
| P36 | 系统配置 | M37-01…04 | `views/system/` |
| P37 | 办公楼管理（5 视图） | M33-01/02 | `views/building/` |

---

## 十一、变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-09-13 | 首版：Monorepo 布局、三个子项目、Docker Compose、依赖版本 |
| v2.0.1 | 2026-09-14 | docs/ 清单补入阶段二（接口规范 / 订单状态机 / 表结构评审 / 种子数据）与阶段三（账号资源 / 合规资质）产出 |
| **v2.0** | 2026-09-14 | 对齐交接包 v1.1 与原型 v4.9.1：**删除楼长端**（L2）、端数改「4 角色 · 3 载体」（C7）、截单任务改 T-1 24:00（L3）、套餐上架改 T-1 14:00、配送单生成改 T 日 00:30、页面目录按 37 页权威地图重建、新增 P38 溯源页（C8）与集散中心配置（C4）、移除 RabbitMQ（D 方向）、新增 §十 端-页-模块映射表 |
| v2.0.2 | 2026-09-14 | §四 `tasks/` 补入 **`leader-expire.task.ts`**（C2 见习 30 天未促单失效）——原《目录结构 v2.0》漏列，由《订单状态机 v1.0》§3.1 指出并回填 |
| v2.0.3 | 2026-09-14 | §一 `docs/` 清单补入阶段四产出（协作规范 / 里程碑计划 / 基线冻结清单）与口径权威件《交接包 v1.3》 |
| v2.0.4 | 2026-09-14 | 对齐 **C11**（佣金个税与出款通道 + 供应商日结）：§四 `finance/` 新增 `payout.service.ts`、`withdraw.service.ts` / `supplier-share.service.ts` 注释补口径；§五 `enums/` 新增 `payout-channel.ts` |

---

*文档结束 · ABox 一盒 · 项目目录结构 v2.0 · 2026-09-14*
