# syntax=docker/dockerfile:1
#
# ============================================================
# ABox 一盒 · 运营后台镜像（M5-0）
# ============================================================
#
# ⚠️ 构建上下文 = **仓库根**（同 api-server，原因见其 Dockerfile 头部）：
#      docker build -f apps/admin-web/Dockerfile -t abox-admin:<tag> .
#
# ⚠️ 本文件**未在真机执行过**（开发机无 Docker，见《部署运维手册 v1.0》§9）。
#
# 产物是**纯静态文件**（vite build → dist/），运行期由 nginx 托管，
# 因此运行阶段不含 node —— 后台这套没有服务端逻辑，也不需要健康探针打到自己。

# ------------------------------------------------------------
# 阶段 1：构建
# ------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ⚠️ 这里**刻意不装** `python3 make g++`（2026-10-30 定）：
#    那套工具链是给 `better-sqlite3` 兜底的 —— 它的 postinstall 是
#    `prebuild-install || node-gyp rebuild`，前者从 GitHub releases 下预编译二进制、
#    国内常下不到，回退源码编译就要 python3/make/g++。
#
#    但 better-sqlite3 是 **api-server** 的依赖，admin 打包根本用不到它 ——
#    故本文件改为 `pnpm install --filter`（只装 admin-web 及其依赖的 workspace 包），
#    从**源头不装**它，比「装了再想办法编译过去」更快也更稳：
#    apk 装这套工具链在真机上实测 > 20 分钟且会卡在 gcc，纯属白白拖慢发布。
#    api 侧仍需要它，故 `apps/api-server/Dockerfile` **保留**那行（那里没有省事的路）。

RUN corepack enable

# 先只拷清单文件（同 api-server：让依赖层缓存不被源码变动打掉）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY apps/api-server/package.json apps/api-server/
COPY apps/admin-web/package.json apps/admin-web/
COPY apps/miniprogram/package.json apps/miniprogram/

# ⚠️ 必须拷 scripts/：根 package.json 的 `prepare` = `node scripts/setup-husky.mjs`，
#    不拷会在 node 解析阶段就「Cannot find module」崩掉（脚本内部的 try/catch 兜不住），
#    导致 pnpm install 非零退出。脚本本身在非 git 环境下是 warn + 退出 0，拷进来即安全。
COPY scripts ./scripts

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "admin-web..."

# ⚠️ `--filter "admin-web..."` 里的 `...` = 「admin-web **及其依赖的** workspace 包」
#    （即 packages/shared-*），一个点都不能少：
#      · 少了 `...` ⇒ shared-types / shared-utils 不装 ⇒ 后面 `vue-tsc` 解析不到
#        `@abox/shared-*`，构建在类型检查那一步崩；
#      · 用错包名（如写 `@abox/admin-web`）⇒ filter 命中 0 个项目，pnpm 装了个寂寞。
#    ⚠️ 它同时带来一个**副作用**（正是我们要的）：api-server 的依赖（含 better-sqlite3）
#       不在本次安装范围内 ⇒ 不需要编译工具链。若哪天 admin 真的依赖了 api-server 的包，
#       请把 `apps/api-server/Dockerfile` 那套工具链也搬过来。

# ⚠️ admin-web 的 build = `vue-tsc --noEmit && vite build` —— **类型错误会阻断构建**，
#    这是刻意的：后台是高权限面，宁可发不出去也不要带类型错误的产物上线。
#    也因此必须先把 workspace 包构建出来，否则 vue-tsc 解析不到 @abox/shared-*。
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/admin-web ./apps/admin-web
RUN pnpm run build:shared && pnpm --filter admin-web build

# ------------------------------------------------------------
# 阶段 2：运行（nginx 托管静态产物）
# ------------------------------------------------------------
FROM nginx:1.27-alpine AS runner

# 站点配置（SPA fallback + 静态缓存策略 + /api 反代）见同目录 nginx.conf
COPY apps/admin-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/admin-web/dist /usr/share/nginx/html

# ⚠️ 不用 nginx 官方镜像自带的 healthcheck（它只 ensure 端口能连），
#    这里探的是「产物真的在」—— 发布成空目录时端口照样能连。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
