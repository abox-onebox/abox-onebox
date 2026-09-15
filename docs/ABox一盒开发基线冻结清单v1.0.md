# ABox 一盒 · 开发基线冻结清单 v1.0

> **基线标识**：`v1.1-local-dev-base` · **冻结日期**：2026-09-14 · **最近修订**：2026-09-15（C9 结算口径修订：成本项可配置 · 平台毛利为结果值 · 原型升 v4.10.0 · 废弃《产品方案 v1.0》移入 `archive/`）
> **用途**：本清单声明开发阶段（M1 起）的**唯一输入版本**。开发方一律以本清单所列「现行」文件为准，**不得参考「已废弃」文件**。
> **校验方式**：文件名 + 字节数 + SHA-256（前 12 位）三重核对；拿到文件后先跑一次摘要比对，防止版本漂移。

---

## 一、冻结基线总览

| 项 | 值 |
| --- | --- |
| 基线标识 | `v1.1-local-dev-base`（提交历史重建后的现行 tag） |
| 冻结日期 | 2026-09-14 |
| 原型版本 | v4.10.0（37 页，已部署；结算成本项可配置版） |
| 现行资产 | 26 份 |
| 已废弃资产 | 5 份（存档，勿参考） |
| 工程骨架 | `abox-onebox/` · **414 个文件**（阶段四产出） |
| 数据库表 | **24 张**（ER v2.1 的 23 张 + 评审新增 `ab_leader_invite`） |
| 技术栈 | uni-app(Vue3+TS) + NestJS + MySQL 8 + Redis 7 + 微信支付 V3；**佣金出款走灵活用工平台代发**（C11，见目录结构 v2.0） |
| 基线 commit | 基线 tag `v1.1-local-dev-base`（`0e9552e` · 388 文件）· 生成时 HEAD `a8c4ba7`（本清单与该提交一并入仓） |
| 准备期状态 | **阶段一 / 二 / 三 / 四 全部完成 + M0 启动评审已通过**，已开工 M1 |

---

## 二、现行资产（开发阶段唯一输入）

