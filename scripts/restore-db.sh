#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 数据库恢复（M5-0）
# ============================================================
#
# 用法：
#   ./scripts/restore-db.sh backups/abox-abox_onebox-20260917T080000Z.sql.gz --yes
#   ./scripts/restore-db.sh <备份文件> --yes --no-pre-backup
#   ./scripts/restore-db.sh <备份文件> --dry-run
#
# ---- ⚠️ 这是破坏性操作 ----
#   `mysqldump --databases` 的产物自带 `DROP TABLE IF EXISTS` + `CREATE TABLE`，
#   灌进去 = **整库覆盖**，目标库现有的数据会被抹掉且**不可找回**（除非有别的备份）。
#   因此：
#     · 必须显式 `--yes` 才执行（缺省只打印「将发生什么」然后退出）
#     · 执行前**自动再备份一次当前库**（万一恢复的备份本身是坏的，还有退路）
#       —— 除非显式 `--no-pre-backup`
#
# ⚠️ 本脚本未在真机执行过（开发机无 Docker，见《部署运维手册》§9）。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"

BACKUP_FILE=""
ASSUME_YES=0
PRE_BACKUP=1
DRY_RUN=0

log() { printf '\n[%s] %s\n' "$1" "$2"; }
ok() { printf '     OK   %s\n' "$1"; }
warn() { printf '     WARN %s\n' "$1"; }
die() { printf '\n[FAIL] %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-pre-backup) PRE_BACKUP=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '5,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *) BACKUP_FILE="$1"; shift ;;
  esac
done

[ -n "$BACKUP_FILE" ] || die "必须指定备份文件，例如：./scripts/restore-db.sh backups/abox-xxx.sql.gz --yes"
[ -f "$BACKUP_FILE" ] || die "备份文件不存在：$BACKUP_FILE"
[ -f "$COMPOSE_FILE" ] || die "缺少 $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE"

DB_NAME="$(grep -E '^DB_DATABASE=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
DB_NAME="${DB_NAME:-abox_onebox}"

log "计划" "把 $BACKUP_FILE 恢复到库 $DB_NAME"
printf '     ⚠️ 这会**整库覆盖**：目标库现有数据将被删除，且不可找回。\n'
printf '     （备份文件自带 DROP TABLE + CREATE TABLE）\n'

if [ "$ASSUME_YES" != 1 ]; then
  printf '\n未指定 --yes，仅做预演、不做任何修改。\n'
  printf '确认要执行时，请重跑并加上 --yes。\n'
  exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
  printf '\n     (dry-run) gunzip -c %s | docker compose ... exec -T mysql mysql -uroot ... %s\n' "$BACKUP_FILE" "$DB_NAME"
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"

# ------------------------------------------------------------
# 1. 恢复前再备份一次当前库（退路）
# ------------------------------------------------------------
log "1/2" "恢复前备份当前库"
if [ "$PRE_BACKUP" = 1 ]; then
  if ./scripts/backup-db.sh; then
    ok "当前库已备份（在 ./backups/）"
  else
    die "恢复前备份失败 —— 拒绝继续（要跳过请显式加 --no-pre-backup）"
  fi
else
  warn "已按 --no-pre-backup 跳过恢复前备份"
fi

# ------------------------------------------------------------
# 2. 灌入
# ------------------------------------------------------------
log "2/2" "恢复数据"
printf '     来源：%s\n     目标：%s\n' "$BACKUP_FILE" "$DB_NAME"

# ⚠️ 管道里任何一段失败都要让整个命令失败：
#    `set -o pipefail` 已在文件头开启，故 gunzip 中途坏掉也会被捕获。
if gunzip -c "$BACKUP_FILE" | docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T mysql \
  sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'; then
  ok "恢复完成"
else
  die "恢复失败 —— 当前库可能处于**半恢复**状态，请立即用 ./backups/ 里刚生成的那份重来一次"
fi

printf '\n[完成] %s 已恢复到 %s\n' "$BACKUP_FILE" "$DB_NAME"
printf '       请立即验证：./scripts/healthcheck.sh 以及后台抽样查单\n'
