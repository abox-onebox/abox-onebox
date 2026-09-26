# syntax=docker/dockerfile:1
#
# ============================================================
# ABox 一盒 · API 服务镜像（M5-0）
# ============================================================
#
# ⚠️ 构建上下文 = **仓库根**（monorepo），不是 apps/api-server：
#      docker build -f apps/api-server/Dockerfile -t abox-api:<tag> .
#    api-server 依赖 workspace 包 `@abox/shared-types` / `@abox/shared-utils`
#    （package.json 里写的是 `workspace:*`），只给 apps/api-server 会让 pnpm
#    解析不到这两个包。`scripts/deploy.sh` 已按此约定调用。
#
# ⚠️ 本文件**未在真机执行过**（开发机无 Docker，见《部署运维手册 v1.0》§9）。
#    首次上机请按手册 §5「首次部署核对」逐项过一遍。
#
# ⚠️ 首版优先**正确性**而非镜像体积：runner 直接继承 builder 的 `/app`，
#    因此镜像偏大。瘦身（pnpm deploy / 分层裁剪）列为上线后的优化项，
#    不在 M5-0 范围内 —— 先能跑，再变小。
#
# ---- 相对上一版骨架的修正（2026-09-17）--------------------
#   1. `--frozen-lockfile=false` → **`--frozen-lockfile`** 并纳入 pnpm-lock.yaml。
#      旧写法不用锁文件，等于**每次构建装到不同版本**，出了问题无法回滚到
#      「当时那一版依赖」。可复现构建是回滚能力的前提。
#   2. 补 `pnpm run build:shared`：workspace 包不先构建，api-server 的
#      `nest build` 找不到 `@abox/shared-*` 的产物（《协作规范》：先 build:shared）。
#   3. Node 20 → **22**：与本地 / CI(`NODE_VERSION`) 对齐，消除版本漂移。
#   4. 补时区（tzdata + TZ）、HEALTHCHECK、非 root（`USER node`）。
#   5. 运行阶段改为「继承整个 /app 再裁剪」，不再手挑目录 —— pnpm 的
#      node_modules 是符号链接结构，手挑目录会把链接挑断。

# ------------------------------------------------------------
# 阶段 1：构建（装全量依赖 + 编译 TS）
# ------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# 时区：让构建期的日志时间戳也是北京时间。
# ⚠️ 必须装 tzdata，不能只设 ENV TZ —— alpine 默认不带 tz 数据库，
#    只设环境变量时部分路径（Intl / 系统格式化）会静默回退到 UTC。
RUN apk add --no-cache tzdata && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack 按 package.json 的 packageManager 字段（pnpm@9.0.0）取版本，
# 避免「本地 9 / 镜像最新版」的解析差异
RUN corepack enable

# 先只拷清单文件：源码变动不会让「依赖安装」这一层缓存失效
#
# ⚠️ `.npmrc` 必须在这里一起拷，且**必须在 `pnpm install` 之前**：
#    里面的 `shamefully-hoist=true` 决定了 `/app/node_modules/typeorm` 是否存在
#    （typeorm 只声明在 apps/api-server/package.json，不在根 package.json；
#     没有 hoist，pnpm 默认隔离布局下它只会出现在 .pnpm 里）。
#    而 deploy.sh / rollback.sh 的迁移命令正是 `node node_modules/typeorm/cli.js`
#    —— 少了这一行，镜像内该路径不存在，首次部署会在「执行数据库迁移」那一步
#    `Cannot find module` 而中止（deploy.sh 有 set -euo pipefail，会报错，不静默）。
COPY .npmrc ./
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY apps/api-server/package.json apps/api-server/
COPY apps/admin-web/package.json apps/admin-web/
COPY apps/miniprogram/package.json apps/miniprogram/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# 再拷源码并构建
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api-server ./apps/api-server
RUN pnpm run build:shared && pnpm --filter api-server build

# ------------------------------------------------------------
# 阶段 2：运行
# ------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

# 构建版本注入：compose 传 `build.args.APP_VERSION=${TAG}`（通常是 git sha）。
# ⚠️ ARG 只在**声明它的阶段**有效，且默认不进运行时环境 ——
#    必须 ENV 落一次，否则 `GET /health/ready` 永远回显 `dev`，
#    灰度/回滚时就没法用探针确认「现在跑的是哪一版」。
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

RUN apk add --no-cache tzdata && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV APP_PORT=3000

# 继承构建产物与依赖（首版不做瘦身，见文件头说明）
COPY --from=builder /app /app

# 裁掉运行时用不到的兄弟应用与后端源码（源码在镜像里是多余面）
RUN rm -rf /app/apps/miniprogram /app/apps/admin-web /app/apps/api-server/src

# 上传目录（STORAGE_DRIVER=local 时落盘；生产通常走 COS，但这里让两种模式都能起）
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

# ⚠️ 非 root 运行（最小权限）。node 镜像自带 uid=1000 的 node 用户。
USER node

EXPOSE 3000

# 探活用 **liveness**（/health，不检依赖）：
#   · 依赖故障不该让 Docker 判 unhealthy —— 那是 readiness 的职责，混用会引发重启风暴
#   · 用 node 内置 fetch，避免为一次探活往镜像里塞 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ⚠️ 必须用 **exec 形式**（JSON 数组）：`CMD node …` 的 shell 形式会套一层
#    `/bin/sh -c`，sh 会成为 PID 1 并**吞掉 SIGTERM**，于是
#    `app.enableShutdownHooks()` 永远不会被触发（而镜像里看着一切正常）。
#    等价要求在 compose 侧是 `init: true`，两处都别漏。
#
# --enable-source-maps：dist 带 .map，线上堆栈能直接对应 TS 行号
CMD ["node", "--enable-source-maps", "apps/api-server/dist/main.js"]
