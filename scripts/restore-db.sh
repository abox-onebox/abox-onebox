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
SELFTEST=0

# 反引号放进变量再用，避免被 bash 当成命令替换（提交信息里踩过同款）
BT='`'

# ------------------------------------------------------------
# 三个**纯文本**函数：判据只有一份，自证测的就是生产真正执行的那一份
# ------------------------------------------------------------

# 读出「这份备份自己要恢复到哪个库」：mysqldump 头部 `Database:` 与 `USE` 行都写。
# ⚠️ 两种写法都要认：带反引号的 `USE \`db\`;` 与不带的 `USE db;`。
#    只认一种 ⇒ 闸门在另一种写法下形同虚设。
dump_db_from_backup() {
  local f="$1" v=""
  v="$(gunzip -c "$f" 2>/dev/null | head -60 \
        | sed -n 's/.*Database: *`\{0,1\}\([A-Za-z0-9_]*\)`\{0,1\}.*/\1/p' | head -1)"
  [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  gunzip -c "$f" 2>/dev/null | head -80 \
    | sed -n 's/^ *USE *`\{0,1\}\([A-Za-z0-9_]*\)`\{0,1\}.*/\1/p' | head -1
}

# 跨库闸门判据（纯函数 · 零 IO）
#   allow: 0 = 允许 · 1 = 拒绝
#   ⛔ backup_db 为空也**拒绝**：读不出库名就不知道 USE 会指去哪 ⇒ 不许盲导。
gate_cross_db() {
  local backup_db="${1:-}" target_db="${2:-}" force="${3:-0}"
  [ "$force" = 1 ] && return 0
  [ -z "$backup_db" ] && return 1
  [ "$backup_db" = "$target_db" ] && return 0
  return 1
}

# 把导入流里的目标库名改写成新库名（stdin → stdout）
# ⚠️ 改的是**语句**，不是无脑全文替换：只动 CREATE DATABASE / USE / 限定的 `db`.`t`，
#    避免把表名、数据里恰好同名的字符串也改掉。
rewrite_dump_target() {
  local old="$1" new="$2"
  sed \
    -e "s/\(CREATE DATABASE[^;]*\)${BT}${old}${BT}/\1${BT}${new}${BT}/" \
    -e "s/\(CREATE DATABASE[^;]*\)\([ \t]\)${old}\([ \t;]\)/\1\2${BT}${new}${BT}\3/" \
    -e "s/^\([ \t]*[Uu][Ss][Ee][ \t]*\)${BT}${old}${BT}[ \t]*;/\1${BT}${new}${BT};/" \
    -e "s/^\([ \t]*[Uu][Ss][Ee][ \t]*\)${old}[ \t]*;/\1${BT}${new}${BT};/" \
    -e "s/\(Database: *\)${BT}${old}${BT}/\1${BT}${new}${BT}/" \
    -e "s/\(Database: *\)${old}[ \t]*$/\1${new}/" \
    -e "s/database '${old}'/database '${new}'/" \
    -e "s/${BT}${old}${BT}\./${BT}${new}${BT}./g"
}

# 改写后残留检测（纯函数）：流里若**还**出现旧库名 ⇒ 改写不干净 ⇒ 不许导入
rewrite_leftover_count() {
  local f="$1" old="$2" new="$3"
  # ⚠️ 备份是 .gz ⇒ 必须先解压再改写，不能直接 `<"$f"`（那会把二进制喂给 sed）
  #
  # ⭐ 只数**会切库的语句**（USE / CREATE DATABASE），不数整份文件：
  #    数据值里恰好出现库名（比如某行配置里存着库名）是合法的，
  #    按全文计数会误红 —— 误红会让人学会加 --force 绕过，那就等于没闸门。
  #    真正致命的只有「还有一条 USE/CREATE DATABASE 指向旧库」。
  gunzip -c "$f" | rewrite_dump_target "$old" "$new" \
    | grep -E "^[[:space:]]*([Uu][Ss][Ee][[:space:]]|CREATE DATABASE)" \
    | grep -c "${old}" || true
  # ⚠️ `grep -c` 在「0 处」时**退出码是 1** ⇒ 配上 `set -euo pipefail` 会让整条
  #    赋值语句失败、脚本静默退出（表现为「打印两行就没了」）。故必须 `|| true`。
}

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
    --selftest) SELFTEST=1; shift ;;
    --force-cross-db) FORCE_CROSS_DB=1; shift ;;
    -h|--help) sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *) BACKUP_FILE="$1"; shift ;;
  esac
done