| # | 文件 | 版本 / 说明 | 字节 | SHA-256（前 12） |
| --- | --- | --- | --- | --- |
| 1 | `ABox一盒M0启动评审纪要v1.0.md` | M0 启动评审结论（通过）· 检查清单 7✅/4⏳ · 关键口径 12 条 · M1 启动条件 | 9,347 | `b01f2cd5709c` |
| 2 | `ABox一盒MVP优化交接包v1.3.html` | 交接包 v1.3 的排版可读版（含 C11：灵活用工代发 + 日结） | 32,794 | `24d65b3bdf33` |
| 3 | `ABox一盒MVP优化交接包v1.3.md` | 锁定项 L1–L12 + 裁决 C1–C11（口径权威 · 文本版） | 20,108 | `3d5be8dd914d` |
| 4 | `ABox一盒MVP优化执行报告v1.0.html` | A/B/C/D 四方向优化结论（⚠️ 历史文档：其「余额账户砍至二期」表述已被 PRD v2.1 覆盖） | 24,211 | `d88aa9b59b6e` |
| 5 | `ABox一盒MVP原型审查报告v1.0.html` | 29 项问题清单（回归验收基准）· ⚠️ 历史快照：正文为 2026-09-14 发现记录，文首已加 C9 修订提示 | 13,434 | `c61775bfe94c` |
| 6 | `ABox一盒PRDv2.1.md` | 产品需求文档 · 已回填 C1–C11 + M01-04 + §6.4 结算与出款通道定案 | 26,833 | `10906a9a83e9` |
| 7 | `ABox一盒专家团进场就绪度审计报告v1.0.md` | 专家团进场就绪度审计（五维 · 结论均来自实机复跑） | 20,931 | `1a1f01936bf1` |
| 8 | `ABox一盒专家团进场隐患修复验收单v1.0.md` | 3 P0 + 9 P1 + 8 P2 隐患修复验收单（CI 全绿 · M1 可开工） | 8,188 | `e7c6ace16e7c` |
| 9 | `ABox一盒业务运作理解v2.0.md` | 业务时序与关键事实（已最终确认） | 9,031 | `05e25145ee01` |
| 10 | `ABox一盒协作规范v1.0.md` | 分支 / 提交 / 评审 / 配置纪律 / 文档变更流程 / DoD（阶段四） | 12,013 | `422595eff119` |
| 11 | `ABox一盒合规资质与协议清单v1.0.md` | 资质与协议要点（阶段三）· 资金定性=自营 + 佣金个税走灵活用工 | 15,446 | `d3a9b3a0f902` |
| 12 | `ABox一盒开发前准备计划v1.0.html` | 四阶段推进路线（准备期总纲） | 28,685 | `feb3c6c759a2` |
| 13 | `ABox一盒开发里程碑计划v1.0.md` | M1–M5 里程碑 + W1–W10 甘特 + 验收标准 + 风险登记册（阶段四） | 16,095 | `aa8c33fb2ec4` |
| 14 | `ABox一盒接口规范v1.0.md` | 接口契约（阶段二）· 60+ 端点 / 错误码 / 幂等 | 34,901 | `76aea4ec51de` |
| 15 | `ABox一盒数据库ER设计v2.1.md` | 数据模型 · 23 张表（评审后补 ab_leader_invite → 24 张） | 30,547 | `691578fa7e96` |
| 16 | `ABox一盒本地开发手册v1.0.md` | 不依赖云资源的本地开发手册（四驱动开关 · 本地跑通登录→下单→支付→回调） | 15,697 | `0a1cccd8a63d` |
| 17 | `ABox一盒种子数据清单v1.0.md` | 开发初始数据（阶段二）· 12 楼 / 5 团长 / 4 供应商 | 17,892 | `76aba8337023` |
| 18 | `ABox一盒表结构评审意见v1.0.md` | ER 评审结论（阶段二）· P0×6 + 4 张补齐 DDL | 24,241 | `ee62165ea313` |
| 19 | `ABox一盒订单状态机与全链路流转v1.0.md` | 订单域行为契约（阶段二）· 11 态 / 8 定时任务 / C6 退款三段式 / C11 出款通道 | 18,629 | `ac3901dcc284` |
| 20 | `ABox一盒设计token规范v1.0.html` | 设计与实现共用视觉变量 | 20,375 | `34faff40f86e` |
| 21 | `ABox一盒账号资源与密钥清单v1.0.md` | 外部资源核对表（阶段三）· 含 C10/C11 结算与出款通道定案 | 15,851 | `3973bac7ad74` |
| 22 | `ABox一盒项目目录结构v2.0.md` | Monorepo 布局 · 端页模块映射 · v2.0.2 补 leader-expire.task | 34,822 | `b39104373c87` |
| 23 | `手机测试指南.md` | 原型真机测试方式 | 5,615 | `fdadff0b2889` |
| 24 | `prototype/index.html` | 可点击原型 v4.10.0（37 页 · 结算成本项可配置版 · 已部署线上） | 275,848 | `6069906879d5` |
| 25 | `prototype/README.md` | 原型变更日志（已刷新至 v4.10.0，页索引 37 页；页面归属仍以《目录结构 v2.0》§十 为准） | 43,872 | `4ced2a5caa17` |
| 26 | `prototype/manifest.json` | PWA 清单 | 679 | `a339bfd8ca0d` |

---

## 三、已废弃资产（存档 · 勿参考）

| # | 文件 | 版本 / 说明 | 字节 | SHA-256（前 12） |
| --- | --- | --- | --- | --- |
| 1 | `archive/ABox一盒MVP优化交接包v1.0.md` | 已被 v1.3 取代（C1–C9 未裁决）（已移入 `archive/`，不再进 `docs/` 与交接目录） | 9,690 | `db99aa95da84` |
| 2 | `archive/ABox一盒业务运作理解v1.0.md` | 已被 v2.0 取代（已移入 `archive/`，不再进 `docs/` 与交接目录） | 10,221 | `e25f5ffa3112` |
| 3 | `archive/ABox一盒小程序产品方案v1.0.md` | v1.0 系列，口径已过时（已移入 `archive/`，不再进 `docs/` 与交接目录） | 26,941 | `585efc549bd3` |
| 4 | `archive/ABox一盒数据库ER设计v1.0.md` | 已被 v2.1 取代（已移入 `archive/`，不再进 `docs/` 与交接目录） | 33,423 | `ba8ea158ee0d` |
| 5 | `archive/ABox一盒项目目录结构v1.0.md` | 已被 v2.0 取代（含楼长端 / T-1 20:00）（已移入 `archive/`，不再进 `docs/` 与交接目录） | 22,300 | `82aeb781ebce` |

