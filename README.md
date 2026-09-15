# ABox 一盒 · Monorepo

> 办公楼白领「团体订餐」平台 —— 每天一栋楼共享一个「一饭四菜」套餐，4 家供应商各出一菜，
> 集散中心打包装箱，货拉拉送到楼下，楼内团长取餐分发；平台赚差价，团长赚佣金。

**4 角色 · 3 载体**：小程序（用户 + 团长同端叠加身份）/ 供应商 Web / 运营后台 Web。

---

## 一、仓库结构

```
abox-onebox/
├── apps/
│   ├── miniprogram/     uni-app 小程序（用户端 P1–P10/P38 + 团长端 P11–P20）
│   ├── admin-web/       Vue3 + Element Plus（运营后台 P27–P37 + 供应商端 P21–P26，按 role 过滤）
│   └── api-server/      NestJS 后端 API（12 模块 + 8 定时任务 + 3 消费者）
├── packages/
│   ├── shared-types/    前后端共享 TS 类型与枚举（订单状态机 / 佣金等级 / 定价）
│   ├── shared-utils/    共享工具（金额 / 时间 / 加密）
│   ├── eslint-config/   共享 ESLint 配置
│   └── tsconfig/        共享 TS 配置
├── docs/                项目文档（唯一事实来源）
├── scripts/             初始化 / 迁移 / 种子 / 部署脚本
└── docker-compose.yml   本地依赖（MySQL 8 + Redis 7）
```

## 二、快速开始

```bash
# 0. 前置：Node >= 20、pnpm >= 9、Docker Desktop
pnpm install
pnpm docker:up          # 起 MySQL + Redis
cp .env.example .env
pnpm db:migrate
pnpm db:seed
pnpm dev:api            # http://localhost:3000/api/v1  Swagger: /docs
pnpm dev:admin          # http://localhost:5173
pnpm dev:mp             # 微信开发者工具导入 apps/miniprogram/dist/dev/mp-weixin
```

Windows 用户可直接用 `pwsh scripts/setup.ps1` 一键完成以上步骤。

## 三、锁定口径（不得擅自变更）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 套餐统一价 | **¥25.80** | C1 |
| 团长佣金 | **8% / 9% / 10% / 12%**（见习/正式/金牌/首席） | C2 |
| 团长资格 | **提交申请即生效**，无人工审核 | C3 |
| 集散中心 | 配置表驱动，**默认 4 个可增删** | C4 |
| 截单 | **T-1 24:00**（关键锚点 1） | L3 |
| 自动确认收货 | **T 日 14:00**（关键锚点 2） | L4 |
| 单份结算 | 供 **¥14.00** + 集散 **¥5.00** + 佣金 **¥3.10** + 毛利 **¥3.70** = **¥25.80** | C9 |
| 结算方式 | 供应商/集散 **日结 · 人工对公转账**（对公账户后置收集）；团长佣金走 **灵活用工平台代发 + 代扣个税** | C11 |
| 截单后退款 | 用户不可自助退 → 团长代退申请 → 后台审批 | C6 |

完整口径见 `docs/ABox一盒MVP优化交接包v1.3.md`。

## 四、本地开发（零依赖模式）

没装 Docker 也能开发：`.env` 里把驱动切成 sqlite + memory + local + mock，
**代码零改动**即可跑通「登录 → 下单 → 支付 → 回调」全链路。

```bash
cp .env.example .env      # DB_DRIVER=sqlite / QUEUE_DRIVER=memory / PROVIDER_MODE=mock
pnpm install
pnpm db:seed
pnpm dev:api              # 登录用 code=dev:1001（首席团长李明）
```

详见 `docs/ABox一盒本地开发手册v1.0.md`。

## 四、协作

提交规范、分支策略、评审规则、DoD 见 `docs/ABox一盒协作规范v1.0.md`。

## 五、文档

`docs/` 为唯一事实来源；`contracts/` 下的常量与 `docs/` 如有冲突，**以 `docs/` 为准**并立刻回改代码。
