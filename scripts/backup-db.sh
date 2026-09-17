#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 数据库备份（M5-0）
# ============================================================
#
# 用法：
#   ./scripts/backup-db.sh                  备份到 ./backups/
#   ./scripts/backup-db.sh --out DIR        指定输出目录
#   ./scripts/backup-db.sh --keep 30        保留最近 30 份（默认 14）
#   ./scripts/backup-db.sh --dry-run        只打印将执行的命令
#
# 输出：<out>/abox-<库名>-<UTC 时间戳>.sql.gz
#
# ---- 关键取舍 ----
#   · `--single-transaction`：InnoDB 下拿到**一致性快照**且**不锁表** ——
#     生产库在跑批时段也不能被锁住。不用它就只能停机备份。
#   · 密码走**容器内环境变量**（`-p"$MYSQL_ROOT_PASSWORD"` 在容器里展开），
#     不写进宿主命令行 —— 否则同机任何进程都能从 `ps` 里读到。
#   · 保留策略**只删本目录内、匹配 abox-*.sql.gz 的文件**，绝不宽泛匹配。
#
# ⚠️ 本脚本未在真机执行过（开发机无 Docker，见《部署运维手册》§9）。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"
OUT_DIR="${OUT_DIR:-./backups}"
KEEP=14
DRY_RUN=0

log() { printf '\n[%s] %s\n' "$1" "$2"; }
ok() { printf '     OK   %s\n' "$1"; }
warn() { printf '     WARN %s\n' "$1"; }
die() { printf '\n[FAIL] %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --keep) KEEP="${2:-14}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

case "$KEEP" in
  ''|*[!0-9]*) die "--keep 必须是正整数（收到：$KEEP）" ;;
esac

[ -f "$COMPOSE_FILE" ] || die "缺少 $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_NAME="$(grep -E '^DB_DATABASE=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
DB_NAME="${DB_NAME:-abox_onebox}"
OUT_FILE="${OUT_DIR%/}/abox-${DB_NAME}-${STAMP}.sql"

log "1/3" "导出数据库"
printf '     compose : %s\n     env     : %s\n     database: %s\n     output  : %s.gz\n' \
  "$COMPOSE_FILE" "$ENV_FILE" "$DB_NAME" "$OUT_FILE"

if [ "$DRY_RUN" = 1 ]; then
  printf '     (dry-run) mkdir -p %s\n' "$OUT_DIR"
  printf '     (dry-run) docker compose ... exec -T mysql sh -c %s\n' \
    "'exec mysqldump -uroot -p\"\$MYSQL_ROOT_PASSWORD\" --single-transaction --routines --triggers --databases \"\$MYSQL_DATABASE\"'"
  printf '     (dry-run) gzip -9 %s\n' "$OUT_FILE"
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
mkdir -p "$OUT_DIR"

# ⚠️ 外层用单引号：$MYSQL_* 交给**容器内的 sh** 展开（密码不进宿主命令行）
if ! docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T mysql \
  sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --databases "$MYSQL_DATABASE"' \
  >"$OUT_FILE" 2>"$OUT_DIR/.last-error"; then
  warn "$(tail -3 "$OUT_DIR/.last-error" 2>/dev/null || true)"
  rm -f "$OUT_FILE" "$OUT_DIR/.last-error"
  die "备份失败（常见原因：mysql 容器未启动 / $ENV_FILE 里的库名或口令不对）"
fi
rm -f "$OUT_DIR/.last-error"

# 体积太小 = 多半是空导出（容器起了但库还没建），不当作有效备份
SIZE="$(wc -c <"$OUT_FILE" | tr -d ' ')"
if [ "$SIZE" -lt 1024 ]; then
  rm -f "$OUT_FILE"
  die "导出文件仅 ${SIZE} 字节，判定为无效备份（库可能尚未初始化）"
fi

gzip -9 "$OUT_FILE"
ok "备份完成：${OUT_FILE}.gz（$(wc -c <"${OUT_FILE}.gz" | tr -d ' ') 字节）"

log "2/3" "清理过期备份（保留最近 $KEEP 份）"
# 不用 mapfile（那是 bash 4+ 才有的）：运维脚本要在 mac 自带 bash 3.2 上也能跑。
# 保留策略**只作用于本目录、且只匹配 abox-*.sql.gz**，不做任何宽泛匹配。
OLD_LIST="$(ls -1t "$OUT_DIR"/abox-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" || true)"
if [ -z "$OLD_LIST" ]; then
  ok "无需清理"
else
  printf '%s\n' "$OLD_LIST" | while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '     rm %s\n' "$f"
    rm -f "$f"
  done
  ok "已清理 $(printf '%s\n' "$OLD_LIST" | grep -c .) 份"
fi

log "3/3" "当前备份清单"
ls -1lh "$OUT_DIR"/abox-*.sql.gz 2>/dev/null || printf '     （无）\n'

printf '\n[完成] 备份路径：%s.gz\n' "$OUT_FILE"
printf '       恢复命令：./scripts/restore-db.sh %s.gz --yes\n' "$OUT_FILE"
