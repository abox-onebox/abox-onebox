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
├── docker-compose.yml                  ← 本地依赖（MySQL / Redis，仅开发）
├── docker-compose.prod.yml             ← 【M5-0】生产编排（mysql / redis / api / admin 四服务 · 依赖不暴露宿主端口）
├── .dockerignore                       ← 【M5-0】构建上下文裁剪（排除 .env* / data / node_modules / dist）
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
│   ├── ABox一盒部署运维手册v1.0.md          ← 【M5-0】已产出（拓扑 / 密钥纪律 / 部署流程 / 监控 / 备份恢复 / 应急预案 / 遗留风险）
│   ├── ABox一盒自营结算口径定义v1.0.md      ← 结算口径权威（M3-9 起）
│   └── api/                            ← 自动生成的接口文档（Swagger 输出）
├── scripts/                            ← 全局脚本
│   ├── setup.sh                        ← 一键初始化项目（PowerShell 版：setup.ps1）
│   ├── init.sql                        ← MySQL 初始化（供 docker 入口挂载）
│   ├── sync-docs.mjs                   ← 根文档 → docs/ 镜像同步
│   ├── gate.mjs                        ← 免 pnpm 门禁执行器（⭐ **20 道**：M5-2 增 `schema:parity`，M5-3 增 `route:audit` + `security:scan`，M5-6 增 `index:parity`，M5-7 增 `state:audit`；⭐ M5-9 增独立门禁 **`seed:demo`** —— 演示/边界数据集，**刻意不并进 `seed`**）
│   ├── e2e-m1.mjs / e2e-m2.mjs / e2e-m3.mjs   ← 端到端验收（真实起服务 + 真实 HTTP）
│   ├── lib/e2e-server.mjs              ← e2e 共用托管（端口隔离 + 进程树回收 + 健康轮询）
│   ├── local-test.mjs                  ← 【本地内部测试】一键起「API + 用户端 H5 + 运营后台」并打印**手机扫码地址**（云服务器就绪前的内部测试入口）· ⚠️ M5-9 收尾修：`--build` 重建 H5 前先把 `dist-h5` **改名挪走**，否则 vite 的 `emptyOutDir` 撞沙箱 bulk-delete 守卫，报「构建失败」而**代码一行没错**
│   ├── lib/local-server.mjs            ← 【本地内部测试】静态托管 + `/api` **同源反向代理**（手机访问不依赖固定 IP、无跨域）· ⚠️ `/static` 是**前缀冲突点**：uni-app 前端静态目录与 API 本地上传目录**同名** → 走「**文件优先、代理兜底**」（dist 里有就直接给，没有的如 `/static/dishes/xx.jpg` 才透传 API）
│   ├── lib/local-smoke.mjs             ← 【本地内部测试】11 项端到端自检（走「页面 → 同源代理 → 后端」**真实链路**，非直连后端）
│   ├── make-qr.mjs                     ← 【M5-9】人工测试**入口卡**生成器（四个入口的二维码 + 后台链接 → 一页 A4 内联 SVG + 4 张 PNG）；⭐ 生成后**反解校验**（jimp + qrcode-reader 把 PNG 解回来比对 URL）；⚠️ 端口默认值**必须与 `local-test.mjs` 一致**，漂移即「卡上的码扫不开」
│   ├── make-font-subset.py             ← 【M5-9 收尾二】H5 **品牌字体子集**生成器（楷体 KaiTi 是 Windows 字体、**手机上没有** → 整条字体栈落空回退黑体，页面观感「失真」；对策 = 自带 woff2 子集：GB2312 一级汉字 + ASCII + 常用标点 + 源码全部 CJK ≈ 3907 字 / **583KB**，字符清单 `ab-kaiti-chars.txt` 也在本目录）；换字体 / 加字重时**重跑一次**即可
│   │   └── （产物）apps/miniprogram/src/static/fonts/ab-kaiti.woff2 → 构建进 `dist-h5/static/fonts/`，经 5180 同源下发
│   ├── db-migrate.sh / db-seed.sh      ← ⚠️ `pnpm --filter` 的**薄包装**（各 5 行）；本机 pnpm 不可用，实际迁移与种子走 `gate.mjs`
│   ├── deploy.sh                       ← 【M5-0】一键部署（预检 → 备份 → 起依赖 → 构建 → 迁移 → up → 健康验证）
│   ├── rollback.sh                     ← 【M5-0】回滚（默认不退迁移，`--with-migrate-revert` 才退）
│   ├── backup-db.sh                    ← 【M5-0】数据库备份（mysqldump --single-transaction + 空导出检查）
│   ├── restore-db.sh                   ← 【M5-0】数据库恢复（破坏性 · 必须 `--yes` · 回滚前自动备份）
│   ├── healthcheck.sh                  ← 【M5-0】健康检查（退出码 0/1/2，可直接进 CI / cron）
│   ├── ops-daily.sh                    ← 【M5-12】**运维日巡检**（探针两级 + 备份新鲜度 + 磁盘余量 → 收成一个退出码 0/1/2；⚠️ 探测前**显式清掉 `http_proxy` 等**，否则 curl 会打代理、拿回与「服务挂了」同形的 502）
│   └── install-cron.sh                 ← 【M5-12】**cron 幂等安装器**（读模板 → 替换占位符 → 标记块替换写入；`--dry-run` / `--list` / `--uninstall`）；⭐ 内容**全部来自模板**、标记行也从模板取，自己一行都不生成
├── deploy/                             ← 【M5-12】服务器侧声明（与 `apps/*/Dockerfile`、`docker-compose.prod.yml` 配套）
│   └── cron/abox-ops.cron              ← ⭐ **周期性运维动作的唯一真相**（05:00 备份 / 08:30 巡检）；⚠️ 是**模板**（含 `{{ABOX_REPO}}` / `{{ABOX_LOG_DIR}}` 占位符），必须经 `install-cron.sh` 渲染后才可进 crontab
├── apps/
│   ├── miniprogram/                    ← uni-app 小程序（用户端 + 团长端「同端叠加身份」）
│   ├── admin-web/                      ← Vue3 后台（运营后台 + 供应商后台，按 role 过滤菜单）
│   │   ├── Dockerfile                  ← 【M5-0】静态站镜像（nginx）
│   │   └── nginx.conf                  ← 【M5-0】SPA fallback / 反代 / 安全头
│   └── api-server/                     ← NestJS 后端 API
│       └── Dockerfile                  ← 【M5-0】多阶段构建（非 root / tzdata / HEALTHCHECK / exec CMD）
└── packages/
    ├── shared-types/                   ← 前后端共享 TS 类型
    ├── shared-utils/                   ← 共享工具（时间处理、加密等）
    ├── eslint-config/                  ← 共享 ESLint 配置
    └── tsconfig/                       ← 共享 TS 配置
