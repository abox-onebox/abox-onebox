#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 库名的**唯一取值口径**（供 backup-db.sh / restore-db.sh 共用）
# ============================================================
#
# 用法（在调用方 `source` 之后）：
#   . "$ROOT/scripts/lib/db-name.sh"
#   DB_NAME="$(abox_db_name "$COMPOSE_FILE" "$ENV_FILE")"
#
# ---- 为什么必须抽成一份（2026-10-27 收口）--------------------
#   原先 `backup-db.sh:57` 与 `restore-db.sh:55` **各写一份**，且两份都读同一个错键
#   `DB_OODJXNLK` —— 那是个游离键：compose 用的是 `DB_DATABASE`
#   （`docker-compose.prod.yml:37` `MYSQL_DATABASE: ${DB_DATABASE:-abox_onebox}`
#    与 `:108` api 侧同名），《专家团进场就绪度审计报告》:130 与《账号资源与密钥清单》:286
#    也都把规范名订正为 `DB_DATABASE`。
#
#   两处各写一份的后果**不是重复代码**，而是「改了一处、另一处继续说旧库名」——
#   而库名错了的表现是**恢复到错的库 / 恢复到一个不存在的库**，且**不报错**。
#   这与本项目反复出现的「两处各写一份 ⇒ 必然有一天只改一处」是同一族病灶。
#
# ---- 取值顺序（真源优先，不猜）--------------------------------
#   ① mysql 容器里的 `MYSQL_DATABASE` —— **mysqldump 在容器内用的就是这个变量**，
#      所以以它为准时，「文件名里写的库」不可能与「文件里真正装的库」不一致。
#   ② `$ENV_FILE` 里的 `DB_DATABASE`（容器没起时的回退，例如首次部署前）。
#   ③ 常量 `abox_onebox`（最后的兜底，与 compose 的默认值同源）。
#
# ⚠️ 刻意**不**读 `DB_OODJXNLK`：那不是规范键。谁在 .env 里改了它都无意义。
# ⚠️ 本文件只做「取名字」，不做任何写操作 —— 备份与恢复的破坏性动作归各自脚本。

abox_db_name() {
  local compose_file="$1" env_file="$2"
  local name=''

  # ① 真源：容器里 mysqldump 实际会用的那个值
  if command -v docker >/dev/null 2>&1 && [ -f "$compose_file" ] && [ -f "$env_file" ]; then
    name="$(
      docker compose -f "$compose_file" --env-file "$env_file" exec -T mysql \
        printenv MYSQL_DATABASE 2>/dev/null | tr -d '[:space:]'
    )"
  fi

  # ② 回退：规范键名
  if [ -z "$name" ] && [ -f "$env_file" ]; then
    name="$(grep -E '^DB_DATABASE=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
  fi

  # ③ 兜底常量
  printf '%s' "${name:-abox_onebox}"
}

# shellcheck disable=SC2120
# 供调用方打印「这个值是从哪来的」—— 排障时第一问永远是「它为什么是这个」
abox_db_name_source() {
  local compose_file="$1" env_file="$2"
  if command -v docker >/dev/null 2>&1 && [ -f "$compose_file" ] && [ -f "$env_file" ]; then
    local n
    n="$(docker compose -f "$compose_file" --env-file "$env_file" exec -T mysql printenv MYSQL_DATABASE 2>/dev/null | tr -d '[:space:]')"
    [ -n "$n" ] && { printf 'mysql 容器的 MYSQL_DATABASE（真源）'; return; }
  fi
  if [ -f "$env_file" ] && grep -qE '^DB_DATABASE=.+' "$env_file" 2>/dev/null; then
    printf '%s 的 DB_DATABASE' "$env_file"
    return
  fi
  printf '兜底常量 abox_onebox'
}
