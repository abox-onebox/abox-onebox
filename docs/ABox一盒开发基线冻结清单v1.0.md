# ABox 一盒 · 开发基线冻结清单 v1.0

> **基线标识**：`v1.1-local-dev-base` · **冻结日期**：2026-09-14 · **最近修订**：2026-09-16（⑩ M3-8 出餐确认 S1–S3 + ⑪ 上线路线回归自营（见下）；① C9 结算口径修订：成本项可配置 · 平台毛利为结果值 · 原型升 v4.10.0 · 废弃《产品方案 v1.0》移入 `archive/`；② M2-2.1/2.2 落地：团长叠加身份 + 申请即生效，`ab_team_leader` 补回 `floor`，「团长在职」判据统一 `status = 1`，等级值统一 `formal`；③ 验证路径纳入冻结：`scripts/gate.mjs` / `e2e-m1` / `e2e-m2` / `lib/e2e-server.mjs`；④ M3-1 后台鉴权基座落地：**双主体隔离**（小程序 `ab_user` 与后台 `ab_admin_user` 各自独立账号，靠 JWT `typ` 按路径隔离，越权 = 10002/10003）· 角色→菜单**以代码为唯一来源**（`admin-role.ts`，一期不建 `ab_admin_role` 表）· 令牌吊销走 KV（改角色/停用后旧 token 立即失效）· 声明式操作日志 · 错误码补 `20009`/`20010` · 验证路径纳入 `scripts/e2e-m3.mjs`；⑤ **M3-2 套餐编排 D1–D7 落地**：`创建 ≠ 上架` 两步分离（D2 建 pending，D4 才 active）· 矩阵返回**完整网格**且 `emptyBuildings` 由楼栋状态派生 · 已截单不许上架（`30013`）· D5 批量复制**不覆盖**已存在项 · D7 由菜品**反查**供应商并求和成本（前端不提交 `supplierId`/`costPrice`）· 错误码补 `30011`/`30012`/`30013`；⑥ **M3-3 订单中心 D8–D12 落地**：D8 返回**完整网格语义**且 `tab=abnormal` 不含 `cancelled`、`summary` 不受分页影响、**后台列表同样脱敏**（全号只有 D12 导出且强制留痕）· D9 `actions` 把按钮可用性口径收到服务端 · D10 改单给的是**目标值不是增量**（重试不翻倍）、改份数仅限未支付、改取餐楼须**同楼群**（`30015`）、过截单 `30014` · D11 后台强制退款拆两路（微信原路退 + 余额单独退回）、`amountFen` 是防误操作参数（不符 `40011`）· **C9 反向结算**：原记录不得改写（冲销写负行、原行只翻 `cancelled`）、毛利留存、应付三态（未生成时不造空冲销行）· 错误码补 `30014`/`30015`/`40009`/`40010`/`40011`）；⑦ **M3-4 退款审批 D40–D42 落地**：C6 三段式收口 —— 审批与实退**同事务**（唯一执行口 `executeRefund`）· 驳回资金零变动且订单回 `ab_refund.order_status_before`（**缺列值 40014 fail-closed**，不猜默认值）· 仅 `applying` 可批（否则 `40013`）· 审批时**重算可退额**不符即 `40011` · 两级白名单（类级含 `operator`，D41/D42 方法级收窄到资金角色）· 错误码补 `40012`/`40013`/`40014`；⑧ **M3-5 后台团长管理 D19–D22 落地**：名录/流水/详情（操作日志按**团长 id 与 用户 id 双键**查）· 任命与转交闸门 `20012`（回带 `occupiedBy`，现任**停职而非删除**）· 改等级**同步写 `commission_rate`** · 停用/复职只走 D22 单一入口 · 两级白名单 · 错误码补 `20011`/`20012`/`20013` · **零 DDL 变更**；⑨ **M3-6 后台供应商管理 + 集散 D23–D32 落地**：列表脱敏 / 详情才回真实手机号、**银行账号原文任何接口不回** · 新建即 `audit_status=pending` · 资质审核与 `status` **正交**（驳回不自动下架）· 类型闸门 `50008` 三入口同拦 · 集散中心软删两道前置（错误信息给「改用停用」的出路）· `serviceGroups` **整体替换**（传空数组即清空）· **`ab_supplier` 补 7 列**（本批次唯一 DDL）· 操作日志拦截器**响应体兜底取新建对象 id** · 错误码补 `50003`/`50005`/`50006`/`50007`/`50008`；⑩ **M3-7 后台办公楼与楼群 D13–D18 落地**（原型 P37 五视图）：**状态三态修订** `BuildingStatus`（1 营业中 / 2 待开通 / 3 已暂停）修掉旧种子「待开通与已暂停都写 2」的**一值两义**缺陷（楼群**刻意保持二态**）· **覆盖缺口三因** `DistributionGap`（`none`/`no_group`/`no_center`/`all_center_disabled` —— 三种成因三种修法）· **集散主备与路线号 R1…Rn 全派生不落库**（真源 `ab_distribution_center.service_groups`；且**不返回距离/时长** —— 无地图数据，原型 km/分钟是演示值）· D15 `buildingGroupId: null` = **移出楼群**、空变更 `10001`、**刻意不收 `leaderId`**（改团长只有 D20/D21 一个入口，避免绕过 `20012` 闸门）· D18 停用非空楼群 `60003` **fail-closed** 且**先搬楼再判闸门**（一次请求内「清空成员 + 停用」放行）· `ab_building` 增 `population` 列（**唯一 DDL，无新表**）· 错误码补 `60001`–`60005`（新号段 `6xxxx 主数据`））
> **⑩ 本批次（M3-8）**：供应商端出餐确认 S1–S3 落地 —— 生产计划**惰性生成且生成即冻结**（只生成 `planQuantity > 0` 的行）· 09:30 deadline 是**截止点不是最早点**（迟于出餐日 09:30 一律 `50009` fail-closed，**不接受补确认**）· 确认粒度 = (供应商, 菜品, 出餐日, 集散中心) 逐项**幂等** · 父表状态由明细**派生** pending/cooking/done（不新增 `partial`）· S3 打包闸门 `ready` 依赖全中心确认，非集散型主体 `visible=false`（HTTP 200 而非错误）· 请求体**刻意不收 `supplierId`**（收下即 `10001`）· **新增表 `ab_supplier_dish_center_daily`**（本批次唯一 DDL）· 错误码补 `50009`/`50010`/`50011`；**⑪ 上线路线裁定**：由 v1.1 的「第三方平台路线」**回归「单主体自营 + 半成品供应链」**（2026-09-16）—— EDI 许可证 / 网络食品交易第三方平台备案 / 电商收付通与二级商户号**全部撤销**，资金定性恢复「自营 → 不涉二清」，核心长周期项变为**《食品经营许可证》（热食类制售）**，详见《上线资质与平台准入清单 v1.2》；**⑫ 本批次（M3-9 应付结算 S9）**：**自营口径首次实装**（**零 DDL**）—— ① 回退 M3-3 `reverseSupplierShares()`：退款**不再冲减**供应商应付，改为显式声明 `supplierShareAdjusted=0` + `supplierShareMode='not_applicable'`（保留字段让「应付分文未动」可断言）；② 出单 `POST /admin/supplier-shares/generate` —— 计费基数 = **实收量**（`NULL` 视为足额），⭐ **单价取 `ab_supplier_dish_daily.unit_price`（生成即冻结的协商价快照）**、为空才回落 `ab_dish.cost_price`（并据此修正口径文档 §4.1）；③ **四闸 fail-closed**（资质异常 / 父行未 `done` / 实收为空 / 实收 0）→ 不出单、进「未出单异常清单」，**补齐输入重跑即可补出**；④ 付款登记仅 `pending` 可（`50012`）、回单号必填（`50013`）、同一回单号不得用于两笔；⑤ **幂等走软层、刻意不建唯一索引**（本表含 `type='reversal'` 负行，同键正负两行是合法冲销）；⑥ 供应商端 S9 `GET /supplier/settlement` 复用财务侧 `SupplierShareService.supplierView()`（运营与供应商**只有一份实现**），出参含**跨日期**待付合计、**不变量 I1 落在结构层**；⑦ 跑批 `SupplierShareTask`（T+1 02:00）与手动补跑共用同一执行口；⑧ 权限两级白名单（类级含 `operator`，`generate`/`payment` 方法级收窄到资金角色）；⑨ 错误码 `50012` `50013`（**`50014` 取消并释放号位** —— 「确认未完成 → 不出单」是常态待办，做成错误码只会让运营看到「出单失败」看不到「哪几家没确认」）；⑩ `e2e-m3` 新增 **§21**（41 条断言 · 不依赖下单窗口）；⑪ 顺手清掉残留旧语境（供应商端「分账单价」、集散页「复用合作供应商场地」、`seed` 的 `settlement.site_fee` 文案、`finance.entity` 列注释）——自营下这些字样与口径矛盾，留着就是「两个真相」；⑫ `SCAFFOLD_KEY` 增 **9 项** M3-9 契约载体。
> **用途**：本清单声明开发阶段（M1 起）的**唯一输入版本**。开发方一律以本清单所列「现行」文件为准，**不得参考「已废弃」文件**。
> **校验方式**：文件名 + 字节数 + SHA-256（前 12 位）三重核对；拿到文件后先跑一次摘要比对，防止版本漂移。