# ------------------------------------------------------------
# --selftest：不碰 docker / 不碰数据库，只测上面那三个纯函数
#   必绿 3 个 + 必红 4 个，每个必红**点名必须红的那一条**
#   （⚠️ 匹配必须写成「代号 FAIL」，写成「FAIL 代号」会永远匹配不上
#     ⇒ 必红样本全变成恒绿样本。assert-deploy-boundary.sh 里踩过一次。）
# ------------------------------------------------------------
if [ "$SELFTEST" = 1 ]; then
  # ⚠️ 自证就是要**故意跑出红** ⇒ 必须关掉 `set -e`，
  #    否则第一条必红样本就让脚本在 `out="$(cmd)"` 处退出，后面的样本根本跑不到
  #    （表现是「只打印了几个绿就静默结束」—— 那是自证没跑完，不是通过）。
  set +e
  TD="$(mktemp -d)"
  trap 'rm -rf "$TD"' EXIT
  PROD=abox_onebox
  TMPX=abox_verify_selftest

  # 标准 mysqldump --databases 头部（带反引号）
  {
    echo "-- MySQL dump 10.13  Distrib 8.0.46"
    echo "-- Host: localhost    Database: ${PROD}"
    echo "CREATE DATABASE /*!32312 IF NOT EXISTS*/ \`${PROD}\` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;"
    echo "USE \`${PROD}\`;"
    echo "DROP TABLE IF EXISTS \`ab_user\`;"
    echo "CREATE TABLE \`ab_user\` (\`id\` int NOT NULL);"
    echo "INSERT INTO \`ab_user\` VALUES (1);"
  } | gzip >"$TD/std.sql.gz"

  # 写法二：USE 不带反引号，且**没有** `Database:` 注释行
  { echo "USE ${PROD};"; echo "CREATE TABLE \`ab_user\` (\`id\` int);"; } | gzip >"$TD/bare.sql.gz"

  # 既没有 Database: 也没有 USE（例：--no-create-db 的产物）
  { echo "DROP TABLE IF EXISTS \`ab_user\`;"; echo "CREATE TABLE \`ab_user\` (\`id\` int);"; } \
    | gzip >"$TD/nodef.sql.gz"

  pass=0; fail=0

  # 每个样本跑一条判据，产出形如 `S1  OK  …` / `S1  FAIL  …` 的一行
  run_s() { # run_s <期望 GREEN|RED> <代号> <说明> <样本命令...>
    local want="$1" code="$2" desc="$3"; shift 3
    local out rc=0
    out="$("$@" 2>&1)" || rc=$?
    if [ "$want" = GREEN ]; then
      if [ $rc -eq 0 ]; then
        printf '     OK   必绿 · %s\n' "$desc"; pass=$((pass+1))
      else
        printf '     FAIL 必绿竟然红 · %s\n%s\n' "$desc" "$out"; fail=$((fail+1))
      fi
    else
      # ⚠️ 断言行是「**代号在前**」：`S1  FAIL  …`。
      #    写成 `FAIL  S1` 会永远匹配不上 ⇒ 必红样本全变恒绿样本。
      if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qE "^[[:space:]]*${code}[[:space:]]+FAIL"; then
        printf '     OK   必红 · %s（确由 %s 转红）\n' "$desc" "$code"; pass=$((pass+1))
      else
        printf '     FAIL 必红没红/没由 %s 红 · %s\n%s\n' "$code" "$desc" "$out"; fail=$((fail+1))
      fi
    fi
  }

  # S1：读出备份自带的库名
  s1() { local want="$2" v; v="$(dump_db_from_backup "$1")"
    if [ "${v:-}" = "${want:-}" ] && [ -n "${want:-}" ]; then printf 'S1  OK   读出 %s\n' "$v"; return 0; fi
    printf 'S1  FAIL  读出=%s（期望 %s）\n' "${v:-<空>}" "${want:-<非空>}"; return 1; }
  # S2：跨库闸门（应允许）
  s2allow() { if gate_cross_db "$1" "$2"; then printf 'S2  OK   允许\n'; return 0; fi
    printf 'S2  FAIL  被拒（backup=%s target=%s）\n' "$1" "$2"; return 1; }
  # S3：跨库闸门（应拒绝）
  s2reject() { if gate_cross_db "$1" "$2" "${3:-0}"; then
                 printf 'S2  FAIL  竟然放行（backup=%s target=%s force=%s）\n' "$1" "$2" "${3:-0}"; return 1; fi
    printf 'S2  OK   拒绝\n'; return 0; }
  # S4：改写后残留必须为 0
  s3() { local n; n="$(rewrite_leftover_count "$1" "$2" "$3")"
    if [ "${n:-1}" -eq 0 ]; then printf 'S3  OK   残留 0 处\n'; return 0; fi
    printf 'S3  FAIL  残留 %s 处旧库名\n' "$n"; return 1; }
  # S5：改写后新库名必须真的出现（否则等于没改）
  s4() { local c; c="$(gunzip -c "$1" | rewrite_dump_target "$2" "$3" | grep -c "$3")"
    if [ "${c:-0}" -gt 0 ]; then printf 'S4  OK   新库名出现 %s 次\n' "$c"; return 0; fi
    printf 'S4  FAIL  新库名 0 次出现\n'; return 1; }

  printf '\n[selftest] 临时目录 %s（不连数据库、不需要 docker）\n' "$TD"

  # ---------- 必绿 4 个 ----------
  run_s GREEN S1 "标准 dump（Database: 注释 + 带反引号 USE）读出库名 ${PROD}" \
    s1 "$TD/std.sql.gz" "$PROD"
  run_s GREEN S1 "不带反引号的 USE 语句也要读出库名（只认一种写法 ⇒ 闸门形同虚设）" \
    s1 "$TD/bare.sql.gz" "$PROD"
  run_s GREEN S2 "备份库名 == 目标库名 ⇒ 允许" \
    s2allow "$PROD" "$PROD"
  run_s GREEN S2 "备份库名 != 目标库名 ⇒ 闸门**拒绝**（2026-10-27 事故就是这个形状）" \
    s2reject "$PROD" "some_other_db"
  O3="$(s3 "$TD/std.sql.gz" "$PROD" "$TMPX" 2>&1)"; R3=$?
  O4="$(s4 "$TD/std.sql.gz" "$PROD" "$TMPX" 2>&1)"; R4=$?
  if [ $R3 -eq 0 ] && [ $R4 -eq 0 ]; then
    printf '     OK   必绿 · 改写后残留 0 处 且 新库名已就位（%s / %s）\n' "$O3" "$O4"; pass=$((pass+1))
  else
    printf '     FAIL 必绿竟然红 · 改写不干净\n  S3(rc=%s): %s\n  S4(rc=%s): %s\n' "$R3" "$O3" "$R4" "$O4"; fail=$((fail+1))
  fi

  # ---------- 必红 4 个 ----------
  run_s RED S1 "dump 里既无 Database: 也无 USE ⇒ 读不出库名 ⇒ 红（不许盲导）" \
    s1 "$TD/nodef.sql.gz" ""
  run_s RED S2 "跨库但开了 --force-cross-db ⇒ 竟然放行 ⇒ 红（证明这条断言真能转红，不是恒绿）" \
    s2reject "$PROD" "some_other_db" 1
  run_s RED S3 "新库名写成了旧库名 ⇒ 改写等于没改 ⇒ 残留非 0 ⇒ 红" \
    s3 "$TD/std.sql.gz" "$PROD" "$PROD"
  run_s RED S4 "dump 不指定库（nodef）⇒ 改写后新库名 0 次 ⇒ 红（不能靠改写保证它进临时库）" \
    s4 "$TD/nodef.sql.gz" "$PROD" "$TMPX"

  printf '\n[selftest] 通过 %s / 失败 %s\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
  exit $?