---

## 四、工程骨架 `abox-onebox/`（阶段四产出）

**总计 414 个文件**，按区域分布：

| 区域 | 文件数 |
| --- | --- |
| `.editorconfig` | 1 |
| `.env.example` | 1 |
| `.eslintrc.cjs` | 1 |
| `.gitattributes` | 1 |
| `.github` | 4 |
| `.gitignore` | 1 |
| `.husky` | 4 |
| `.npmrc` | 1 |
| `.prettierignore` | 1 |
| `.prettierrc.json` | 1 |
| `CONTRIBUTING.md` | 1 |
| `README.md` | 1 |
| `apps/admin-web` | 74 |
| `apps/api-server` | 173 |
| `apps/miniprogram` | 76 |
| `commitlint.config.cjs` | 1 |
| `data` | 1 |
| `docker-compose.yml` | 1 |
| `docs` | 24 |
| `gate-all.log` | 1 |
| `lint-staged.config.cjs` | 1 |
| `package.json` | 1 |
| `packages/eslint-config` | 2 |
| `packages/shared-types` | 15 |
| `packages/shared-utils` | 7 |
| `packages/tsconfig` | 4 |
| `pnpm-lock.yaml` | 1 |
| `pnpm-workspace.yaml` | 1 |
| `scripts/db-migrate.sh` | 1 |
| `scripts/db-seed.sh` | 1 |
| `scripts/deploy.sh` | 1 |
| `scripts/e2e-m1.mjs` | 1 |
| `scripts/e2e-m2.mjs` | 1 |
| `scripts/gate.mjs` | 1 |
| `scripts/init.sql` | 1 |
| `scripts/lib` | 1 |
| `scripts/setup-husky.mjs` | 1 |
| `scripts/setup.ps1` | 1 |
| `scripts/setup.sh` | 1 |
| `scripts/sync-docs.mjs` | 1 |
| `tsconfig.base.json` | 1 |

**关键文件摘要**（其余文件以仓库为准）：

| # | 文件 | 版本 / 说明 | 字节 | SHA-256（前 12） |
| --- | --- | --- | --- | --- |
| 1 | `package.json` |  | 2,066 | `a6ba8483c47d` |
| 2 | `pnpm-workspace.yaml` |  | 646 | `dc89e54d2011` |
| 3 | `tsconfig.base.json` |  | 940 | `74c44d9207f5` |
| 4 | `docker-compose.yml` |  | 2,543 | `382129302077` |
| 5 | `.env.example` |  | 3,890 | `e79a34a834d4` |
| 6 | `.eslintrc.cjs` |  | 1,231 | `fe5853774dd4` |
| 7 | `commitlint.config.cjs` |  | 406 | `db5b70bd3b85` |
| 8 | `README.md` |  | 5,442 | `65f1497c9d6d` |
| 9 | `CONTRIBUTING.md` |  | 722 | `4163e2093f29` |
| 10 | `.github/workflows/ci.yml` |  | 2,690 | `5a352c1876b3` |
| 11 | `scripts/setup.sh` |  | 1,484 | `65251581d8fe` |
| 12 | `scripts/setup.ps1` |  | 4,319 | `8f8eb8d2b0c3` |
| 13 | `scripts/init.sql` |  | 200 | `54ae1e6803fa` |
| 14 | `scripts/sync-docs.mjs` |  | 4,135 | `fc5b05301ea9` |
| 15 | `scripts/gate.mjs` |  | 9,221 | `889be81c80e1` |
| 16 | `scripts/e2e-m1.mjs` |  | 12,487 | `fd69e5f28323` |
| 17 | `scripts/e2e-m2.mjs` |  | 14,140 | `c872f1f104df` |
| 18 | `scripts/lib/e2e-server.mjs` |  | 8,161 | `62b1429c3cda` |
| 19 | `packages/shared-types/src/enums/order-status.ts` |  | 3,498 | `b979834b3368` |
| 20 | `packages/shared-types/src/enums/leader-level.ts` |  | 1,614 | `6a371c28de60` |
| 21 | `packages/shared-types/src/enums/payout-channel.ts` |  | 1,972 | `2b2fd157fa37` |
| 22 | `apps/api-server/src/modules/finance/payout.service.ts` |  | 635 | `e61750f399d3` |
| 23 | `packages/shared-utils/src/biz.ts` |  | 4,941 | `183d7ea2e070` |
| 24 | `apps/miniprogram/src/constants/index.ts` |  | 4,094 | `e7efa02eebf2` |
| 25 | `apps/miniprogram/src/uni.scss` |  | 622 | `016600e38e91` |
| 26 | `apps/miniprogram/src/pages.json` |  | 3,330 | `6c6a1f1c7061` |
| 27 | `apps/admin-web/src/constants/index.ts` |  | 3,922 | `671196172164` |
| 28 | `apps/admin-web/src/styles/element-override.scss` |  | 830 | `6dab60cc998b` |
| 29 | `apps/api-server/src/app.module.ts` |  | 2,338 | `378e08442352` |
| 30 | `apps/api-server/src/modules/order/order-state-machine.ts` |  | 6,246 | `c71905a46aca` |
| 31 | `apps/api-server/src/tasks/leader-expire.task.ts` |  | 599 | `643dfb5dccf5` |
| 32 | `apps/api-server/test/unit/order-state-machine.spec.ts` |  | 1,546 | `fb77b77fb8a4` |