---

## 一、冻结基线总览

| 项 | 值 |
| --- | --- |
| 基线标识 | `v1.1-local-dev-base`（提交历史重建后的现行 tag） |
| 冻结日期 | 2026-09-14 |
| 原型版本 | v4.10.0（37 页，已部署；结算成本项可配置版） |
| 现行资产 | 29 份 |
| 已废弃资产 | 7 份（存档，勿参考） |
| 工程骨架 | `abox-onebox/` · **480 个文件**（阶段四产出） |
| 数据库表 | **26 张**（ER v2.1：23 张 + 评审新增 `ab_leader_invite` + M2 新增 `ab_withdraw` + M3-8 新增 `ab_supplier_dish_center_daily`） |
| 技术栈 | uni-app(Vue3+TS) + NestJS + MySQL 8 + Redis 7 + 微信支付 V3；**佣金出款走灵活用工平台代发**（C11，见目录结构 v2.0） |
| 基线 commit | 基线 tag `v1.1-local-dev-base`（`0e9552e` · 388 文件）· 生成时 HEAD `2926998`（**回溯基准**：清单是生成物，其自身提交号 = 上述 HEAD 的下一笔 `chore(baseline)` 提交） |
| 准备期状态 | **阶段一 / 二 / 三 / 四 全部完成 + M0 启动评审已通过**；M1（后端 + 小程序基座）· M2（团长端全链路）已端到端验收；**M3（运营后台 + 供应商端）进行中**（M3-1 后台鉴权基座 · M3-2 套餐编排 D1–D7 · M3-3 订单中心 D8–D12 · M3-4 退款审批 D40–D42 · M3-5 后台团长管理 D19–D22 · M3-6 后台供应商管理 + 集散 D23–D32 · M3-7 后台办公楼与楼群 D13–D18 已落地 · **M3-8 供应商端出餐确认 S1–S3 已落地**；M3-9~M3-11 待写） |

