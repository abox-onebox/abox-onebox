#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 部署（M5-0）
# ============================================================
#
# 用法：
#   ./scripts/deploy.sh                     构建 → 备份 → 迁移 → 起服务 → 健康验证
#   ./scripts/deploy.sh --tag v1.2.3        指定镜像 tag（默认 git short sha）
#   ./scripts/deploy.sh --dry-run           只打印将执行的命令，不真的动
#   ./scripts/deploy.sh --build-only        只构建镜像
#   ./scripts/deploy.sh --skip-backup       跳过迁移前备份（不推荐，仅本地演练用）
#
# 回滚：./scripts/rollback.sh
#
# ---- ⛔ 生产变更纪律（2026-10-27 立 · 见《部署运维手册》§4.4）--------
#   任何会打断服务的主动动作（停依赖 / 删数据 / 切配置 / 重启容器）
#   **动之前先报一句**「我要在 X 时刻做 Y，影响面 Z，预计持续 N 秒」，
#   经主理人或项目负责人确认后再执行 —— 哪怕它只要 11 秒。
#   理由：这类动作造成的现象（如「登录全 429」）与真故障**长得一模一样**，
#   不知情的人会顺着错误方向去查一个根本不存在的原因。
#   本脚本在服务器上是**原地执行**的：投递那一步在外面，请确保投递物
#   **只含已提交内容**（`git show <commit>:<path>` / `git archive <commit>`），
#   绝不打包当前工作树 —— 树上可能躺着「本轮不发布」的改动。
#   投递侧**必跑**：`./scripts/assert-deploy-boundary.sh --commit <sha> \
#       --manifest <清单> --artifacts-dir <投递目录>`（六特征 A1–A6，见手册 §4.6）。
#
# ---- ⛔ 禁止手工 `docker restart`（2026-10-27 立 · 见《部署运维手册》§4.5）----
#   生产上**不许** `docker restart <容器>`，也不许 `docker stop` + `docker start` 代替。
#   一律 `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d <service>`。
#   理由：手工 restart **不看 compose 的依赖声明**，`api` 会在 `redis` 还没 healthy
#   时就起来（实测差 31 秒）⇒ 那半分钟里登录全 429 + `RATE_LIMIT_UNAVAILABLE`，
#   现场看起来像限流配错了，真因是启动顺序。
#
# ---- 本脚本相对上一版骨架的修正（2026-09-17）--------------------
#   上一版是占位实现：只 `docker build` 一个 api 镜像，然后 `kubectl set image`
#   打到一个占位 registry（registry.example.com）。三个真问题：
#     1. **完全没跑数据库迁移** —— 发新代码不动表结构，上线后第一个写请求
#        就会炸在「列不存在」上；
#     2. 部署方式与项目编排不一致（项目用 compose，脚本用 kubectl）；
#     3. 无健康验证、无回滚信息、无部署前备份 —— 出事时无路可退。
#   新版按「预检 → 备份 → 迁移 → 起服务 → 健康验证 → 记录可回滚版本」推进。
#
# ---- 失败时为什么不自动回滚 ----
#   `--skip-backup` 之外的情况，迁移可能已经执行。此时把代码回退到旧版、
#   表结构却停在新版，属于**半新半旧**状态 —— 往往比「新版本 + 已知故障」
#   更难判断。故本脚本失败时**打印明确回滚命令并停下**，把决定权交给人
#   （与项目「不做静默降级」的一贯取舍一致）。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"
STATE_FILE=".deploy-state"

TAG=""
DRY_RUN=0
BUILD_ONLY=0
SKIP_BACKUP=0
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

