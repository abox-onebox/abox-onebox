#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 数据库恢复（M5-0）
# ============================================================
#
# 用法：
#   ./scripts/restore-db.sh backups/abox-abox_onebox-20260917T080000Z.sql.gz --yes
#   ./scripts/restore-db.sh <备份文件> --yes --no-pre-backup
#   ./scripts/restore-db.sh <备份文件> --dry-run
#   ./scripts/restore-db.sh <备份文件> --verify-only      # **只验可还原，绝不碰生产库**
#
# ---- ⚠️ 这是破坏性操作 ----
#   `mysqldump --databases` 的产物自带 `DROP TABLE IF EXISTS` + `CREATE TABLE`，
#   灌进去 = **整库覆盖**，目标库现有的数据会被抹掉且**不可找回**（除非有别的备份）。
#   因此：
#     · 必须显式 `--yes` 才执行（缺省只打印「将发生什么」然后退出）
#     · 执行前**自动再备份一次当前库**（万一恢复的备份本身是坏的，还有退路）
#       —— 除非显式 `--no-pre-backup`
#
# ---- ⛔ mysqldump 产物自带 `USE`，「指定默认库」对它无效（2026-10-27 血的教训）----
#   备份文件里是这样两行：
#       CREATE DATABASE IF NOT EXISTS `abox_onebox` ...;
#       USE `abox_onebox`;
#   ⇒ 无论你在 mysql 命令行上把默认库指定成什么，`USE` 都会**把它顶掉**，
#     后面所有 DROP/CREATE/INSERT 全部落在 `USE` 指的那个库上。
#
#   2026-10-27 实战踩到：本想「导进临时库验证可还原」，执行
#       zcat 备份.sql.gz | docker exec -i mysql mysql <临时库名>
#   结果 36 张表的 DROP+CREATE 全部打在**生产库**上，生产库被回退到旧快照
#   （`commission.min_withdraw` 从 0.00 变回 10.00）。
#
#   ⇒ 两条硬规则：
#     1. 正常恢复：本脚本会**先把备份里的库名读出来**与生产库名比对，
#        不一致就**拒绝执行**（不许靠人记得），除非显式 `--force-cross-db`。
#     2. 想验证「备份能不能还原」而**不想动生产库** ⇒ 用 `--verify-only`。
#        它会建一个 `abox_verify_<时间戳>` 临时库、把 `USE` 改写成临时库名后导入、
#        数出表数与行数、**再删掉临时库**。它**不可能**碰到生产库
#        （导入流里已无生产库名）。
#
# ⚠️ 本脚本未在真机执行过（开发机无 Docker，见《部署运维手册》§9）；
#    `--verify-only` 已于 2026-10-27 在生产机实跑（见下）。
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
VERIFY_ONLY=0
FORCE_CROSS_DB=0

# 反引号放进变量再用，避免被 bash 当成命令替换（提交信息里踩过同款）
BT='`'

log() { printf '\n[%s] %s\n' "$1" "$2"; }
ok() { printf '     OK   %s\n' "$1"; }
warn() { printf '     WARN %s\n' "$1"; }
die() { printf '\n[FAIL] %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-pre-backup) PRE_BACKUP=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --force-cross-db) FORCE_CROSS_DB=1; shift ;;
    -h|--help) sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *) BACKUP_FILE="$1"; shift ;;
  esac
done

[ -n "$BACKUP_FILE" ] || die "必须指定备份文件，例如：./scripts/restore-db.sh backups/abox-xxx.sql.gz --yes"
[ -f "$BACKUP_FILE" ] || die "备份文件不存在：$BACKUP_FILE"
[ -f "$COMPOSE_FILE" ] || die "缺少 $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE"

# 库名取值与 backup-db.sh 共用同一份口径（真源 = mysql 容器的 MYSQL_DATABASE）。
# ⚠️ 这一处比备份侧**更关键**：这里写错 ⇒ **恢复到错的库**，而且是整库覆盖、不可找回。
#    详见 scripts/lib/db-name.sh 头注 —— **不要**在这里另写一份 grep。
. "$ROOT/scripts/lib/db-name.sh"
DB_NAME="$(abox_db_name "$COMPOSE_FILE" "$ENV_FILE")"