fi

[ -n "$BACKUP_FILE" ] || die "必须指定备份文件，例如：./scripts/restore-db.sh backups/abox-xxx.sql.gz --yes"
[ -f "$BACKUP_FILE" ] || die "备份文件不存在：$BACKUP_FILE"
[ -f "$COMPOSE_FILE" ] || die "缺少 $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE"

# 库名取值与 backup-db.sh 共用同一份口径（真源 = mysql 容器的 MYSQL_DATABASE）。
# ⚠️ 这一处比备份侧**更关键**：这里写错 ⇒ **恢复到错的库**，而且是整库覆盖、不可找回。
#    详见 scripts/lib/db-name.sh 头注 —— **不要**在这里另写一份 grep。
. "$ROOT/scripts/lib/db-name.sh"
DB_NAME="$(abox_db_name "$COMPOSE_FILE" "$ENV_FILE")"

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

  # ⭐ 关键一步：把导入流里的 `旧库名` 改写成临时库名
  #    ⇒ 即便 mysqldump 自带 `USE`，它也只会 USE 到临时库。
  # ⭐ 改写完还要**再数一次残留**：流里若还出现旧库名 ⇒ 改写不干净 ⇒ 拒绝导入。
  #    （只改写不校验的话，一旦 mysqldump 换了写法，这条防线会静默失效。）
  # ⚠️ 同 `rewrite_leftover_count`：`grep -c` 数出 0 时退出码是 1 ⇒ 必须 `|| true`
  LEFTOVER="$(gunzip -c "$BACKUP_FILE" | rewrite_dump_target "$BACKUP_DB" "$TMPDB" | grep -c "${BACKUP_DB}" || true)"
  if [ "${LEFTOVER:-1}" -ne 0 ]; then
    mysql_exec "DROP DATABASE IF EXISTS \`${TMPDB}\`;" 2>/dev/null || true
    die "改写后流里仍残留旧库名 '${BACKUP_DB}' ${LEFTOVER} 处 ⇒ 改写不干净，拒绝导入（已清理临时库）"
  fi
  ok "改写后残留旧库名 = 0 处"

  if gunzip -c "$BACKUP_FILE" | rewrite_dump_target "$BACKUP_DB" "$TMPDB" | mysql_db "$TMPDB"; then
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
