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
RUN corepack enable

# 先只拷清单文件（同 api-server：让依赖层缓存不被源码变动打掉）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY apps/api-server/package.json apps/api-server/
COPY apps/admin-web/package.json apps/admin-web/
COPY apps/miniprogram/package.json apps/miniprogram/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

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