# ------------------------------------------------------------
# 读出「这份备份自己要恢复到哪个库」—— mysqldump 头部与 `USE` 行都会写
# ------------------------------------------------------------
dump_db_from_backup() {
  local f="$1" v=""
  v="$(gunzip -c "$f" 2>/dev/null | head -60 \
        | sed -n 's/.*Database: *`\{0,1\}\([A-Za-z0-9_]*\)`\{0,1\}.*/\1/p' | head -1)"
  [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  gunzip -c "$f" 2>/dev/null | head -80 \
    | sed -n 's/^ *USE *`\{0,1\}\([A-Za-z0-9_]*\)`\{0,1\}.*/\1/p' | head -1
}
BACKUP_DB="$(dump_db_from_backup "$BACKUP_FILE")"

# ------------------------------------------------------------
# --verify-only：只验「备份能不能还原」，**绝不碰生产库**
# ------------------------------------------------------------
if [ "$VERIFY_ONLY" = 1 ]; then
  command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
  [ -n "$BACKUP_DB" ] || die "读不出备份里的库名，无法改写 USE —— 拒绝盲导（见脚本头注的 `USE` 事故）"
  TMPDB="abox_verify_$(date -u +%Y%m%dT%H%M%SZ)"
  log "verify-only" "临时库 $TMPDB（生产库 $DB_NAME **全程不动**）"
  printf '     备份自带库名：%s ⇒ 导入流里会改写成 %s\n' "$BACKUP_DB" "$TMPDB"

  mysql_exec() {
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T mysql \
      sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$1"' _ "$1"
  }
  mysql_db() {
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T mysql \
      sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$1"' _ "$1"
  }

  mysql_exec "CREATE DATABASE \`${TMPDB}\` DEFAULT CHARACTER SET utf8mb4;" 2>/dev/null \
    || die "建临时库失败（$TMPDB）"

  # ⭐ 关键一步：把导入流里的 `旧库名` 全部改写成临时库名
  #    ⇒ 即便 mysqldump 自带 `USE`，它也只会 USE 到临时库；生产库名在流里已不存在。
  if gunzip -c "$BACKUP_FILE" \
      | sed -e "s/${BT}${BACKUP_DB}${BT}/${BT}${TMPDB}${BT}/g" \
      | mysql_db "$TMPDB"; then
    ok "导入完成"
  else
    mysql_exec "DROP DATABASE IF EXISTS \`${TMPDB}\`;" 2>/dev/null || true
    die "导入失败，临时库已清理"
  fi

  echo
  echo "--- 校验（都来自临时库 $TMPDB）---"
  TABLES="$(mysql_exec "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TMPDB}';" 2>/dev/null | tail -1)"
  echo "  表数          = ${TABLES}"
  # ⭐ fail-closed：0 张表就是「导入根本没进这个库」的信号 —— 2026-10-27 那次
  #    就是靠这个数（=0）才发现的，别让它悄悄过去。
  [ "${TABLES:-0}" -gt 0 ] || {
    mysql_exec "DROP DATABASE IF EXISTS \`${TMPDB}\`;" 2>/dev/null || true
    die "临时库里 **0 张表** ⇒ 导入没有落到目标库（多半是 `USE` 没改写干净）。已清理临时库。"
  }
  mysql_exec "SELECT table_schema AS db, COUNT(*) AS cols FROM information_schema.columns WHERE table_schema='${TMPDB}' GROUP BY table_schema;" 2>/dev/null
  echo "  ab_user 行数   = $(mysql_exec "SELECT COUNT(*) FROM \`${TMPDB}\`.ab_user;" 2>/dev/null | tail -1)"
  echo "  ab_order 行数  = $(mysql_exec "SELECT COUNT(*) FROM \`${TMPDB}\`.ab_order;" 2>/dev/null | tail -1)"
  echo "  min_withdraw   = $(mysql_exec "SELECT CONCAT(config_value,' / ',description) FROM \`${TMPDB}\`.ab_config WHERE config_key='commission.min_withdraw';" 2>/dev/null | tail -1)"

  mysql_exec "DROP DATABASE \`${TMPDB}\`;" 2>/dev/null || warn "临时库删除失败，请手工 DROP DATABASE $TMPDB"
  ok "临时库已删除：$TMPDB"
  printf '\n[完成] 备份**可还原**（表 %s 张）；生产库 %s 未被改动。\n' "$TABLES" "$DB_NAME"
  exit 0
fi

# ------------------------------------------------------------
# ⛔ 跨库闸门：备份自带的库名 与 生产库名 不一致 ⇒ 拒绝
# ------------------------------------------------------------
if [ -n "$BACKUP_DB" ] && [ "$BACKUP_DB" != "$DB_NAME" ] && [ "$FORCE_CROSS_DB" != 1 ]; then
  die "这份备份自带的库名是 '${BACKUP_DB}'，而生产库是 '${DB_NAME}' —— 不一致。
       mysqldump 产物里的 \`USE \\\`${BACKUP_DB}\\\`\` 会顶掉你指定的默认库
       （2026-10-27 就因此把生产库覆盖了）。
       确认要跨库恢复请显式加 --force-cross-db；
       只想验证「能不能还原」请用 --verify-only（它建临时库，绝不碰生产库）。"
fi

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
