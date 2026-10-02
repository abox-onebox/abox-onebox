# syntax=docker/dockerfile:1
#
# ============================================================
# ABox 一盒 · 用户端 H5 镜像（**人工测试专用**，不是上线形态）
# ============================================================
#
# ⚠️ 构建上下文 = **仓库根**（同 api-server / admin-web，原因见其 Dockerfile 头部）：
#      docker build -f apps/miniprogram/Dockerfile -t abox-h5:<tag> .
#
# ## 为什么单独出一份 H5
#
#   小程序的真机形态（预览 / 体验版）会**校验 request 合法域名** —— 必须 HTTPS + 已备案域名。
#   而域名备案尚未完成，现在只有 `http://IP:端口`，同事异地扫码会被微信直接拦掉。
#
#   H5 是**同一份 uni-app 源码**编出来的网页，手机浏览器直接打开，不走微信域名校验，
#   因此在「备案与 HTTPS 就位之前」是让同事异地参与测试的唯一可行形态。
#
# ## ⚠️⚠️ 两个必须一起成立的构建参数（缺一个就表现为"页面能开、全是空数据"）
#
#   ① `--mode development`
#      `demoMode = MODE !== 'production'`（constants/env.ts）。
#      非 demo 模式下端上走真实 `uni.login`，而 **H5 端没有 uni.login** ⇒ 登录必然失败，
#      拿不到 token ⇒ 所有接口都不发起，页面上只剩"本楼今日未开团"。
#      demo 模式下改用 `dev:<标识>` 登录码（服务端 PROVIDER_MODE=mock 接受），
#      且可用 `?devCode=1002` 让**每个同事一个独立身份**。
#
#   ② `VITE_API_BASE_URL=/api/v1`（同源相对路径）
#      .dockerignore 已排除 `.env` ⇒ 镜像里读不到本地那份绝对地址，不传会落回
#      默认值 `http://localhost:3000/api/v1` —— 那个地址在**用户手机**上不存在。
#      且后端 CORS 是白名单制（main.ts `corsOriginOf`），写绝对地址会被跨域拦掉。
#      ⇒ 由本容器的 nginx 把 `/api/` 反代到 api:3000。
#
# ## ⛔ 安全边界：本产物**禁止用于正式上线**
#
#   development 模式下 `?devCode=任意` 可直接切换成任意用户身份（utils/dev-identity.ts）。
#   正式上线必须改回 `uni build`（production），届时这一段登录链路走真实 uni.login。
#
# ⚠️ 本文件**未在真机执行过**（开发机无 Docker，见《部署运维手册 v1.0》§9）。

# ------------------------------------------------------------
# 阶段 1：构建
# ------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# 先只拷清单文件（同其它端：让依赖层缓存不被源码变动打掉）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY apps/api-server/package.json apps/api-server/
COPY apps/admin-web/package.json apps/admin-web/
COPY apps/miniprogram/package.json apps/miniprogram/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# 只拷 miniprogram 与 workspace 包（不拷 admin-web，省一层上下文）
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/miniprogram ./apps/miniprogram
RUN pnpm run build:shared

# 两个参数见文件头「必须一起成立的构建参数」，不要单独删任何一个
RUN VITE_API_BASE_URL=/api/v1 pnpm --filter miniprogram exec uni build --mode development

# ------------------------------------------------------------
# 阶段 2：运行（nginx 托管静态产物 + 反代 /api）
# ------------------------------------------------------------
FROM nginx:1.27-alpine AS runner

# 站点配置（SPA fallback + 静态缓存策略 + /api 反代）见同目录 nginx.conf
COPY apps/miniprogram/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/miniprogram/dist/build/h5 /usr/share/nginx/html

# 同后台：探的是「产物真的在」，不是端口能连
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
