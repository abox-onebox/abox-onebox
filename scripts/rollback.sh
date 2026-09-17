#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 回滚（M5-0）
# ============================================================
#
# 用法：
#   ./scripts/rollback.sh                          回滚到 .deploy-state 里的 PREV_TAG
#   ./scripts/rollback.sh --tag v1.2.2             回滚到指定 tag
#   ./scripts/rollback.sh --dry-run                只打印将执行的命令
#   ./scripts/rollback.sh --with-migrate-revert    同时回退**一次**迁移（危险，见下）
#
# ---- ⚠️ 默认不回退数据库迁移 ----
#   `migration:revert` 里的 down() 往往是 drop 列 / drop 表，**不可逆**。
#   而「代码回退 + 表结构留在新版」通常是可接受的：多出来的列不影响旧代码读写
#   （这正是「先迁移、后发码」这套顺序成立的前提）。
#   只有明确知道某次迁移与旧代码不兼容时，才用 --with-migrate-revert ——
#   且它同样**不能找回被 drop 的数据**，只能让结构回到旧形状。
#
# ---- 回滚的前提 ----
#   旧版镜像必须**还在本机**（回滚是一次「用旧 tag 重新起容器」，不重新构建）。
#   ⚠️ 因此：**不要**在生产机上跑 `docker image prune -a`，那会把回滚能力一起删掉。
#   本脚本会先检查镜像是否存在，不存在则明确报错而不是让你等一个 pull 失败。
#
# ⚠️ 本脚本未在真机执行过（开发机无 Docker，见《部署运维手册》§9）。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"
STATE_FILE=".deploy-state"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

TARGET_TAG=""
DRY_RUN=0
WITH_REVERT=0

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

usage() { sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TARGET_TAG="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --with-migrate-revert) WITH_REVERT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------
# 1. 确定回滚目标
# ------------------------------------------------------------
log "1/5" "确定回滚目标"
[ -f "$COMPOSE_FILE" ] || die "缺少 $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE"

CURRENT_TAG=""
if [ -f "$STATE_FILE" ]; then
  CURRENT_TAG="$(grep '^TAG=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
fi

if [ -z "$TARGET_TAG" ]; then
  [ -f "$STATE_FILE" ] || die "无 $STATE_FILE，无法推断回滚目标 —— 请显式指定版本：--tag 版本号"
  TARGET_TAG="$(grep '^PREV_TAG=' "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  [ -n "$TARGET_TAG" ] || die "$STATE_FILE 里没有 PREV_TAG（当前已是首版？）—— 请显式指定版本：--tag 版本号"
fi

[ "$TARGET_TAG" != "$CURRENT_TAG" ] || die "回滚目标与当前版本相同（$TARGET_TAG）"
ok "当前 tag = ${CURRENT_TAG:-未知} → 回滚目标 = $TARGET_TAG"

# ------------------------------------------------------------
# 2. 确认镜像在本地（回滚不重新构建）
# ------------------------------------------------------------
log "2/5" "检查目标镜像是否在本地"
for svc in api admin; do
  img="${REGISTRY:-abox}/${svc}:${TARGET_TAG}"
  if [ "$DRY_RUN" = 1 ]; then
    printf '     (dry-run) docker image inspect %s\n' "$img"
  elif docker image inspect "$img" >/dev/null 2>&1; then
    ok "镜像存在：$img"
  else
    die "本地没有镜像 $img —— 回滚依赖旧镜像仍在机器上。
      · 若刚清理过镜像：只能重新构建该版本（git checkout <旧提交> && ./scripts/deploy.sh --tag $TARGET_TAG）
      · 以后请勿在生产机执行 docker image prune -a"
  fi
done

# ------------------------------------------------------------
# 3. 回滚前备份（把「当前状态」存下来，万一回滚本身有问题可退回）
# ------------------------------------------------------------
log "3/5" "回滚前备份当前数据库"
if [ "$DRY_RUN" = 1 ]; then
  run ./scripts/backup-db.sh --dry-run
elif ./scripts/backup-db.sh; then
  ok "备份完成"
else
  warn "备份失败 —— 确认数据库可达后再继续；若本次回滚只涉及代码，可接受"
fi

# ------------------------------------------------------------
# 4. （可选）回退迁移
# ------------------------------------------------------------
log "4/5" "迁移处理"
if [ "$WITH_REVERT" = 1 ]; then
  warn "--with-migrate-revert 已开启：将执行**一次** migration:revert"
  warn "该操作的 down() 可能 drop 列/表，数据不可找回 —— 已在上一步做过备份"
  compose run --rm --no-deps --entrypoint sh api -c \
    'node node_modules/typeorm/cli.js migration:revert -d apps/api-server/dist/database/data-source.js'
  ok "已回退一次迁移（若需回退多次，请重复执行本脚本）"
else
  ok "跳过（默认不回退迁移：多出的列不影响旧代码，回退反而有丢数据风险）"
fi

# ------------------------------------------------------------
# 5. 用旧镜像重启 + 健康验证
# ------------------------------------------------------------
log "5/5" "以 tag=$TARGET_TAG 重启应用"
if [ "$DRY_RUN" = 1 ]; then
  printf '     (dry-run) TAG=%s docker compose up -d --force-recreate api admin\n' "$TARGET_TAG"
  HEALTHY=1
else
  TAG="$TARGET_TAG" docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate api admin

  HEALTHY=0
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
  warn "回滚后 readiness 仍未 ready —— 排查：docker compose -f $COMPOSE_FILE logs --tail=200 api"
  die "回滚未通过健康验证（target=$TARGET_TAG）"
fi
ok "readiness = ready"

# 更新状态：当前版本 = 回滚目标；把「刚才那一版」记为 PREV_TAG（可再滚回去）
if [ "$DRY_RUN" != 1 ]; then
  {
    printf 'TAG=%s\n' "$TARGET_TAG"
    printf 'PREV_TAG=%s\n' "$CURRENT_TAG"
    printf 'DEPLOYED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'ROLLED_BACK_FROM=%s\n' "$CURRENT_TAG"
  } >"$STATE_FILE"
fi

printf '\n[完成] 已回滚到：tag=%s\n' "$TARGET_TAG"
printf '       验证探针：./scripts/healthcheck.sh\n'