---

## 二、现行资产（开发阶段唯一输入）

| # | 文件 | 版本 / 说明 | 字节 | SHA-256（前 12） |
| --- | --- | --- | --- | --- |
| 1 | `ABox一盒M0启动评审纪要v1.0.md` | M0 启动评审结论（通过）· 检查清单 7✅/4⏳ · 关键口径 12 条 · M1 启动条件 | 9,347 | `b01f2cd5709c` |
| 2 | `ABox一盒MVP优化交接包v1.3.html` | 交接包 v1.3 的排版可读版（含 C11：灵活用工代发 + 日结） | 32,794 | `24d65b3bdf33` |
| 3 | `ABox一盒MVP优化交接包v1.3.md` | 锁定项 L1–L12 + 裁决 C1–C11（口径权威 · 文本版） | 20,108 | `3d5be8dd914d` |
| 4 | `ABox一盒MVP优化执行报告v1.0.html` | A/B/C/D 四方向优化结论（⚠️ 历史文档：其「余额账户砍至二期」表述已被 PRD v2.1 覆盖） | 24,211 | `d88aa9b59b6e` |
| 5 | `ABox一盒MVP原型审查报告v1.0.html` | 29 项问题清单（回归验收基准）· ⚠️ 历史快照：正文为 2026-09-14 发现记录，文首已加 C9 修订提示 | 13,434 | `c61775bfe94c` |
| 6 | `ABox一盒PRDv2.1.md` | 产品需求文档 · 已回填 C1–C11 + M01-04 + §6.4 结算与出款通道定案 | 27,668 | `53d054284c4b` |
| 7 | `ABox一盒专家团进场就绪度审计报告v1.0.md` | 专家团进场就绪度审计（五维 · 结论均来自实机复跑） | 20,931 | `1a1f01936bf1` |
| 8 | `ABox一盒专家团进场隐患修复验收单v1.0.md` | 3 P0 + 9 P1 + 8 P2 隐患修复验收单（CI 全绿 · M1 可开工） | 8,188 | `e7c6ace16e7c` |
| 9 | `ABox一盒业务运作理解v2.0.md` | 业务时序与关键事实（已最终确认） | 9,059 | `37e971cf0bd0` |
| 10 | `ABox一盒协作规范v1.0.md` | 分支 / 提交 / 评审 / 配置纪律 / 文档变更流程 / DoD（阶段四） | 12,095 | `41d9c7b51a8e` |
| 11 | `ABox一盒合规资质与协议清单v1.0.md` | 资质与协议要点（阶段三）· 资金定性=自营 + 佣金个税走灵活用工 · 2026-09-16 结算改采购应付口径 | 15,644 | `17c806a2a074` |
| 12 | `ABox一盒外卖小程序上线资质与平台准入清单v1.2.md` | 自营路线上线资质与准入执行清单（v1.2 · 2026-09-16 裁定回归「单主体自营 + 半成品供应链」：不需 EDI / 不需平台备案 / 不涉二清；核心资质 = 食品经营许可证（热食类制售）） | 10,493 | `5ef0bca42795` |
| 13 | `ABox一盒外卖小程序最快上线路径与提审自检清单v1.2.md` | 最快上线路径 + 提审自检清单（v1.2） | 17,812 | `084ffc9cac90` |
| 14 | `ABox一盒开发前准备计划v1.0.html` | 四阶段推进路线（准备期总纲） | 28,685 | `feb3c6c759a2` |
| 15 | `ABox一盒开发里程碑计划v1.0.md` | M1–M5 里程碑 + W1–W10 甘特 + 验收标准 + 风险登记册（阶段四） | 28,863 | `9849be7b6591` |
| 16 | `ABox一盒接口规范v1.0.md` | 接口契约（阶段二）· 60+ 端点 / 错误码 / 幂等 · 2026-09-16 S9 应付结算改「采购应付」口径 | 103,835 | `51eb4e381f88` |
| 17 | `ABox一盒数据库ER设计v2.1.md` | 数据模型 · 26 张表（2026-09-15 补 ab_withdraw 提现单 + ab_balance_log 出款字段 + ab_team_leader 收款方式/floor + ab_refund.order_status_before）· 2026-09-16 M3-5 后台团长管理零 DDL（§5.4）· M3-6 ab_supplier 补 7 列（§5.5：资质审核四列 + license_expire_at + invoice_title + takeout_links）· M3-7 ab_building 增 population + 状态三态（§5.6，唯一 DDL、无新表）· **M3-8 新增 ab_supplier_dish_center_daily**（§3.6.1，供应商出餐确认分中心明细，本批次唯一 DDL） | 54,153 | `0a6ac7fa6957` |
| 18 | `ABox一盒本地开发手册v1.0.md` | 不依赖云资源的本地开发手册（四驱动开关 · 本地跑通登录→下单→支付→回调） | 15,703 | `0b5bfae270d7` |
| 19 | `ABox一盒种子数据清单v1.0.md` | 开发初始数据（阶段二）· 12 楼 / 5 团长 / 4 供应商 | 22,169 | `61915524f96e` |
| 20 | `ABox一盒自营结算口径定义v1.0.md` | 自营口径下结算定义（2026-09-16 定稿）· 4 条裁定 + 2 条不变量：**退款不冲减供应商应付** / 计费基数取**实收量** / 应付对象**仅供应商采购款** / siteFee 改**自有场所摊销**；S9 出单 fail-closed + 幂等键；错误码预留 50012–50014 | 17,710 | `68ced7c24539` |
| 21 | `ABox一盒表结构评审意见v1.0.md` | ER 评审结论（阶段二）· P0×6 + 4 张补齐 DDL | 24,817 | `53e5f67f568c` |
| 22 | `ABox一盒订单状态机与全链路流转v1.0.md` | 订单域行为契约（阶段二）· 11 态 / 8 定时任务 / C6 退款三段式 / C11 出款通道 | 18,802 | `73bfdbfabc76` |
| 23 | `ABox一盒设计token规范v1.0.html` | 设计与实现共用视觉变量 | 20,375 | `34faff40f86e` |
| 24 | `ABox一盒账号资源与密钥清单v1.0.md` | 外部资源核对表（阶段三）· 含 C10/C11 结算与出款通道定案 | 16,157 | `3ccb06fe9245` |
| 25 | `ABox一盒项目目录结构v2.0.md` | Monorepo 布局 · 端页模块映射 · v2.0.2 补 leader-expire.task | 34,822 | `b39104373c87` |
| 26 | `手机测试指南.md` | 原型真机测试方式 | 5,615 | `fdadff0b2889` |
| 27 | `prototype/index.html` | 可点击原型 v4.10.0（37 页 · 结算成本项可配置版 · 已部署线上） | 275,848 | `6069906879d5` |
| 28 | `prototype/README.md` | 原型变更日志（已刷新至 v4.10.0，页索引 37 页；页面归属仍以《目录结构 v2.0》§十 为准） | 43,872 | `4ced2a5caa17` |
| 29 | `prototype/manifest.json` | PWA 清单 | 679 | `a339bfd8ca0d` |