log() { printf '\n[%s] %s\n' "$1" "$2"; }
ok() { printf '     OK   %s\n' "$1"; }
warn() { printf '     WARN %s\n' "$1"; }
die() { printf '\n[FAIL] %s\n' "$1" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '     (dry-run) %s\n' "$*"
  else
    "$@"
  fi
}
compose() { run docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

usage() {
  sed -n '4,12p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --build-only) BUILD_ONLY=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------
# 1. 预检
# ------------------------------------------------------------
log "1/7" "预检"
if [ "$DRY_RUN" != 1 ]; then
  command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
  docker compose version >/dev/null 2>&1 || die "docker compose 不可用（需 Docker 20.10+ / Compose V2）"
fi
[ -f "$COMPOSE_FILE" ] || die "缺少 $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE —— 先 cp .env.example $ENV_FILE 并按《部署运维手册》§4 填生产值"
ok "compose 文件与 $ENV_FILE 就位"

if [ -z "$TAG" ]; then
  TAG="$(git rev-parse --short HEAD 2>/dev/null || echo "manual-$(date +%Y%m%d%H%M%S)")"
fi
ok "镜像 tag = $TAG"

# 记录上一版，供回滚使用
PREV_TAG=""
if [ -f "$STATE_FILE" ]; then
  PREV_TAG="$(grep '^TAG=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  [ -n "$PREV_TAG" ] && ok "上一版 tag = $PREV_TAG（回滚目标）"
else
  warn "无 $STATE_FILE：本次是首次部署，没有可回滚的上一版"
fi

# ------------------------------------------------------------
# 2. 迁移前备份（数据安全网）
# ------------------------------------------------------------
log "2/7" "数据库备份"
if [ "$SKIP_BACKUP" = 1 ]; then
  warn "已按 --skip-backup 跳过（仅在本地演练时可接受）"
elif [ "$DRY_RUN" = 1 ]; then
  run ./scripts/backup-db.sh --dry-run
else
  # 首次部署时 mysql 可能还没起，备份失败不该阻断 —— 但**必须让人看见**
  if ./scripts/backup-db.sh; then
    ok "备份完成"
  else
    warn "备份失败（首次部署且库尚未初始化时属正常）：请人工确认数据库已有可用备份"
  fi
fi

# ------------------------------------------------------------
# 3. 起依赖并等就绪
# ------------------------------------------------------------
log "3/7" "启动依赖（mysql / redis）"
compose up -d mysql redis
if [ "$DRY_RUN" != 1 ]; then
  waited=0
  while [ "$waited" -lt 60 ]; do
    if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps --status running --format '{{.Service}}' 2>/dev/null | grep -q mysql; then
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done
  ok "依赖已启动（等待 healthcheck 转 healthy 由下一步的 compose up 兜住）"
fi

# ------------------------------------------------------------
# 4. 构建镜像
# ------------------------------------------------------------
log "4/7" "构建镜像（api + admin）"

# ⚠️ `.env.prod` 里若钉了 `TAG=latest`，compose 的 `${TAG:-latest}` 就**恒为 latest** ——
#    那么无论本脚本 `--tag` 传什么，产物都只会覆盖 `abox/api:latest`，
#    而 `.deploy-state` 里记的 `manual-<时间戳>` **从来不会成为任何真实镜像的 tag**。
#    后果：`./scripts/rollback.sh` 在第 2 步必死在 `本地没有镜像`，且生产机无 .git，
#    它给的 `git checkout <旧提交>` 也走不通 ⇒ 回滚链路整体失效（2026-10-27 实测）。
#    这里显式补打 $TAG，让 `.deploy-state` 记的那个 tag 真的指向一个本机镜像。
if grep -qE '^TAG=latest\s*$' "$ENV_FILE" 2>/dev/null; then
  warn "$ENV_FILE 里钉了 TAG=latest：产物只会落到 :latest，本脚本已额外补打 $TAG 供回滚"
fi
BUILT_TAG="$(
  grep -E '^TAG=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]'
)"
BUILT_TAG="${BUILT_TAG:-latest}"

compose build --build-arg "APP_VERSION=$TAG" api admin

# 补打可回滚的 tag（h5 不在本脚本构建范围，但它在跑就一并锚上 —— 见回滚卡）
for svc in api admin; do
  if docker image inspect "${REGISTRY:-abox}/${svc}:${BUILT_TAG}" >/dev/null 2>&1; then
    docker tag "${REGISTRY:-abox}/${svc}:${BUILT_TAG}" "${REGISTRY:-abox}/${svc}:${TAG}" 2>/dev/null || true
  fi
done
ok "镜像构建完成：tag=$TAG（另锚 ${REGISTRY:-abox}/{api,admin}:$TAG 供 rollback.sh 使用）"

if [ "$BUILD_ONLY" = 1 ]; then
  log "完成" "--build-only：已停在构建阶段，未部署"
  exit 0
fi

# ------------------------------------------------------------
# 5. 数据库迁移（**必须在起新代码之前**）
# ------------------------------------------------------------
log "5/7" "执行数据库迁移"
# ⚠️ 用 `dist/database/data-source.js`（编译产物）而不是 src 的 .ts：
#    生产镜像里源码已删、也没有 ts-node。data-source 的迁移 glob 已同时匹配
#    .ts/.js（见该文件注释）—— 若只匹配 .ts，这里会输出 "No migrations are found"
#    并**以成功结束**，于是「部署成功但表没更新」。
compose run --rm --no-deps --entrypoint sh api -c \
  'node node_modules/typeorm/cli.js migration:run -d apps/api-server/dist/database/data-source.js'
ok "迁移已执行"

# ------------------------------------------------------------
# 6. 滚动应用
# ------------------------------------------------------------
log "6/7" "启动应用（api / admin）"
compose up -d --force-recreate api admin

# ------------------------------------------------------------
# 7. 健康验证
# ------------------------------------------------------------
log "7/7" "健康验证（readiness，最多 ${HEALTH_TIMEOUT}s）"
HEALTHY=0
if [ "$DRY_RUN" = 1 ]; then
  printf '     (dry-run) 轮询 http://127.0.0.1/api/v1/health/ready\n'
  HEALTHY=1
else
  elapsed=0
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T api \
      node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
fi

if [ "$HEALTHY" != 1 ]; then
  printf '\n'
  warn "readiness 未在 ${HEALTH_TIMEOUT}s 内转 ready"
  warn "排查：docker compose -f $COMPOSE_FILE logs --tail=200 api"
  die "部署未通过健康验证（tag=$TAG）。回滚：./scripts/rollback.sh"
fi
ok "readiness = ready"

# ------------------------------------------------------------
# 写入部署状态（回滚脚本据此找上一版）
# ------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  printf '     (dry-run) 写 %s：TAG=%s PREV_TAG=%s\n' "$STATE_FILE" "$TAG" "$PREV_TAG"
else
  {
    printf 'TAG=%s\n' "$TAG"
    printf 'PREV_TAG=%s\n' "$PREV_TAG"
    printf 'DEPLOYED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$STATE_FILE"
fi

printf '\n[完成] 部署成功：tag=%s\n' "$TAG"
printf '       查看探针：curl -s http://localhost:%s/api/v1/health/ready\n' "${ADMIN_PORT:-8080}"
printf '       回滚命令：./scripts/rollback.sh\n'