> 骨架含：根配置（pnpm workspace / TS / ESLint / Prettier / commitlint）+ CI 四作业 + Docker Compose（MySQL 8 + Redis 7，无 RabbitMQ）
> + 小程序 21 页骨架 + 后台 33 视图骨架 + 后端 15 模块 / 8 定时任务 / 3 消费者 + 4 个 packages。
> 业务实现留空，由开发阶段填充；**锁定口径仅剩售价与费率**（售价 ¥25.80 / 佣金 8-9-10-12% / 截单 T-1 24:00）；**结算成本项已全部改为可配置**（供应商供价逐菜协商 / 集散复用场地默认 ¥0 / 打包人工 / 配送费 / **平台毛利为结果值** · C9 2026-09-15 修订），**佣金出款通道已抽象**（`PayoutChannel` · C11：灵活用工平台代发，一期清单导出 + 回执登记）。

---

## 五、验证工具（随基线冻结）

| # | 文件 | 版本 / 说明 | 字节 | SHA-256（前 12） |
| --- | --- | --- | --- | --- |
| 1 | `tests/nav-stack.test.js` | 导航栈单测（61 断言） | 9,671 | `6e9ebac3e6e5` |
| 2 | `tests/render_check.js` | 渲染 / 运行时检查（11 后台页 + 移动端） | 6,255 | `414729ff3c1c` |
| 3 | `tests/bracket_check.py` | 括号与反引号配平 | 2,297 | `665a00c07c76` |
| 4 | `tests/js-syntax-check.js` | JS 语法校验 | 785 | `1e5cfda6093b` |
| 5 | `tests/check_online.py` | 线上部署核验 | 1,475 | `3efc02e45877` |
| 6 | `tests/baseline_manifest.py` | 本清单生成器（基线变更时重跑） | 15,634 | `71d3555a8e3e` |

---

## 六、冻结与变更规则

1. **只增不改**：基线冻结后，任何文档变更**不得直接改写原文件**，须另出增量版本（如 v2.2），并在「变更记录」中登记。
2. **文档 ↔ 原型同步**：改文档必须同步原型（反之亦然），一致性以《原型审查报告 v1.0》的 29 项清单回归为准。
3. **变更留痕**：所有变更需记录「变更人 / 日期 / 原因 / 影响范围」，并走《协作规范 v1.0》§六 变更流程。
4. **口径冲突仲裁顺序**：交接包 **v1.3**（锁定项 L1–L12、裁决 **C1–C11**）> PRD v2.1 > ER v2.1 > 目录结构 v2.0 > 接口规范 / 状态机 v1.0 > 其它。
5. **代码仓库对应关系**：本清单的 `docs/` 目标位置见《项目目录结构 v2.0》§一；阶段四已生成骨架，执行 `pnpm docs:sync` 即可把根目录文档同步入仓。

---

*文档结束 · ABox 一盒 · 开发基线冻结清单 v1.0 · 2026-09-14*