---

## 三、已废弃资产（存档 · 勿参考）

| # | 文件 | 版本 / 说明 | 字节 | SHA-256（前 12） |
| --- | --- | --- | --- | --- |
| 1 | `ABox一盒外卖小程序上线资质与平台准入清单v1.0.md` | 已被 v1.1 取代（第三方平台路线与 EDI 前置未纳入） | 22,361 | `942e462eb54a` |
| 2 | `ABox一盒外卖小程序上线资质与平台准入清单v1.1.md` | 已被 v1.2 取代（第三方平台路线于 2026-09-16 被裁定推翻） | 28,500 | `44872b6f3656` |
| 3 | `archive/ABox一盒MVP优化交接包v1.0.md` | 已被 v1.3 取代（C1–C9 未裁决）（已移入 `archive/`，不再进 `docs/` 与交接目录） | 9,690 | `db99aa95da84` |
| 4 | `archive/ABox一盒业务运作理解v1.0.md` | 已被 v2.0 取代（已移入 `archive/`，不再进 `docs/` 与交接目录） | 10,221 | `e25f5ffa3112` |
| 5 | `archive/ABox一盒小程序产品方案v1.0.md` | v1.0 系列，口径已过时（已移入 `archive/`，不再进 `docs/` 与交接目录） | 26,941 | `585efc549bd3` |
| 6 | `archive/ABox一盒数据库ER设计v1.0.md` | 已被 v2.1 取代（已移入 `archive/`，不再进 `docs/` 与交接目录） | 33,423 | `ba8ea158ee0d` |
| 7 | `archive/ABox一盒项目目录结构v1.0.md` | 已被 v2.0 取代（含楼长端 / T-1 20:00）（已移入 `archive/`，不再进 `docs/` 与交接目录） | 22,300 | `82aeb781ebce` |