```

> ⚠️ **不再有独立「楼长端」工程**：原型与业务均为 4 角色，团长兼任取餐分发。
> ⚠️ **`docker-compose.yml` 与 `docker-compose.prod.yml` 是两套东西**：前者只起本地依赖、给开发者手动跑（app 直跑 node），后者是**生产全栈编排**（含 api / admin 两个应用镜像）。混用会出现「以为在生产部署，其实起的是本地依赖」。详见《部署运维手册 v1.0》§拓扑。
> ⚠️ **M5-0 的镜像与脚本未在真机执行过**（本机无 Docker）—— 目录登记的是**产物存在**，不等于**已在生产验证**。

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
│   │   ├── delivery.ts                 ← 配送单（**M5-1**：D61 列表 / D62 人工修正）
│   │   ├── user.ts
│   │   ├── leader.ts                   ← 团长管理（含申请流水）
│   │   ├── supplier.ts
│   │   ├── distribution-center.ts      ← 集散中心配置（C4）
│   │   ├── finance.ts
│   │   ├── stats.ts
│   │   └── schedule.ts                 ← 【M5-12】跑批时刻表（D64 读 / D65 补跑）；⚠️ **刻意不并进 `api/system.ts`** —— 服务端控制器不在 `modules/admin/`（放进去会让 `AdminModule` 反向依赖全部业务模块），前端同理另起一件
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
│   │   │   ├── detail.vue              ← P31 详情（含审批退款 · C6）
│   │   │   └── delivery.vue            ← D61/D62 配送单管理 + **D63 状态推进**（**M5-1** 列表 + 人工修正弹窗；**M5-8** 每行「推进到 X」按钮 + 确认弹窗 + 「订单进度」列，只有 operator 及以上可见）
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
│   │   │   ├── supplier-share.vue      ← 供应商应付结算（协商供价 + 场地费/打包人工/配送费 · C9 修订）
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
│   │       ├── message-template.vue    ← 订阅消息模板
│   │       └── schedule.vue            ← 【M5-12】**跑批时刻表**（8 任务 × 出厂 cron / **实际注册 cron** / 生效时刻 / 目标日语义 / 实装状态 + 手动补跑弹窗）；⭐ 整页最要紧的一列是「实际注册」—— `null` 即该任务**永远不会跑且不报错**；⚠️ 端上不复刻任何服务端规则（`24:00` 不折算、日期语义用服务端下发的 `dateKindLabel`），「是否被配置覆写」只用 `registeredCron !== cron` 这个**纯字符串比较**
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
│   │   ├── utils/
│   │   │   ├── crypto.ts               ← AES 加密手机号
│   │   │   ├── order-no.ts             ← 订单号生成
│   │   │   ├── tz.ts                   ← ⭐ M5-3 全项目统一时区常量（时间轴与调度声明表共用，避免两处写）
│   │   │   ├── order-timeline.ts       ← ⭐⭐ M5-3 **业务时刻的唯一真相**（`DEFAULT_TIMELINE` 9 时刻 +
│   │   │   │                              `ab_config` 5 键覆写 + `cronOf()` + 进程级生效值 `currentTimeline()`
│   │   │   │                              + 变更通知）。`TASK_SCHEDULES[*].cron` 与下方 `time.ts` 的锚点
│   │   │   │                              函数**都是它的派生值** —— 改前同一批时刻在三处各写一遍且无机械
│   │   │   │                              对账（配置 23:59 / cron 00:00 / 下单窗口 23:00，三者对不齐且不报错 = #49）
│   │   │   ├── time.ts                 ← 时间**算法**（日期加减 / 时区换算 / 时钟注入）；锚点函数读
│   │   │   │                              `currentTimeline()`，⚠️ 此处不得再写死 `14` / `11.5` 这类数字
│   │   │   └── response.ts
│   │   ├── security/                   ← ⭐ M5-3 安全自检两支（`gate.mjs` 门禁 `route:audit` / `security:scan`）
│   │       ├── route-audit.ts          ← 越权全量机械对账（**运行时反射**读全部 controller 元数据，
│   │       │                              10 条规则 R1–R10；判据与 `AdminGuard` **逐字对齐**：
│   │       │                              `roles.length > 0` 才算声明 —— 空 `@Roles()` 是 truthy）
│   │       └── security-scan.ts        ← 密钥扫描（工作区 + **完整 git 历史**）+ 日志脱敏核查；
│   │                                     自证样本**拼接构造**以免扫到自身源码（自污染）
│   │   └── services/                   ← ⭐ 跨模块共用服务（注册在 `@Global` 的 `CommonModule` 并 `exports`，
│   │       │                             各业务模块**无需 import** 即可注入 —— 见 `common.module.ts` 头注）
│   │       ├── leader-money.service.ts ← ⭐⭐ M4-4 **团长余额唯一真源**（`ab_balance`；`ab_team_leader`
│   │       │                             `.balance` / `pending_amount` / `withdrawn_amount` 三列转历史字段）
│   │       │                             —— L19 佣金流水与 U14 余额明细**共用 `logsOf()`**，防「两个余额」分叉
│   │       └── leader-lookup.service.ts ← ⭐ M5-11「邀请码 → 团长」的**全仓唯一实现**（缺陷 #92 修复载体）：
│   │                                     `LEADER_CODE_RE` + `parseLeaderCode()`（**纯函数 · 不碰 IO · 不抛错**）
│   │                                     + `byCode()` / `requireActiveByCode()`（后者无效/停职 → `30007`）。
│   │                                     此前 `MealService` 与 `OrderService` **各抄一份正则**、`AuthService`
│   │                                     **压根没有**（那才是 #92）；三处此后只保留「无效时怎么办」的策略差异
│   ├── config/
│   │   ├── config.module.ts
│   │   ├── database.config.ts
│   │   ├── redis.config.ts
│   │   ├── wechat.config.ts            ← 微信支付 / 小程序 / 订阅消息配置
│   │   └── app.config.ts
│   ├── database/
│   │   ├── database.module.ts
│   │   ├── data-source.ts              ← TypeORM data source（`synchronize: driver === 'sqlite'`）
│   │   ├── schema-parity.ts            ← ⭐ M5-2「迁移推演 ≡ 实体真库」机械对账（`gate.mjs` 门禁 `schema:parity`）
│   │   ├── index-parity.ts             ← ⭐ M5-6「迁移索引 ≡ 实体索引」机械对账（门禁 `index:parity`）—— 补 `schema:parity` 自述的**不比索引**边界（比索引名 + 列有序 + 唯一性）
│   │   ├── migrations/                 ← 数据库迁移（**三支合并推演才等于实体结构**）
│   │   │   ├── 1700000000000-init.ts           25 张表（基础结构）
│   │   │   ├── 1700000000001-parity-fix.ts     ⭐ M5-2 补 2 表 + 9 列 + 1 索引（#76 修复载体，幂等可重入）
│   │   │   └── 1700000000002-index-commission-meal.ts  ⭐ M5-6 补 `ab_commission` 的 `idx_commission_meal`（`meal_date` 打头查询的索引缺口，幂等可重入）
│   │   └── seeds/                      ← 种子数据（¥25.80 / 4 级佣金 / 4 集散中心 / 12 楼）
│   │       ├── seed.ts                 ←     基础主数据（**一张订单都没有** · e2e 前置）
│   │       └── seed-demo.ts            ← ⭐ M5-9 演示/边界层（34 单 · 11 态 · 资金账本 · 13 项自检；
│   │                                     ⑬ = M5-11 补「演示单号过读取侧校验」，单号前缀 `AB0000` 见 #93）
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
│   │   │   ├── order-state-audit.ts    ← 【M5-7 增 · M5-8 收紧】⭐ **状态机声明 ↔ 生产写入点**机械对账（`gate.mjs` 门禁 `state:audit`）—— 抓「声明了迁移目标但全仓零写入」这类**不报错的 P0**（#79）；判据：①声明为迁移目标的状态必须有写入点（未实装走**显式豁免表**）②写入的状态必须在状态机内登记 ③豁免自收紧 ④**不可达态必须显式登记**（`ORDER_RESERVED_STATUSES`）；⭐ M5-8 起**豁免归零**（`cooked`/`delivering`/`delivered` 已实装、`refunding` 那条不可达边已删）；三重自证 + 5/5 反证探针
│   │   │   └── dto/
│   │   ├── delivery/                   ← 配送单（**M5-1 实装**：D61 列表 + D62 人工修正 · 收口 #61；**M5-8 增** D63 状态推进 · 收口 #79）
│   │   │   ├── delivery.module.ts
│   │   │   ├── delivery.controller.ts  ← D61 `GET /admin/deliveries` · D62 `PUT /admin/deliveries/{id}` · **D63 `PATCH /admin/deliveries/{id}/status`**（类级含 operator，不含 viewer）
│   │   │   ├── delivery.service.ts     ← 份数对比与 4.3 跑批**共用** `aggregateOrderQuantity()`；`version` 乐观锁（30016/30017）；⭐ **T8/T9 的唯一写入点** —— `advanceStatus()` 推进配送单并**联动订单**（`en_route` → `cooked→delivering` / `arrived` → `delivering→delivered`），两段迁移**各写一个具名方法**（可静态对账，见 `state:audit`）；四道闸门 30017/30016/30018/CAS，闸门③ **单向且单步**（跳级会跳过 T8 ⇒ 静默卡死，故 `allowed` 只含紧邻下一态）
│   │   │   └── dto/                    ← `DeliveryStatusAdvanceDto`（D63：`to` + `version` + 可选 `note`；**不传 `from`** —— 防过期快照由 `version` 承担）
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
│   │   │   ├── supplier-share.service.ts ← 供应商应付结算（按协商供价 + 费用项；**日结**：T+1 生成应付，财务按日付款 · C11）
│   │   │   ├── refund.service.ts       ← 退款三段式（申请 → 审批 → 实退 · C6）
│   │   │   ├── reversal.service.ts     ← 反向冲减（已结算后退款回退）
│   │   │   ├── reconciliation.service.ts ← 对账
│   │   │   ├── withdraw.service.ts     ← 提现申请与审批（申请 → 审批 → 生成打款批次）
│   │   │   ├── payout.service.ts       ← 佣金出款批次（**C11**：灵活用工平台代发 + 个税代扣；一期清单导出 + 回执登记）
│   │   │   └── dto/
│   │   ├── message/                    ← 消息推送（M3-12 投递侧 + M4-3 订阅侧）
│   │   │   ├── message.module.ts
│   │   │   ├── message.service.ts      ← 投递口 `notify()`（不抛异常，问题收敛进出参）
│   │   │   ├── message.controller.ts   ← U18 订阅授权清单
│   │   │   └── message-subscribe.service.ts ← 可授权模板的四条件过滤（M4-3）
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
│   ├── queues.backend → common/queue/  ← ⚠️ 实际落点在 `src/common/queue/`（随 CommonModule 全局可用）：
│   │   ├── queue.service.ts            ← 统一入队口（`enqueue` / `register`）
│   │   ├── queue.types.ts              ← 处理器契约（**抛错 = 需要重试**，自行判断可终止任务）
│   │   ├── memory.queue.backend.ts     ← 进程内驱动（e2e / 本地 · **durable=false 如实上报**）
│   │   └── redis.queue.backend.ts      ← BullMQ 驱动（生产 · 连不上**拒绝启动**，fail-closed）
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
│   ├── queues/                         ← 消息队列消费者（MVP 用 Redis + BullMQ · M4-3 实装）
│   │   ├── queues.module.ts
│   │   ├── queue-payloads.ts           ← 三个队列的**载荷契约**（单一真相）
│   │   ├── queue-admin.controller.ts   ← Q1 GET /admin/queue 运行态可见性
│   │   ├── order-paid.consumer.ts      ← 薄适配层：注册 + 转发，业务逻辑仍在原服务
│   │   ├── refund-apply.consumer.ts    ← → RefundService.attemptWxRefund（失败注入点见 mock provider）
│   │   └── settle-orders.consumer.ts   ← → CommissionService.notifySettled（**按团长逐条**载荷）
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
│   │   ├── delivery-status.ts          ← 配送单履约状态（**M5-1** 收敛：原在 `leader-order.service` 与 `workbench.service` 各写一份）
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

### 6.1 生产编排 `docker-compose.prod.yml`（M5-0 新增）

> ⚠️ **与上面那份是两套东西**，服务集不同、暴露面不同。混用会出现「以为在部署生产、其实起的是本地依赖」。

| 服务 | 镜像来源 | 暴露宿主端口 | 说明 |
| --- | --- | --- | --- |
| `mysql` | `mysql:8.0` | **否** | 仅 compose 内网；`TZ=Asia/Shanghai` + `--default-time-zone=+08:00` |
| `redis` | `redis:7-alpine` | **否** | 仅 compose 内网（队列驱动） |
| `api` | `apps/api-server/Dockerfile` | **否**（经 admin 反代） | `init: true`（配套 `enableShutdownHooks`）· `depends_on: healthy` · 非 root · `HEALTHCHECK` 打 `/health` |
| `admin` | `apps/admin-web/Dockerfile` | **是（唯一对外）** | nginx 静态站 + `/api`、`/static` 反代 + SPA fallback |

- 密钥一律走 `.env.prod`（**不入库**，见 `.gitignore`）；`${MYSQL_ROOT_PASSWORD:?}` 缺值即 **compose 拒绝启动**（fail-fast，不静默用默认密码）
- 两应用镜像**构建上下文 = 仓库根**（pnpm workspace monorepo，`--frozen-lockfile` 保可复现）
- 构建时注入 `APP_VERSION` → 探针 `/health/ready` 回显（灰度 / 回滚判据）
- ⚠️ 本机**无 Docker**，以上**未真机执行**；详见《部署运维手册 v1.0》§遗留风险（R1）

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
| **P39** | **加工场所打包**（**M4-0b** 由供应商端整体迁入 · 原判据随「供应商类型」停用失效，且数据面跨供应商） | M21-03 | `views/supplier/packing-center.vue` |
| **—** | **配送单管理**（**M5-1** 新增 · **原型无对应页**，故不编造型号） | D61 / D62 | `views/order/delivery.vue` |
| **—** | **通知模板**（**M3-12** 实装 · 原型无对应页；⚠️ **M5-12 补登** —— 该页自 M3-12 起服务端就授权了、路由也在，**却一直没进 `ADMIN_NAV`**：侧边栏点不到、只能手输 URL，属「授权了却没入口」那一类，与 M3-14 修过的 `/finance/*` 五页同族） | D59 / D60 | `views/system/message-template.vue` |
| **—** | **跑批时刻表**（**M5-12** 新增 · 原型无对应页，故不编造型号） | D64 / D65 | `views/system/schedule.vue` + `api/schedule.ts` |

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
| **v2.0.5** | 2026-09-17 | **M5-0 部署运维基座落点登记**：§一 根目录新增 `docker-compose.prod.yml` / `.dockerignore`，`apps/admin-web/{Dockerfile,nginx.conf}` 与 `apps/api-server/Dockerfile` 标注为 M5-0 产物；§一 `scripts/` **按实际文件重写**（原列的 `db-migrate.sh` / `db-seed.sh` 从未存在 —— 迁移与种子走 `package.json` script + `gate.mjs`，属**目录文档与仓库不一致**，本次对齐），补入 `gate.mjs` / `e2e-m1,2,3.mjs` / `lib/e2e-server.mjs` / `sync-docs.mjs` / 五个运维脚本；§一 `docs/` 把《部署运维手册 v1.0》由「待产出」改为**已产出**，并补《自营结算口径定义 v1.0》；**新增 §6.1** 生产编排四服务表（暴露面 / 密钥纪律 / 构建上下文 / `APP_VERSION` 注入），并明写「与本地 compose 是两套东西」；⚠️ 同步标注 M5-0 镜像与脚本**未真机执行过** |
| **v2.0.6** | 2026-09-17 | **M5-1 配送单人工修正落点登记**：§四 `modules/delivery/` 由「占位两行」改为**带接口说明的实装**（D61 `GET /admin/deliveries` · D62 `PUT /admin/deliveries/{id}` · 份数对比与 4.3 跑批共用 `aggregateOrderQuantity()` · `version` 乐观锁）；§三 `admin-web` 补 `views/order/delivery.vue` 与 `api/delivery.ts` 注释；§五 `enums/` 补 `delivery-status.ts`（**收敛**原两处逐字重复的状态映射）；§十 新增 **§10.3 两行** —— P39「加工场所打包」（M4-0b 迁入，服务端早已实装但**本表从未登记**，本次补齐）+ 配送单管理（M5-1 新增 · **原型无对应页**，故 `page` 记 `—` 不编造型号）。⚠️ 本表自 v2.0.4 之后的 M4-0…M4-4 各批次**未逐批登记**（本次只补与 M5-1 直接相关的落点，其余仍缺）。⚠️ **同时更正 v2.0.5 的一处事实错误**：`scripts/db-migrate.sh` / `db-seed.sh` **确实存在于仓库**（`git log --diff-filter=A` 指向仓库重建提交 `0e9552e`），当时写成「从未存在」不准确 —— 准确说法是「这两个脚本只是 `pnpm --filter api-server db:migrate|db:seed` 的**薄包装**（各 5 行），而本机 pnpm 不可用，**实际迁移与种子走 `gate.mjs`**」；§一 清单已补回这两个脚本并就地标注 |
| **v2.0.7** | 2026-09-17 | **M5-2 迁移补齐与结构对账工具落点登记**：§四 `database/` 补 **`schema-parity.ts`**（迁移推演 ↔ 实体真库机械对账，`gate.mjs` 门禁名 `schema:parity`）并把 `migrations/` 登记为**两支** —— `1700000000000-init.ts`（25 张表）+ **`1700000000001-parity-fix.ts`**（M5-2 补 2 表 + 9 列 + 1 索引，《缺陷与陷阱》#76 的修复载体 · 幂等可重入），并就地标注 ⚠️ **「两支合并推演才等于实体结构」**（单看 init 会少 2 表 9 列，是刻意的）；§一 `gate.mjs` 由「15 道」改为「**16 道**」（增 `schema:parity`）。⚠️ 本表仍有 M4-0…M4-4 各批次**未逐批登记**的历史欠账 |
| **v2.0.8** | 2026-09-17 | **M5-3 试运营交付 / 安全自检 / #49 时刻接线落点登记**：§四 `common/utils/` 补 **`tz.ts`**（全项目统一时区常量，时间轴与调度声明表共用，避免两处各写一份）+ **`order-timeline.ts`**（⭐ **业务时刻的唯一真相** `DEFAULT_TIMELINE` 9 时刻 —— 跑批 cron 与下单窗口锚点**都是它的派生值**）；新增 **`common/security/`**（`route-audit.ts` 越权全量机械对账 · `security-scan.ts` 密钥 + 日志脱敏扫描，两支并入 `gate.mjs` 门禁）；`tasks/` 补 **`schedule.registrar.ts`**（cron **运行时注册 + 订阅时间轴变更热重载**）并就地标注 ⚠️「**8 个任务类均已不含 `@Cron`**」—— 装饰器参数在模块加载时求值一次即成静态元数据，这正是 #49「配了不生效」的**机制性根因**；§一 `gate.mjs` 由「**16 道**」改为「**18 道**」（增 `route:audit` / `security:scan`）。⚠️ 本表仍有 M4-0…M4-4 各批次**未逐批登记**的历史欠账 |
| **v2.0.9** | 2026-09-17 | **本地内部测试工具落点登记（云服务器就绪前的内部测试入口）**：§一 `scripts/` 补 **`local-test.mjs`**（一键起「API + 用户端 H5 + 运营后台」并打印**手机扫码地址**；开关 `--seed` / `--build` / `--smoke` / `--clock` / `--only`）+ **`lib/local-server.mjs`**（静态托管 + `/api` **同源反向代理**）+ **`lib/local-smoke.mjs`**（**11 项**端到端自检）。三处刻意设计与理由已就地标注：① 自检走**端上那条路**（页面 → 同源代理 → 后端）而**非直连后端** —— 直连只能证明「后端活着」，证明不了「手机打开能登录取数」；② 用户端 H5 必须以**相对路径**构建（`VITE_API_BASE_URL=/api/v1`），写成固定局域网 IP 则换网络环境后全部请求失败；③ 默认注入 `ABOX_SHIFT_TO_HOUR=20`，否则 `isOrderable` 窗口每天只开 9 小时，内部测试大部分时段**连单都下不了**。§一 同步补记《本地开发手册》由此新增 **§9.3 云服务器就绪前的内部测试**；`.gitignore` 补 `dist-h5/` —— 用户端 H5 产物**刻意不落在 `dist/`**（那里归 `build:mp` 所有，构建前整个改名挪走 → 跑一次门禁就把手机测试环境清掉，表现为「昨天还能开、今天说缺产物」）。⚠️ 本表仍有 M4-0…M4-4 各批次**未逐批登记**的历史欠账 |
| **v2.0.10** | 2026-09-17 | **M5-6 全面检查报告五项「本地可完成」修复落点登记**（零 DDL 之外的 1 支增量迁移 · 零新增错误码）：§四 `database/` 补 **`index-parity.ts`**（迁移索引 ≡ 实体索引机械对账，`gate.mjs` 门禁名 `index:parity`）—— 补 `schema-parity.ts` **自述的「不比索引」边界**（比索引名 + 列**有序** + 唯一性，且自带自证）；⚠️ 它首跑即报出 **25 处「实体写属性级单列 / 迁移写类级复合」漂移** —— 两边**各自都自洽**，任何既有门禁都看不出（本地与生产跑的是两套索引）· `migrations/` 由**两支**改登记为**三支**：+ **`1700000000002-index-commission-meal.ts`**（补 `ab_commission` 的 `idx_commission_meal (meal_date)` —— 该表**永续增长**，3 处 `meal_date` 打头查询此前只能全表扫；`information_schema` 守卫幂等可重入）· §一 `gate.mjs` 由「**18 道**」改为「**19 道**」（增 `index:parity`）· ⭐ §四 `common/middleware/rate-limit.middleware.ts` 由**空占位改实装**（收口报告 §二 P2-7：`10005` 从「有码无实现」到真生效）：**固定窗口** + **IP/账号双维度** + **复用同一个 `AllExceptionsFilter`** 产出 429（不手写第二套响应形状 = 不制造第二种 429 形状）；⚠️ 注册点**必须**是 `AppModule.configure()` —— `app.use()` 放在 `await app.init()` 之前（body 未解析 → 账号维度静默失效）或之后（**排在路由之后 → 一次都不执行**）**都不行**，见《缺陷与陷阱》#78；⭐ 阈值按本业务主场景「**一栋办公楼共用 NAT 出口**」定（IP 10/分 · 账号 5/分）并**刻意不设全局写兜底**（一刀切会把整栋楼的写操作一起打掉）；测试开关 `ABOX_RATE_LIMIT` 生产**硬忽略**（同 `ABOX_SHIFT_TO_HOUR` 范式）· ⚠️ `scripts/e2e-m3.mjs` 增 **§33 退款执行闸门**（同一订单两张 `applying` 退款单 → 恰好一次执行 + 余额流水恰好 1 条；**如实标注它不是并发测试**，并发项挂账见《缺陷与陷阱》#77）与 **§34 限流**（**另起一台真开限流的实例**做真实 HTTP 断言，双维度 + 响应体形状 + `/health` 跳过）—— e2e 主线套件因一轮要打 **54 次 `admin-login`** 而默认 `ABOX_RATE_LIMIT=off`（否则会被自己的防护打成 429）· ⭐ 25 个空壳文件补「**真实实现在哪**」弃用头注释（§二 P2-8） |
| **v2.0.11** | 2026-09-18 | **M5-7 整体审查可修项落点登记（资金链并发收口 + 安全默认值 + 口径收敛 · 零 DDL · 门禁 19 → 20 道）**：§四 `modules/order/` 补 **`order-state-audit.ts`**（⭐ **状态机声明 ↔ 生产写入点**机械对账，`gate.mjs` 门禁名 `state:audit`）—— 它是 **P0 缺陷 #79**（`cooked`/`delivering`/`delivered` 三态**全仓零写入点**，而当时 **19 道门禁 + e2e 969 条全绿、一条都没红**）的防复发门禁：判据 **①声明为迁移目标的状态必须有写入点**（未实装走**显式豁免表**，条目带理由 + 账本引用）**②写入的状态必须在状态机内登记**（防 #67 类字面量写错）**③豁免自收紧**（被实现后门禁会要求删除豁免，不允许它腐烂）；自带三重自证 + **反证测试**（删掉 `delivering` 豁免必红并点名 / 塞 `'ghost_state'` 必红）。⚠️ 它**只做状态级、不做迁移边级**校验（边级需把写入语句与 `WHERE status=?` 守卫静态配对，守卫形态多变必然误报），无法静态判定的写入点**显式列为待人工确认**而非静默跳过；⭐ 首跑即报出**一处此前未登记的漂移**：`ORDER_TRANSITIONS[refund_applying]` 仍声明 `→ refunding`，而 M4-3 起**订单**不再进入该态（通道进度改由 `ab_refund.status` 表达）—— 属**声明表 ↔ 实现的口径漂移**，已登记待裁决 · §四 `modules/finance/` **四处资金闸门收口**：`refund.service.ts` 在 `settleRefundDb` 入口**原子占住订单**（`UPDATE … WHERE id = ? AND status IN (…)`，以 `affected` 判归属，**一处占位同时守住余额/佣金/通道三段**）、`approveByAdmin` 改为**带条件的 UPDATE 落审批**（旧写法是 `findOne` 判状态后 `save` 全列覆盖 —— MySQL REPEATABLE READ 下并发第二次可能读到快照旧值 → 双退）；`reversal.service.ts` 余额退回与佣金冲销扣款各加 `version` 乐观锁、**无余额账户由静默 `return 0` 改 fail-closed**（`40019`）；`commission.service.ts` 佣金入账加乐观锁（`40018`，整批回滚 —— 结算可重入，重跑即可补齐） · `common/constants/error-code.ts` 新增 **`40018 BALANCE_CONCURRENT_MODIFIED`** / **`40019 BALANCE_ACCOUNT_MISSING`**（本次唯一新增错误码） · ⭐ **后台幂等链路补齐**（#80 的另一半）：`admin-web/src/api/request.ts` 请求层**兜底注入 `Idempotency-Key`**（方法 + 地址 + params + body + 60s 时间窗指纹 · FNV-1a · **显式传键优先**）+ `finance-admin.controller.ts` 4 个提现端点与佣金补跑、`order-admin.controller.ts` 两个写端点、`refund-admin.controller.ts` 审批/驳回补 `@Idempotent({ required: false })`（这些端点**已有状态机闸门**，幂等键是**第二层**，故不强制请求头 —— 否则 curl/集成方一律撞 `10001`） · ⭐ **安全默认值 fail-fast**（#83）：`main.ts` 启动期 `assertProdSecrets()`（生产缺 `JWT_SECRET` 即 `exit(1)`，禁止任何默认值）+ 基础安全响应头（`nosniff` / `X-Frame-Options` / `Referrer-Policy`；**刻意不装 helmet** —— 本机无 pnpm，为三个头引入依赖链不划算）+ `app.disable('x-powered-by')` + **CORS 白名单**（`CORS_ORIGINS` 未配时：非生产放行 / **生产拒绝**）；`storage.config.ts` / `app.config.ts` 的危险兜底值就地标注 `security-scan:allow`（带理由，可审计）；`common/security/security-scan.ts` **新增「敏感配置的危险默认值」规则**并把**占位符豁免按位置收窄到「仅注释内」**、支持**紧邻上一行**的显式豁免标记（⚠️ 实测教训：豁免标记**必须紧邻**，prettier 折行后写在注释块首行会**失效**） · §四 `database/seeds/seed.ts` 由单点 `NODE_ENV` 防护改为**双守卫**（`NODE_ENV=production` 拒跑 + 要求 `ABOX_SEED_CONFIRM=1` —— 它会清空 **27** 张表，一道防线太薄；`gate.mjs` 的 `seed` 门禁已注入该变量） · `tasks/schedule.registrar.ts` **接线 `TASKS_ENABLED` 死配置**（关闭时**先无条件摘掉旧注册**再返回，否则「设了没用」） · §三 `admin-web/src/constants/index.ts` 的售价/佣金率改为**引用 `@abox/shared-utils` 的 `BIZ`**（消灭后台与服务端**两套口径**，#12 / 同族 #63「两个真相」） · ⚠️ `scripts/e2e-m3.mjs` 增 **§33b**（幂等键二次提交 → `10006` + **回放首次结果** + 换键放行；`ab_balance.version` **恰好 +1** —— 证明乐观锁那条带条件的 UPDATE 真的执行了；无账户 → `40019` 且**事务整体回滚**，订单与退款单原状；夹具还原**连 `version` 一起还原**），m3 断言 **969 → 980**；⚠️ 该节编号**贴在 §33 之后而不重排 §34** —— `§34 限流`必须最后（它会停掉主线实例另起一台开启限流的服务），且账本 #78 以「§34」指代该节 |
| **v2.0.12** | 2026-09-18 | **M5-8 履约链 T7/T8/T9 补实现（收口 P0 缺陷 #79 · 零 DDL · 门禁仍 20 道）**：§四 `modules/delivery/` 补 **D63 `PATCH /admin/deliveries/{id}/status`**（`delivery.controller.ts` / `delivery.service.ts` / `dto/`）—— ⭐⭐ 它是 **T8/T9 的唯一写入点**：`ab_order` 的 `cooked`/`delivering`/`delivered` 三态此前**全仓零写入点**（订单支付后永远停在 `cut_off`、团长「确认取餐」永远返回零值**且不报错**、**佣金永不产生**、自动确认跑批每天把全部订单报成「履约异常」），而当时 **19 道门禁 + 969 条 e2e 全绿**；`advanceStatus()` 推进配送单并**联动订单**（`en_route` → `cooked→delivering` / `arrived` → `delivering→delivered` + 写 `actual_at`），**两段迁移各写一个具名方法**（`set({status: to})` 更短，但那样写入点在 `state:audit` 静态扫描下判不出来 = 亲手把 #79 的盲区重开）；四道闸门 30017 / 30016 / 30018 / CAS，闸门③ **单向且单步**（⭐ 实现自查出的**第二处漂移**：注释与文档都写「跳级一律拒」，而 `slice(fromIdx+1)` 实际放行 —— 跳级会**跳过 T8**，T9 的条件更新是 `delivering → delivered`，订单还在 `cooked` ⇒ **一单不动且不报错**，正是 #79 的形状；已改为 `allowed` 只含紧邻下一态并补 e2e 断言）· T7 写入点在 `modules/supplier/supplier.service.ts` 的 `advanceOrdersToCooked`（出餐确认**同事务**联动，出参 `orderAdvance` 明说该副作用）· §四 `modules/order/order-state-machine.ts` **删掉那条躺了三个批次的不可达边** `refund_applying → refunding`（M4-3 起订单审批通过**一步到 `refunded`**，通道进度交 `ab_refund.status`），并新增 `ORDER_INITIAL_STATUS` / `ORDER_RESERVED_STATUSES` 两个**可机械读取的声明**，供门禁区分「合法起点」与「漂移残骸」 · §四 `order-state-audit.ts` **豁免归零** + 新增规则④「不可达态必须显式登记」· ⭐ §三 `admin-web` 配送页补 **D63 入口**（每行「推进到 X」按钮 + 确认弹窗 + 「订单进度」列，`cut_off` 高亮警示「出餐未确认」）—— **只有接口没有入口 = 能力存在但无人能到达**（与 #79 同族）；状态顺序与中文名**全部取自服务端 `statusOptions`**· `common/constants/error-code.ts` 新增 **`30018 DELIVERY_STATUS_ILLEGAL`**（带 `data.allowed`；**刻意不复用 30016** —— 一个是「刷新重提即可」，一个是「这个动作本身不该发生」）· ⚠️ `scripts/e2e-m3.mjs` 增 **§35 · 27 条断言 · 履约全链路**（U6 下单 → mock 支付 → 截单补跑 → 配送单生成 → 出餐确认 T7 → D63 已叫车 → 配送中 T8 → 已送达 T9 → 自动确认 T11 → 佣金入账 4.5），**除「其余三家供应商已送达」一处夹具外，订单每次状态变化都来自真实 HTTP**—— 依据 #79 的处置判据「凡是用「直插某状态」造数据的套件，都必须额外有一条走完整链路的用例」；m3 断言 **980 → 1007** · ⚠️ 本表 M4-0…M4-4 各批次**未逐批登记**的历史欠账仍未清 |

| **v2.0.20** | 2026-09-18 | **M5-12 运维与门禁类待办清理（#173）—— 日巡检进 cron · 三处时刻黑盒对账 · 跑批时刻表页面 · 多实例前提如实标注（纯工具链 + 一个后台页面 · 零 DDL · 零新增错误码 · 门禁仍 20 道 · 表数仍 27）**：① §一 **新增 `deploy/cron/abox-ops.cron`** —— 「服务器周期性运维动作」的**唯一真相**（05:00 备份 / 08:30 巡检；时刻的定法写在文件头：备份要等 04:00 对账跑完、巡检要等人上班前出结论）；⚠️ 它是**模板**（含 `{{ABOX_REPO}}` / `{{ABOX_LOG_DIR}}`），必须经安装器渲染；② §一 `scripts/` 新增 **`ops-daily.sh`** —— 把**三件互不相干但都属于「昨天到底成不成」**的事收成**一个退出码**（0 通过含 WARN / 1 有 FAIL / 2 用法环境错）：探针**两级**（进程活着 ≠ 依赖通、消费者齐）· 备份**新鲜度**（判**产物的年龄**而不是「备份脚本有没有报错」—— cron 只看退出码，「文件其实没写出来」在退出码上看不出来；另单拦**空导出**：文件在、时间新、大小 0，到恢复那天才知道是空的）· 磁盘**可用百分比**（固定 MB 阈值在 40G 盘恒过、100G 盘恒红，两种都等于没检查）。⭐ 探针**委托** `healthcheck.sh`（不重写第二套探测逻辑）；⭐ 实测踩到并修掉一处**代理陷阱**：`curl` 默认尊重 `http_proxy`，于是「探测 `127.0.0.1`」实际打到了代理上、拿回 `502 upstream connect failed` —— 与「本机服务真挂了」**长得一模一样**（若走进巡检，它会每天报「服务不可用」而服务一直是好的，把人训练成忽略告警）；已在探测子进程**显式清掉 `http_proxy`/`https_proxy`/`ALL_PROXY`** 并写明理由；⚠️ **不改 `healthcheck.sh`**（它也可能被用来探网关侧外网域名，那里代理可能是需要的 —— 「探针不许过代理」是本巡检的判据，由本脚本承担）；③ §一 `scripts/` 新增 **`install-cron.sh`** —— 幂等安装器，只做「读模板 → 替换占位符 → **标记块替换**」三件事。⭐ 内容与**标记行都从模板取**（自己一行都不生成 —— 硬编码标记会让「模板改了标记、安装器没改」表现为**旧块删不掉**，而重复的 cron **不会报错**，只表现为磁盘莫名涨得快）；⭐ **拒绝写入任何还残留 `{{…}}` 的内容**（crontab 会原样接受语法错误的命令行并每天定时执行它，表现为「cron 什么都没干」而 `crontab -l` 完全正常）；⭐ 读 crontab 一律走**变量 + `case` 匹配**而不是 `cmd | grep -q`（后者命中即退出会让上游收 SIGPIPE，配 `set -o pipefail` 把**成功变成失败**，即「装上了却报错」）；④ §三 + §十 新增 **`views/system/schedule.vue` + `api/schedule.ts`** —— **跑批时刻表**页（8 任务 × 出厂 cron / **实际注册 cron** / 生效时刻 / 目标日语义 / 实装状态 + 手动补跑）。为什么它是必要的：`GET /admin/schedule` 自 M4-1 就有、**一直没有页面**，于是两类故障没有出口 —— 「某个任务没注册上」（`registeredCron` 为 `null` ⇒ 该任务**永远不会跑且不报任何错**，e2e 全走补跑接口也发现不了）与「跑批没跑成、今天要补一次」（补跑口存在但没人知道它存在）；⭐ 端上**不复刻任何服务端规则**（`24:00` 不折算、日期语义用服务端下发的 `dateKindLabel`），「是否被配置覆写」只用 `registeredCron !== cron` 这个**纯字符串比较**；⚠️ 顺带修一处**同族真缺口**：**`/system/message-template`（通知模板）自 M3-12 起服务端就授权、路由也在，却一直没进 `ADMIN_NAV`** —— 侧边栏点不到、只能手输 URL（与 M3-14 修过的 `/finance/*` 五页同族：**授权了就必须有入口**），本批补登；⑤ 《部署运维手册》升 **v1.0.2**：新增 §7.6（cron 安装与三个检查的判据）· §7.2 补「已有跑批时刻表页」· §十 日巡检首项改为 `ops-daily.sh` 退出码；新增遗留风险 **R10（⭐ 一期只允许一个 API 实例 —— `currentTimeline()` 是**进程级单例**，多实例会造出「A 实例已按新截单时刻拒单、B 实例还按旧时刻放行」，**两边都不报错**；广播修复需 Redis 传输层 → 属外部条件，本期**不实装**，改为把「不许横向扩容」写成部署前提并给出接法与验收方式）** 与 **R11（运维脚本与 cron 从未真机执行）**；⑥ ⚠️ **未在真机执行过**（同 R1/R11）：只做 `bash -n` + `--dry-run` 渲染验证 + **两条分支的实测**（探针 200 → 退出 0 · 探针不可达 → 退出 1 · 新鲜备份 → OK · 1 字节备份 → FAIL · 用法错 → 2）—— 一个监控脚本的全部价值在于**它能不能红**，故正反两条都跑过；⑦ 《模拟数据与回归测试结果》登记 e2e **m3 1007 → 1017**（**§36 三处时刻黑盒机械对账 · 10 条断言**）：用 `GET /admin/schedule` 与 `GET /admin/system/configs` 的**出参互推**（§22 已做过点检，本节补**全量 + 双向**）—— 正向：写进配置的值 ⇒ 对应任务的 `effectiveAt` 与 `registeredCron` 同时到位；**反向：时刻表里偏离出厂值的任务集合，必须恰好等于「被覆写的配置键所对应的任务」**（少了 = 配置没接上；**多了 = 存在第二个写入点**，那才是 #49 漂移的真形态，也是本节唯一能抓住它的地方）；另有「不可配时刻的反证」（4 个纯内部节奏任务在配置全被改掉时仍等于出厂值 → 若有人把 `TIMELINE_CONFIG_KEYS` 扩到全部 9 个时刻，它会红）与「送达时刻在时刻表上不留任何一行」（映射表里显式 `null`，让「配了 5 项、只动了 4 项」有一个写在断言里的解释）；⭐ 本节先**归一**再断言、末**复原并断言复原**（否则下一次重跑会跑在被污染的时刻下，而症状是「其它节偶发红」，因果关系极难建立）；⚠️ 仍**未收口**：`currentTimeline()` 多实例广播（R10）· 新旧三处时刻的**跨文档机械对账门禁** |
| **v2.0.19** | 2026-09-18 | **M5-11 三处挂账缺陷收口（#92 / #93 / #94 · 零 DDL · 零新增错误码 · 门禁仍 20 道 · 表数仍 27；**不是新功能**，是把三个「门槛内但一直没做」的挂账缺陷补上）**：① **#92 邀请码绑定链路两端补实装** —— 新建 `common/services/leader-lookup.service.ts`（注册在 `@Global` 的 `CommonModule` 并 `exports`）收口「邀请码 → 团长」的**三份各自独立的实现**（`MealService` / `OrderService` **各抄一份正则**、`AuthService` 则**压根没有** —— 那才是 #92 本体）；`AuthService.login` 新增 `bindInvite()`，`LoginDto.inviteCode` 从**死字段**变成真读点（码无效/停职 → `30007` 使整趟登录显式失败，端上 `bindLeaderByInvite` 回落**不带码的普通登录**、不把人锁在门外；只 patch 缺失的 `teamLeaderId`/`buildingId`，**换团长不换楼** —— 改楼栋属 L15 后台审核事项）；`LeaderInviteService.bindOnInvite()` 幂等且**不覆盖邀请人**（邀请人是历史事实）；端上「登录 + 绑定」同一趟完成，P10 `join()` 改为真调服务端。⚠️ 顺带校正《接口规范》§1.5 一处**事实错误**（原写 `POST /auth/wx-login {leaderCode?}` —— **该路径与字段名都不存在**，真实契约是 `POST /auth/login {code, nickname?, avatarUrl?, inviteCode?}`，同族 #67/#79/#84「同一件事两份表述」）；并改正本条自身的两处错述（原写「`ab_user` 两列**全仓没有**生产写点」—— 实际「申请团长」「后台任命」两条路径**有**写点，缺的只是**扫码路径**）。② **#93 演示单号前缀 `ABDEMO` → `AB0000`** —— 原前缀含字母、长度 14，不满足**自家读取侧**校验 `^AB\d{16}$` → **端上点开任何演示订单都 `10001`**（P5 订单详情打不开、人工测试点历史订单全报错、极易误报成 bug）；新前缀取 **`AB` + 年份位 `0000`**（真实单号年份来自 `todayBj()`，**「0000 年」永不可能被生成** ⇒ 既不撞真实单号、又仍是清理键 `LIKE 'AB0000%'`）+ `MMDD` + **8 位序号**；清理键 / e2e 锚点 / 探针锚点**三处同批换**；两道护栏 = `seed:demo` 自检补第 **⑬** 条（**用生产函数 `isOrderNo()` 逐张验形，刻意不重抄正则 —— 重抄必漂移**）+ `tests/_probe-demo-data.mjs` 补「演示单号能过**读取侧**校验」6 条（**正证 + 反证成对**：D9 按单号打开 `code===0` / 旧格式 `ABDEMO…` 仍 `10001`，后者证明这道校验**确实在看单号**而非恒真）。⚠️ 提现 / 退款 / 余额调整三类单号**不受该正则约束**，故保留 `…DEMO` 语义前缀。③ **#94 L15 `mine.level` 改名拆分** —— 该字段是**按本月业绩反推的「应处等级」**（`resolveLevel()` 输出、晋级审计的输入），与 L11/L14 的**实际生效等级**（`ab_team_leader.level`）**同名不同义**：「首席但本月 7 单」同时命中 `chief` 与 `trainee`，两个值都「对」、只是语义不同（**编译器与类型系统都拦不住**，肉眼看字段名一样还会以为是同源）；出参改为 **`effectiveLevel` + `derivedLevel`**（**旧 `level` 删除、不留别名** —— 留别名等于让漂移回来），`nextLevel` / `progress` 由**服务端**按生效等级在阶梯上推导（`progress()` 加首参 `effectiveLevel`；非法值记 warn 并兜底 index 0，否则 `indexOf` 返回 `-1` 会被误读成「已达最高级」）—— **端上不再复刻阶梯与门槛**（`commission.vue` / `profile.vue` 删 `ladder` computed 与 `LEADER_LEVEL_META` 引用），`e2e-m2` L16 断言改写并**显式断言旧字段 `mine.level === undefined`**（防悄悄回退）。**验收**：`gate.mjs all verify` **20/20** · e2e m1 **45** / m2 **126** / m3 **1007**（与基线一致）· `seed:demo` 自检 **13/13** · 探针 **83/0** · 基线清单 **299/299**（+1 = 新增的 `leader-lookup.service.ts`；已做收尾机械比对，无整批漏登） |
| **v2.0.18** | 2026-09-18 | **M5-10 原型逐页对齐 · 批次三（P11–P20 · 团长端十页）**：十页按原型 renderP11–P20 全量重排 —— P11 团长工作台（状态战报卡按**真实配送状态**驱动，替代原型的客户端时刻猜测 + 等级金棕卡 + 四宫格）· P12 本楼概况（金棕大卡 + 订单类型分布 + 成员订餐；「未下单同事」口径需**楼栋成员名册**（无「应到人数」分母）未实装，如实以「下单人数 / 人均份数」替代并脚注说明）· P13 订单明细（汇总卡 + 行式成员列表 + 分段筛选）· P14 异常订单总览（原型为「本月历史汇总」，实装 L4 仅支持单日口径 → **如实降级为当日两段式**并脚注裁定）· P15 取餐确认（配送状态卡 + 四指标 + 分发提醒 + 成员列表；预计佣金 = 待分发实付 ×12% 端上可复算）· P16 佣金中心 · P17 佣金流水（恒等式口径卡）· P18 提现申请（居中大额 + 输入组 + 在途记录）· P19 分享中心 · P20 团长资料（折叠式账户设置）。⭐ **修一处同名不同义陷阱（缺陷 #94）**：L16 `mine.level` 是**按本月业绩反推的「应处等级」**，与 L11/L14 的**实际生效等级**（`ab_team_leader.level`）不是同一个东西 —— 首席团长本月只做 7 单会同时命中 `chief` 与 `trainee`；P16/P20 初版把 `mine.level` 当「我的等级」用，出现「同屏两个等级」，已改为：**等级展示一律取 L11/L14**，「下一级/进度」按生效等级在阶梯上的位置推导（阶梯顺序取自 L16 `levels[]` 出参顺序、门槛取 `shared-types` 的 `LEADER_LEVEL_META`，与服务端 `resolveLevel()` 同源），已达最高等级恒 100%（对齐原型「已达首席（最高等级）」），业绩测算与生效等级不一致时**如实脚注**而非隐藏。**纯前端排版批 · 零接口变更、零新增文件**；`pages.json` 标题校正 2 处（`本楼概况`→`我服务的办公楼` · `异常订单处理`→`异常订单总览`）。**验收**：CDP 390×844 原型↔实装并排截图十页全对齐（`_shots/reshot-batch3.sh` 可重跑；⚠️ 原型 PAGES 下标须按**数组元素**数 = 页码−2，按行号数会因数组内注释行错位 3 格）；`gate.mjs all verify` 20/20 |
| **v2.0.17** | 2026-09-18 | **M5-10 原型逐页对齐 · 批次二（P5 / P6 / P8 / P9 / P10 · 后端补 U13/U14 读侧）**：五页按原型重排/实装 —— P5 订单详情（状态渐变卡 + **6 步状态机时间线**（服务端 `buildTimeline` 下发）+ 订单号复制 + 套餐明细金额拆解 + 取餐方式）· P6 订单列表（分段筛选条带计数 · 4 并发取 `total` 失败不弹错）· P8 个人中心（头像卡多源统计：余额 U13 / 累计订单 U9 / 本月佣金+待分发 L10/L1 best-effort；团长横幅仅 `isLeader`）· P9 余额明细（余额渐变大卡 + 口径说明条 + 流水卡含全量合计行）· P10 团长邀请落地页（U3 免登录；「授权加入」**如实只记本地** —— 服务端绑定链路未实装，登记缺陷 #92）。⭐ **后端补 U13/U14**（`GET /me/balance` / `GET /me/balance/logs`）：规范 §3.5 早已登记、实现长期缺失，P8/P9 一直是占位页的根因；两支**复用 `LeaderMoneyService`**（新增 `logsOf()`，与 L19 共用同一实现，防「个人中心与余额明细显示两个余额」的 #69 形分叉）。⭐ **余额口径修正**：`ab_balance` 主键是 `user_id`，用户与团长**共用同一账户** —— 原型 P9「用户余额仅来自退款、团长佣金是独立账户」为**过时文案**；U13 的口径说明 `note` 由服务端下发正确措辞（「余额来自订单退款与团长佣金入账…不支持充值」），P9 **不做类型过滤**（否则大卡总额与流水对不上）；A2 补派生只读 `buildingName` / `leaderName`（**U12 裁定由 A2 承担、不另设端点**，防一份数据两个端点）。⭐ **修一处 UX 竞态**：`mine.vue` onShow 原本五个取数**并发**，而「本月佣金 / 待分发」以 `leaderStore.isLeader` 为闸门、该标志恰由并发的 `loadProfile()` 置位 → 冷启动必显「—」（横幅随后又出现，自相矛盾），改**先 `await loadProfile()` 再发其余**。新增文件：`common/constants/balance-log.ts`（余额流水文案单一真相，finance 与 user 两读侧共用）、`modules/user/dto/user-balance.dto.ts`；⚠️ 收尾机械比对抓出 `modules/user/user.controller.ts` **M2 起漏登** SCAFFOLD_KEY（「整批漏登而不报错」又一例），随本批补登 3 项。**验收**：CDP 390×844 原型↔实装并排截图五页全对齐；`gate.mjs all verify` **20/20**；登记缺陷 #92（邀请码绑定链路两端未实装）、#93（种子订单号 `ABDEMO…` 不满足自家 `^AB\d{16}$` 校验，端上点开演示订单必报错） |
| **v2.0.16** | 2026-09-18 | **M5-10 原型逐页对齐 · 批次一（P1 / P3 / P4 · 用户端下单主链路）**：**裁定：`prototype/index.html`（v4.10.0）为用户端 + 团长端 19 页（P1–P20）的逐页版式验收基准，分批对齐** —— 此前实装是「功能等价、版式自排」，用户实测「手机上跟原型长得不一样」。批次一改动：① `pages/index/index.vue`（P1）按 `renderP1` 全量重排 —— 深棕倒计时横幅（距截单 HH:MM:SS·金字）→ 米金渐变概念大卡（🍱 + 日期 + 「四方好味汇一盒/每家只出一道拿手菜」）→ 团长身份横幅（**L10 仅 `isLeader`** · 等级名取 `LEADER_LEVEL_META` · → 团长工作台）→ 跟随团长卡 → 无团长引导条（→ 申请团长）→ **一饭四菜逐道**（分类图标 🍛🍳🥦🍲 + 菜名含供应商 + 「来自：X ›」+ 主食行）→ 价格 + 份数 stepper（原型交互：**P1 选份数带入 P3**，`ORDER_MAX_QUANTITY=20`）→ 「立即预订 ¥合计」渐变大按钮；「往日这盒」（U2）是原型外既有验收点，**保留在页尾**。② `order-create/order-create.vue`（P3）按 `renderP3` 重排 —— **警示红**倒计时横幅 → 套餐清单卡（菜名 + 来自：供应商 + `N 份 × ¥25.80` 大字合计 + stepper 收进标题行）→ 取餐信息卡（跟随团长 · 明天 11:30 统一分发 · 💡联系团长）→ 支付方式卡 → 确认支付；⚠️ **备注输入保留**（原型「简化版」删了它，但 256 字备注是既有验收点）；onLoad 新增 `qty` 参数（P1 带入，非法回落 1）。③ `pay-result/pay-result.vue`（P4）按 `renderP4` 重排 —— 大 ✅ + 订单号 → 信息卡（金额/支付方式/截单时间/订单状态）；⚠️ 原型只画了成功态，实装**保留完整三态**（等待支付+重新支付 / 已取消 —— U7/U8 既有验收点）。④ `pages.json` 22 处 `navigationBarTitleText` 由开发用页码标签（`P1 · 首页（融合套餐详情）`）**换成原型产品名**（`明日套餐` 等 —— P 编号映射保留在页文件头注释与文档）。⭐ **对齐方法**：原型数据早就在接口里（`/home/daily` 的 `dishes[].supplierName` / `cutoffAt` / `leader{}` 全齐），**纯前端排版改造、零接口变更**；验证用 **CDP 手机参数渲染**（390×844·DPR3·移动 UA）逐页截图与原型并排比对，横向零溢出。**实测**：`typecheck:mp` / `lint` / `format` 全绿 · P1/P3 截图比对通过。**待办（批次二起）**：P4 手机截图验收 → P5/P6/P8/P9/P10 → P11–P20 团长端 10 页 |
| **v2.0.15** | 2026-09-18 | **M5-9 收尾二（手机端字体失真修复 · 纯前端资产 + 本地代理一处修正 · 零 DDL · 零错误码）**：测试人反馈「手机扫码后样式跟电脑截图不一样、失真严重」。⭐ **根因是字体，不是布局** —— 实装字体栈 `KaiTi, STKaiti, 楷体, 'Noto Serif SC', serif` **整条都是电脑字体**：手机（iOS/Android，含微信 WebView）**一个都没有** → 全部落空回退系统黑体，楷体的品牌观感在手机上完全消失；而开发者的截图都是**电脑渲染的**（Windows 自带 KaiTi），所以「截图好看、手机失真」。已用 Chrome DevTools 协议以**真手机参数**（390×844 · DPR3 · 移动 UA）实测确认：**横向零溢出**（rpx 缩放正常）、布局无恙，**唯一差异就是字体**。**修法**：① `scripts/make-font-subset.py` 从 Windows 自带 `simkai.ttf` 生成 **woff2 子集**（GB2312 一级汉字 3755 + ASCII + 常用中文标点 + 源码全部 CJK 字符 = **3907 字 / 583KB**，约为原字体 5%）；② `tokens.scss` 的 `$font-family-base` 头部插入 `@font-face 'ABoxKai'`（**H5 条件编译**，`font-display:swap`，静态目录 `/static/fonts/ab-kaiti.woff2`），小程序端不受影响（原生字体由微信侧处理）；③ ⭐ 顺带修掉 `lib/local-server.mjs` 一处**真缺陷**：`/static` 被整体代理给 API，**遮蔽了 uni-app 前端静态目录** —— uni 前端静态资产与 API 本地上传目录（`/static/dishes/…`）**同名撞前缀**，字体请求被代理后返回 `10004 接口不存在` 的 JSON；改为「**文件优先、代理兜底**」（`fileFirstProxyPrefixes`：dist 里有就直接给，没有的才透传），两边互不遮蔽。**实测**：字体经 5180 返回 `font/woff2` · `document.fonts` 显示 **`ABoxKai / loaded`** · 手机参数渲染横向零溢出；`format` / `lint` 全绿。⚠️ **遗留（生产前必办）**：simkai 是**微软授权字体**，内测没问题，**上线前须换开源可分发字体**（如霞鹜文楷 LXGW WenKai）重跑本脚本即可替换；H5 顶部导航标题仍是开发用页码标签「P1 · 首页（融合套餐详情）」（`pages.json` 的 `navigationBarTitleText`，微信小程序端也显示），是否改成产品名待裁决 |
| **v2.0.14** | 2026-09-18 | **M5-9 收尾（人工测试入口卡 + `local-test --build` 守卫修复 · 纯工具链 · 零 DDL · 零错误码 · 门禁仍 20 道）**：① §一 `scripts/` 新增 **`make-qr.mjs`** —— 把「本机 IP 是多少、四个入口在哪个端口、后台怎么进、用哪个账号」固化成**一页可打印可转发的《人工测试入口卡》**（用户端·团长端 5180 · 运营后台·供应商后台 5173 · 接口文档 + 健康检查 3000）：二维码用**内联 SVG**（**零外部资源 · 离线与打印都能显示**），另出 4 张 PNG 便于转发到群里；⭐ **生成后会反解校验**（`jimp` + `qrcode-reader` 把 PNG 解回来逐条比对 URL）—— 二维码**编错了肉眼看不出来**，而「端口或 IP 拼错」要到「测试人扫了打不开」才暴露，**编一遍解一遍是两条独立代码路径**，能真正兜住这类静默错误；⚠️ 端口默认值**必须与 `local-test.mjs` 一致**，漂移即「卡上的码扫不开」而没人知道为什么；⚠️ 交付物**刻意带 `_` 前缀**（`_ABox一盒人工测试入口卡v1.0.html` + 同名 PNG 目录）—— 这张卡是「某一时刻该网络下」的快照、**含 IP 与生成时刻、内容易变**，**不进《开发基线冻结清单》**（一进就重生成一次飘红一次，最后所有人都不看它 —— **恒红的检查等于没有检查**）；`_` 前缀是仓库既有的「生成物 / 不进冻结集」标记，`baseline_manifest.py` 的 `scan()` 与 `verify-manifest.mjs` 的覆盖性检查**两边都显式跳过 `_` 开头的名字**，口径一致、不留「待归类」噪声。② ⭐ **修掉一处真缺陷：`local-test.mjs --build` 在「已经构建过」的机器上必失败** —— H5 产物 `dist-h5/assets` 轻松超过 50 个文件，而 uni-app / vite 构建前的 `emptyOutDir` 会 `fs.rmSync` 整个目录 → 撞沙箱 bulk-delete 守卫 → vite 汇总成 `x Build failed in 5.48s`，**看起来像代码编译不过、实际代码一行没错**（`build:mp` / `build:admin` 走 `gate.mjs`、自带这层保护，而 **H5 走的是 `local-test.mjs`、没有 gate 兜底** —— M5-4 引入起一直是坏的，这次给测试人起环境才第一次踩到）；修法与 `gate.mjs` 的 `swapAwayOutDir` 同源：构建前把整个 outDir **`rename` 到系统临时目录**（rename 是**单次系统调用、不计入配额**，临时目录本身也在豁免名单内），构建后删掉临时副本 —— 新增 `swapAway()` / `purgeTrash()`，并在失败分支打印**指向守卫而非代码**的提示。③ 《内部测试操作清单》§二 表尾登记交叉引用（**本清单只写「入口是什么」，入口卡负责「地址是什么、二维码在哪」**）· §一 工程步骤补「可整张转入口卡」。④ ⭐ `SCAFFOLD_KEY` **补登 2 项**（`scripts/local-test.mjs` / `scripts/make-qr.mjs`）—— 同属既有判据「验证路径本身也要冻结：门禁执行器 + 端到端验收（**含起服务托管**）」，其中 `local-test.mjs` 是 **M5-4 引入时整批漏登**（旧判据对漏登**完全无感**：两边自洽、照样全绿），故只能靠收尾的机械比对（`git diff --name-only <上批feat_sha> HEAD` ∩ 已登记路径）发现。⑤ **实测**：`format` / `lint` 全绿 · 入口卡**反解 4/4 通过** · 四个入口经**局域网 IP**（192.168.0.102，**非** 127.0.0.1，即证明真的绑在 `0.0.0.0`）逐一验证 —— 用户端 200 · **同源代理 `/api/v1/health` 200** · 运营后台 200 · 接口文档 200 · H5 主脚本与请求层 chunk 均 200，且产物内**无任何写死的 IP**（`apiBaseUrl:"/api/v1"`）· ⭐ **经同源代理真实登录成功**（`POST /api/v1/auth/login {code:'dev:1001'}` → **201 + token + `isLeader:true`**），即手机那条路「页面 → 同源代理 → 后端」**实测贯通** |
| **v2.0.13** | 2026-09-18 | **M5-9 演示 / 边界数据集（人工测试前置 · 零 DDL · 零新增错误码 · 门禁仍 20 道，新增门禁名 `seed:demo`）**：§四 `database/seeds/` 新增 **`seed-demo.ts`** —— 在基础种子**之上叠加**的一层，**刻意不并进 `seed.ts`**：`seed` 是 e2e 前置，而 e2e:m3 有多处**绝对值**断言（D1 排期格数 / 三味屋当日加工场所数 / 发票分母 / 干净候选池）依赖「库里只有基础主数据」，并进去会让这些断言**全红** —— 那是与被测产物无关的**假红**。覆盖面：**34 单 · 订单 11 态全覆盖**（含 `refunding` **保留态探针**）· 退款四态 · 提现五态 · 佣金两段式（`pending`/`settled`/`cancelled` + `reversal` 负行）· 发票三态 · 配送四态 · 套餐三档单价（25.80 / 29.80 / 28.80）；数据只用**楼群 4/5**、楼栋 8/9/11/12、专用 `openid LIKE 'demo_abox_%'` 与单号前缀（`ABDEMO`/`WDDEMO`/`RFDEMO`/`DMDEMO`）—— 与 e2e 密集使用的 1/2/3 楼群**完全错开**。⭐ **11 类边界/异常样本**（未支付不自动取消 · 截单跑批漏跑停在 `paid` · 单次下单上限 20 份 · `refunding` 保留态 · 退款已到账的佣金反向冲销 · 退款在途**不提前**冲销 · 配送单一步未推 · 配送份数与订单不符 · 停职团长的历史费率快照 · **今日完成 → 佣金 pending** · 已送达未确认收货 → **尚无佣金行**）。**自带 12 项自检**（11 态覆盖 / 分配孤儿 / `sold_count` 口径 / 金额闭合 / 佣金逐笔复核 / 同用户同日不重复 / **不占「明日」窗口** / 无团长楼栋归属为 NULL / 资金恒等式 / 在途提现不透支 / **楼 8 团长转交分界（同楼两费率快照）** / **佣金两段式账期**），**任一不过即 `exit 1`**。⭐ **关键设计：补了「今天（T 日）」这一天** —— 后台有 4 处页面默认日期就是**今天**（佣金明细 / 打包任务 / 看板「今日」档 / 配送单取最近配送日），若演示数据全是 T-2 及更早，测试人打开这几页看到**空表**就会记成缺陷；而今日完成的单**天然**是佣金 `pending` 的最佳样本（T+1 02:00 才入账），**无需人为构造**。⚠️ 同时修掉两处**数据层自身缺陷**：① 发票「部分开票」此前**永远造不出来**（把 `none` 当成了部分开 —— 而未付款行**不进开票分母**，故供应商 2 仍被判「全开」，`partialCount` 恒为 0）② 佣金曾写成「`completed` 一律 `settled`」，会让**今天的单凭空多出一天账期**。§一 `gate.mjs` 增门禁名 **`seed:demo`**（与 `seed` 同款 `ABOX_SEED_CONFIRM` 双守卫）；`local-test.mjs` 的 `--seed` **默认同时叠加**演示数据（`--demo=0` 可退回干净库） · §一 ⚠️ **新增 `tests/_probe-demo-data.mjs`**（77 项断言 · **页面可用性**探针）—— 它证明的是与自检**不同**的一件事：「数据对」≠「接口给得出」；刻意**不传 date/range 走页面默认视图**，并把断言**收敛到演示单号前缀**以容忍 e2e 残留，检测到非演示数据会**主动提示**。⚠️ 首跑即报出 **8 项红**，其中 **6 项是探针自身的错**（`building-rank` 出参是 `groups`/`buildings` 而非 `list` · 余额冻结字段是 `frozenFen` · 对账 `list` **只装差异行**故「空」才是正确 · 打包任务出参是 `centers` · 发票阈值过严 · 佣金状态断言**用错了日期**）—— **2 项是演示数据层的真缺口**（发票部分开票、今天的佣金 pending），已就地修掉。⭐ 顺带纠正一份**过时文档**：《种子数据清单》§九 原写的 `AB202609150001…` 六单**从未落地**，已按实际实现重写。⚠️ 本表 M4-0…M4-4 各批次**未逐批登记**的历史欠账仍未清 |

---

*文档结束 · ABox 一盒 · 项目目录结构 v2.0（现行 v2.0.20） · 2026-09-18*