---

## 四、工程骨架 `abox-onebox/`（阶段四产出）

**总计 480 个文件**，按区域分布：

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
| `_m3c.log` | 1 |
| `_m3d.log` | 1 |
| `_m3e.log` | 1 |
| `apps/admin-web` | 86 |
| `apps/api-server` | 212 |
| `apps/miniprogram` | 80 |
| `commitlint.config.cjs` | 1 |
| `data` | 1 |
| `docker-compose.yml` | 1 |
| `docs` | 27 |
| `lint-staged.config.cjs` | 1 |
| `package.json` | 1 |
| `packages/eslint-config` | 2 |
| `packages/shared-types` | 20 |
| `packages/shared-utils` | 7 |
| `packages/tsconfig` | 4 |
| `pnpm-lock.yaml` | 1 |
| `pnpm-workspace.yaml` | 1 |
| `scripts/db-migrate.sh` | 1 |
| `scripts/db-seed.sh` | 1 |
| `scripts/deploy.sh` | 1 |
| `scripts/e2e-m1.mjs` | 1 |
| `scripts/e2e-m2.mjs` | 1 |
| `scripts/e2e-m3.mjs` | 1 |
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
| 15 | `scripts/gate.mjs` |  | 9,436 | `eeaeacde1c23` |
| 16 | `scripts/e2e-m1.mjs` |  | 12,487 | `fd69e5f28323` |
| 17 | `scripts/e2e-m2.mjs` |  | 48,439 | `db82927bc941` |
| 18 | `scripts/lib/e2e-server.mjs` |  | 8,161 | `62b1429c3cda` |
| 19 | `packages/shared-types/src/enums/order-status.ts` |  | 4,529 | `c2481e6d3beb` |
| 20 | `packages/shared-types/src/enums/leader-level.ts` |  | 1,614 | `6a371c28de60` |
| 21 | `packages/shared-types/src/enums/payout-channel.ts` |  | 1,972 | `2b2fd157fa37` |
| 22 | `apps/api-server/src/modules/finance/payout.service.ts` |  | 635 | `e61750f399d3` |
| 23 | `packages/shared-utils/src/biz.ts` |  | 6,417 | `f35b1531e6b0` |
| 24 | `apps/miniprogram/src/constants/index.ts` |  | 4,094 | `e7efa02eebf2` |
| 25 | `apps/miniprogram/src/uni.scss` |  | 622 | `016600e38e91` |
| 26 | `apps/miniprogram/src/pages.json` |  | 3,470 | `3f08ea37d3ac` |
| 27 | `apps/admin-web/src/constants/index.ts` |  | 5,112 | `7611abd957de` |
| 28 | `apps/admin-web/src/styles/element-override.scss` |  | 830 | `6dab60cc998b` |
| 29 | `apps/api-server/src/app.module.ts` |  | 2,338 | `378e08442352` |
| 30 | `apps/api-server/src/modules/order/order-state-machine.ts` |  | 6,246 | `c71905a46aca` |
| 31 | `apps/api-server/src/tasks/leader-expire.task.ts` |  | 1,799 | `859099988d7d` |
| 32 | `apps/api-server/test/unit/order-state-machine.spec.ts` |  | 1,546 | `fb77b77fb8a4` |
| 33 | `apps/api-server/src/database/entities/withdraw.entity.ts` |  | 4,534 | `680e776f3c30` |
| 34 | `packages/shared-types/src/enums/withdraw-status.ts` |  | 2,335 | `26f7cdd618d1` |
| 35 | `packages/shared-types/src/enums/refund.ts` |  | 1,270 | `64248c8dd16d` |
| 36 | `apps/api-server/src/common/interceptors/idempotent.interceptor.ts` |  | 4,998 | `c57dc09bcaeb` |
| 37 | `apps/api-server/src/modules/finance/commission.service.ts` |  | 13,854 | `83f05e90d5e1` |
| 38 | `apps/api-server/src/modules/finance/withdraw.service.ts` |  | 8,952 | `3dfa71377d4c` |
| 39 | `apps/api-server/src/modules/finance/refund.service.ts` |  | 25,376 | `707820bdffce` |
| 40 | `apps/api-server/src/modules/finance/leader-finance.controller.ts` |  | 3,256 | `9496efa3e87c` |
| 41 | `apps/api-server/src/modules/order/leader-order.service.ts` |  | 14,523 | `54285d5da8e7` |
| 42 | `apps/api-server/src/modules/team-leader/workbench.service.ts` |  | 6,171 | `9dc90864a47e` |
| 43 | `apps/miniprogram/src/api/leader.ts` |  | 13,230 | `77fe3d5433c1` |
| 44 | `apps/miniprogram/src/api/leader-order.ts` |  | 8,757 | `db5668aa60b9` |
| 45 | `apps/miniprogram/src/api/leader-finance.ts` |  | 7,764 | `c25171af33ef` |
| 46 | `apps/miniprogram/src/api/balance.ts` |  | 2,631 | `5ac8fb7da240` |
| 47 | `apps/api-server/src/common/guards/jwt-auth.guard.ts` |  | 3,684 | `f89e03f08c13` |
| 48 | `apps/api-server/src/common/guards/admin.guard.ts` |  | 2,620 | `c49e7801c5e5` |
| 49 | `apps/api-server/src/common/decorators/auth.decorator.ts` |  | 3,650 | `46f10b5df6e7` |
| 50 | `apps/api-server/src/common/constants/admin-role.ts` |  | 5,707 | `db43ce495a12` |
| 51 | `apps/api-server/src/common/decorators/operation-log.decorator.ts` |  | 1,463 | `d9980b6251a1` |
| 52 | `apps/api-server/src/common/interceptors/operation-log.interceptor.ts` |  | 8,065 | `73d818c25b99` |
| 53 | `apps/api-server/src/common/constants/error-code.ts` |  | 16,243 | `962b52d7f2ad` |
| 54 | `apps/admin-web/src/api/request.ts` |  | 4,529 | `739e3e115d78` |
| 55 | `apps/admin-web/src/api/auth.ts` |  | 2,262 | `2341475025f9` |
| 56 | `apps/admin-web/src/router/guards.ts` |  | 2,523 | `47f9d2ab636d` |
| 57 | `apps/api-server/src/modules/meal/meal-admin.service.ts` |  | 32,051 | `3822a99bced4` |
| 58 | `apps/api-server/src/modules/meal/meal-admin.controller.ts` |  | 5,757 | `53b6534a82bf` |
| 59 | `apps/api-server/src/modules/meal/dto/meal-admin.dto.ts` |  | 7,291 | `d26ef850cc4c` |
| 60 | `apps/admin-web/src/api/meal.ts` |  | 7,445 | `4cdc8d32b4d1` |
| 61 | `apps/admin-web/src/views/meal/matrix.vue` |  | 24,092 | `3b02eb0f3548` |
| 62 | `apps/api-server/src/modules/order/order-admin.service.ts` |  | 30,326 | `528f91035164` |
| 63 | `apps/api-server/src/modules/order/order-admin.controller.ts` |  | 5,432 | `6434847ba8cb` |
| 64 | `apps/api-server/src/modules/order/dto/order-admin.dto.ts` |  | 5,629 | `2659c0d826f4` |
| 65 | `apps/api-server/src/modules/finance/reversal.service.ts` |  | 11,985 | `4b3828ac78a9` |
| 66 | `apps/admin-web/src/api/order.ts` |  | 8,547 | `d4706221d804` |
| 67 | `apps/admin-web/src/views/order/list.vue` |  | 17,670 | `06d88e56d646` |
| 68 | `scripts/e2e-m3.mjs` |  | 270,826 | `1414122e9b92` |
| 69 | `apps/api-server/src/modules/finance/refund-admin.service.ts` |  | 12,431 | `c510cc162bb7` |
| 70 | `apps/api-server/src/modules/finance/refund-admin.controller.ts` |  | 4,484 | `a72a21a641c3` |
| 71 | `apps/api-server/src/modules/finance/dto/refund-admin.dto.ts` |  | 3,839 | `afe4177c79ec` |
| 72 | `apps/api-server/src/database/entities/order.entity.ts` |  | 10,801 | `5e644876e5a2` |
| 73 | `apps/admin-web/src/api/finance.ts` |  | 4,787 | `c5415498ec40` |
| 74 | `apps/admin-web/src/views/finance/refund.vue` |  | 18,046 | `aa5bfd754a75` |
| 75 | `apps/admin-web/src/views/order/detail.vue` |  | 23,928 | `5e01adbbf9f5` |
| 76 | `packages/shared-types/src/enums/leader-admin.ts` |  | 1,889 | `ea7f8141c5ef` |
| 77 | `apps/api-server/src/modules/team-leader/leader-admin.service.ts` |  | 39,441 | `30f38c2fd007` |
| 78 | `apps/api-server/src/modules/team-leader/leader-admin.controller.ts` |  | 6,228 | `fb18b4aa296f` |
| 79 | `apps/api-server/src/modules/team-leader/dto/leader-admin.dto.ts` |  | 8,319 | `220a8d77ab08` |
| 80 | `apps/api-server/src/modules/team-leader/team-leader.module.ts` |  | 3,398 | `341de4ad8cb0` |
| 81 | `apps/admin-web/src/api/leader.ts` |  | 8,931 | `24473f928968` |
| 82 | `apps/admin-web/src/views/leader/list.vue` |  | 29,126 | `b2633d3fbdd3` |
| 83 | `apps/admin-web/src/views/leader/apply.vue` |  | 10,891 | `128d34315b92` |
| 84 | `apps/admin-web/src/views/leader/detail.vue` |  | 16,235 | `887411803ae4` |
| 85 | `apps/api-server/src/modules/supplier/supplier-admin.service.ts` |  | 30,857 | `43009bdfc6f5` |
| 86 | `apps/api-server/src/modules/supplier/supplier-admin.controller.ts` |  | 9,296 | `38fd88c0761e` |
| 87 | `apps/api-server/src/modules/supplier/dto/supplier-admin.dto.ts` |  | 17,972 | `5071cae12669` |
| 88 | `apps/api-server/src/modules/supplier/dish/dish-admin.service.ts` |  | 9,974 | `b0d047b334c1` |
| 89 | `apps/api-server/src/modules/supplier/dish/dish-admin.controller.ts` |  | 4,184 | `fa7e1adad641` |
| 90 | `apps/api-server/src/modules/supplier/supplier.module.ts` |  | 2,870 | `4ec4b39beac2` |
| 91 | `apps/api-server/src/modules/distribution-center/distribution-center-admin.service.ts` |  | 16,454 | `826cfef2a6bc` |
| 92 | `apps/api-server/src/modules/distribution-center/distribution-center-admin.controller.ts` |  | 4,377 | `a4cee4e101f8` |
| 93 | `apps/api-server/src/modules/distribution-center/dto/distribution-center-admin.dto.ts` |  | 5,950 | `1812ac36d5ef` |
| 94 | `apps/api-server/src/database/entities/supplier.entity.ts` |  | 12,011 | `ef755161ea24` |
| 95 | `packages/shared-types/src/enums/supplier-admin.ts` |  | 6,140 | `ce91d27b89bd` |
| 96 | `apps/admin-web/src/api/supplier.ts` |  | 12,027 | `ab5132a74725` |
| 97 | `apps/admin-web/src/views/supplier/list.vue` |  | 20,362 | `8c0cdf07a36d` |
| 98 | `apps/admin-web/src/views/supplier/form.vue` |  | 19,295 | `58994ab9bc98` |
| 99 | `apps/admin-web/src/views/supplier/dish-library.vue` |  | 20,889 | `7c541604ca13` |
| 100 | `apps/admin-web/src/views/supplier/distribution-center.vue` |  | 20,812 | `5e36823842fb` |
| 101 | `apps/admin-web/src/views/supplier/takeout-links.vue` |  | 10,919 | `dd41a6ed12b8` |
| 102 | `packages/shared-types/src/enums/building-admin.ts` |  | 5,113 | `9fc8a93f4f2e` |
| 103 | `apps/api-server/src/modules/building/building-admin.service.ts` |  | 46,753 | `f887c1cea2c8` |
| 104 | `apps/api-server/src/modules/building/building-admin.controller.ts` |  | 10,111 | `9c96366f5200` |
| 105 | `apps/api-server/src/modules/building/dto/building-admin.dto.ts` |  | 12,724 | `11c5b670a761` |
| 106 | `apps/api-server/src/modules/building/building.module.ts` |  | 2,280 | `d940ef471158` |
| 107 | `apps/api-server/src/database/entities/building.entity.ts` |  | 3,853 | `c971f3d78e62` |
| 108 | `apps/admin-web/src/api/building.ts` |  | 11,701 | `446ee2063fbb` |
| 109 | `apps/admin-web/src/views/building/overview.vue` |  | 10,824 | `a6d44365e8cd` |
| 110 | `apps/admin-web/src/views/building/list.vue` |  | 18,953 | `3d788c64a5d7` |
| 111 | `apps/admin-web/src/views/building/groups.vue` |  | 15,984 | `edb70213a27d` |
| 112 | `apps/admin-web/src/views/building/leader-binding.vue` |  | 8,687 | `46eacab91f64` |
| 113 | `apps/admin-web/src/views/building/delivery-map.vue` |  | 9,988 | `42d5d0180d80` |
| 114 | `apps/api-server/src/modules/supplier/supplier.service.ts` |  | 34,503 | `b220a6c405e9` |
| 115 | `apps/api-server/src/modules/supplier/supplier.controller.ts` |  | 6,603 | `cc310328af86` |
| 116 | `apps/api-server/src/modules/supplier/dto/supplier.dto.ts` |  | 3,376 | `54e45cd27b2e` |
| 117 | `apps/admin-web/src/api/supplier-portal.ts` |  | 7,990 | `20c37fd16c7a` |
| 118 | `apps/admin-web/src/views/supplier/workbench.vue` |  | 7,547 | `7e7c8e068b49` |
| 119 | `apps/admin-web/src/views/supplier/cook-confirm.vue` |  | 9,094 | `297e2dbcf19b` |
| 120 | `apps/admin-web/src/views/supplier/packing.vue` |  | 7,432 | `e91195dacea2` |
| 121 | `apps/admin-web/src/router/routes.ts` |  | 7,995 | `aebe36923c2a` |
| 122 | `apps/api-server/src/modules/finance/supplier-share.service.ts` |  | 28,987 | `b923d6e54ac2` |
| 123 | `apps/api-server/src/modules/finance/supplier-share-admin.controller.ts` |  | 5,627 | `8592568d8e6f` |
| 124 | `apps/api-server/src/modules/finance/dto/supplier-share.dto.ts` |  | 5,457 | `a1676cf530c8` |
| 125 | `apps/api-server/src/modules/finance/finance.module.ts` |  | 3,902 | `fb7c11c83794` |
| 126 | `apps/api-server/src/tasks/supplier-share.task.ts` |  | 2,372 | `9cae4e69b4c0` |
| 127 | `apps/api-server/src/tasks/tasks.module.ts` |  | 1,500 | `2927a7d5047e` |
| 128 | `apps/admin-web/src/api/supplier-share.ts` |  | 5,757 | `9339efe81a68` |
| 129 | `apps/admin-web/src/views/finance/supplier-share.vue` |  | 16,135 | `38013ed055db` |
| 130 | `apps/admin-web/src/views/supplier/settlement.vue` |  | 6,774 | `86be04d46451` |

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
| 6 | `tests/baseline_manifest.py` | 本清单生成器（基线变更时重跑） | 35,633 | `43a671da65dd` |

---

## 六、冻结与变更规则

1. **只增不改**：基线冻结后，任何文档变更**不得直接改写原文件**，须另出增量版本（如 v2.2），并在「变更记录」中登记。
2. **文档 ↔ 原型同步**：改文档必须同步原型（反之亦然），一致性以《原型审查报告 v1.0》的 29 项清单回归为准。
3. **变更留痕**：所有变更需记录「变更人 / 日期 / 原因 / 影响范围」，并走《协作规范 v1.0》§六 变更流程。
4. **口径冲突仲裁顺序**：交接包 **v1.3**（锁定项 L1–L12、裁决 **C1–C11**）> PRD v2.1 > ER v2.1 > 目录结构 v2.0 > 接口规范 / 状态机 v1.0 > 其它。
5. **代码仓库对应关系**：本清单的 `docs/` 目标位置见《项目目录结构 v2.0》§一；阶段四已生成骨架，执行 `pnpm docs:sync` 即可把根目录文档同步入仓。

---

*文档结束 · ABox 一盒 · 开发基线冻结清单 v1.0 · 2026-09-14*
