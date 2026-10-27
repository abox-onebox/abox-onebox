#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 建回滚锚点（上线前必跑）
# ============================================================
#
# 用法：
#   ./scripts/rollback-anchor.sh                 以当前时间建锚点
#   ./scripts/rollback-anchor.sh --label v1.2.3  给锚点一个业务名（推荐：用本次上线版本名）
#   ./scripts/rollback-anchor.sh --dry-run       只打印
#
# 产出（三件套 + 一份清单）：
#   backups/anchor/<stamp>/
#     ├── images.txt        三个镜像的 tag（可直接 docker tag 回去）
#     ├── code.tgz          仓库源码快照（排除 node_modules / backups / .git）
#     ├── abox-<db>.sql.gz  数据库快照
#     ├── conf/             nginx 站点配置 + compose + .env.prod 的**键名清单**（不含值）
#     └── ROLLBACK.md       照抄即可执行的回滚命令
#
# ---- 为什么需要这个脚本（2026-10-27 定）--------------------
#   原回滚链路是坏的，而且是**三处同时坏**，任一处都足以让回滚失效：
#     ① `deploy.sh` 从不 `docker tag`：compose 里写 `${TAG:-latest}`，而 `.env.prod`
#        又钉了 `TAG=latest` ⇒ 每次部署都把 `abox/api:latest` 直接覆盖。
#        `.deploy-state` 里的 `manual-<时间戳>` **从来没有对应过任何真实镜像**。
#     ② `rollback.sh` 于是必然在第 2 步 `die "本地没有镜像"` ⇒ 回滚不出来。
#     ③ 它的错误提示让你 `git checkout <旧提交>`，而**生产机上根本没有 .git**
#        （`/opt/abox-onebox` 不是仓库）⇒ 那条路也不通。
#   本脚本不修那两个脚本，它只保证**锚点本身是真的**：
#   镜像 tag + 源码 + 数据三样都在本机，回滚就不依赖任何外部状态。
#
# ⚠️ 顺序纪律：**先建锚点，再部署**。反过来做，锚点里存的就是坏版本。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"
LABEL=''
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '4,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="${STAMP}${LABEL:+-${LABEL}}"
DIR="backups/anchor/${NAME}"

say() { printf '  %s\n' "$*"; }
run() { if [ "$DRY_RUN" = 1 ]; then printf '  (dry-run) %s\n' "$*"; else "$@"; fi; }

[ -f "$COMPOSE_FILE" ] || { echo "缺少 $COMPOSE_FILE"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "缺少 $ENV_FILE"; exit 1; }

printf '\n[1/4] 记录并固定镜像\n'
if [ "$DRY_RUN" = 0 ]; then mkdir -p "$DIR/conf"; fi
: >"$DIR/images.txt" 2>/dev/null || true
for S in api admin h5; do
  # 取**容器当前实际在跑**的镜像 id —— 这样锚的是「正在服务的东西」，不是 latest 此刻指向哪
  CID="$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q "$S" 2>/dev/null | head -1)"
  if [ -z "$CID" ]; then say "SKIP  $S 容器不在运行"; continue; fi
  IID="$(docker inspect -f '{{.Image}}' "$CID" 2>/dev/null)"
  [ -n "$IID" ] || { say "SKIP  $S 取不到镜像 id"; continue; }
  if [ "$DRY_RUN" = 0 ]; then
    docker tag "$IID" "abox/${S}:anchor-${NAME}" 2>/dev/null
    printf '%s\t%s\t%s\n' "$S" "$IID" "abox/${S}:anchor-${NAME}" >>"$DIR/images.txt"
  fi
  say "OK   $S -> $(printf '%s' "$IID" | cut -c1-19)  tagged abox/${S}:anchor-${NAME}"
done
# mysql / redis 是官方镜像，版本钉在 compose 里，不需要锚 tag，但要记下版本
if [ "$DRY_RUN" = 0 ]; then
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" config --images 2>/dev/null >>"$DIR/images.txt" || true
fi

printf '\n[2/4] 数据库快照\n'
if [ "$DRY_RUN" = 1 ]; then
  say '(dry-run) ./scripts/backup-db.sh'
else
  if OUT_DIR="$DIR" ./scripts/backup-db.sh --keep 7 >/dev/null 2>&1; then
    say "OK   $(ls -1 "$DIR"/abox-*.sql.gz 2>/dev/null | head -1)"
  else
    say 'WARN 数据库导出失败 —— **这一项缺失时，回滚最多只能回到结构，回不到数据**'
  fi
fi

printf '\n[3/4] 源码 + 配置快照\n'
if [ "$DRY_RUN" = 0 ]; then
  # 排除体积大且可从别处重建的东西；**不排除** apps/ 与 packages/（那是重建镜像的真源）
  tar czf "$DIR/code.tgz" \
    --exclude='./node_modules' --exclude='./backups' --exclude='./.git' \
    --exclude='./dist' --exclude='./dist_bak_*' \
    -C "$ROOT" . 2>/dev/null
  say "OK   code.tgz  $(wc -c <"$DIR/code.tgz" | tr -d ' ') 字节"
  cp "$COMPOSE_FILE" "$DIR/conf/" 2>/dev/null
  cp apps/api-server/nginx.conf  "$DIR/conf/" 2>/dev/null
  cp apps/admin-web/nginx.conf   "$DIR/conf/nginx.conf.admin-web" 2>/dev/null
  cp apps/miniprogram/nginx.conf "$DIR/conf/nginx.conf.miniprogram" 2>/dev/null
  # ⚠️ 只存**键名**，绝不存值 —— .env.prod 里有口令，快照一旦外泄就是全量凭据泄露
  grep -oE '^[A-Z0-9_]+' "$ENV_FILE" 2>/dev/null | sort >"$DIR/conf/env-keys.txt"
  say "OK   conf/（含 compose + 两份 nginx.conf + .env.prod **键名清单**，不含值）"
fi

printf '\n[4/4] 生成回滚卡\n'
if [ "$DRY_RUN" = 0 ]; then
  {
    printf '# 回滚卡 · 锚点 %s\n\n' "$NAME"
    printf '建锚时间（UTC）：%s\n' "$STAMP"
    [ -n "$LABEL" ] && printf '业务标签：%s\n' "$LABEL"
    printf '\n'
    printf '> ⚠️ **锚点时效（读这条之前不要动手）**\n'
    printf '> 本锚点录的是**建锚那一刻**的状态。此后任何人改动代码 / nginx 配置 /\n'
    printf '> compose / 业务数据，本锚点**即刻过期** —— 照它回滚会回到一个**不含那些改动**的版本，\n'
    printf '> 且回滚流程本身**不会告诉你它过期了**（镜像能起、探活会绿）。\n'
    printf '>\n'
    printf '> ⇒ **每次部署之前重跑一次 `./scripts/rollback-anchor.sh`，不要用旧锚点。**\n'
    printf '> ⇒ 判断过期的最快办法：拿 `images.txt` 里的镜像 id 跟 `docker ps` 当前在跑的对一下。\n'
    printf '\n## 0. 先看清楚要回到哪\n\n'
    printf '```\ncat %s/images.txt\n```\n\n' "$DIR"
    printf '## 1. 代码回退（镜像级，最快，不需要重新构建）\n\n'
    printf '```\n'
    while IFS=$'\t' read -r S IID TAGN; do
      [ -n "$TAGN" ] && printf 'docker tag %s abox/%s:latest\n' "$TAGN" "$S"
    done <"$DIR/images.txt"
    printf 'docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate api admin h5\n'
    printf '```\n\n'
    printf '## 2. 数据回退（**会覆盖当前全部数据**，只在代码回退后仍不一致时才做）\n\n'
    printf '```\n'
    printf './scripts/restore-db.sh %s/$(ls -1 %s/abox-*.sql.gz | head -1 | xargs -n1 basename) --yes\n' "$DIR" "$DIR"
    printf '```\n\n'
    printf '## 3. 验证（**不跑这个不许收工**）\n\n'
    printf '```\n./scripts/smoke-orders.sh\nABOX_BASE=http://127.0.0.1:8080 ./scripts/smoke-orders.sh\n```\n\n'
    printf '## 4. 源码级重建（镜像也丢了时）\n\n'
    printf '```\n'
    printf 'rm -rf /tmp/abox-restore && mkdir -p /tmp/abox-restore\n'
    printf 'tar xzf %s/code.tgz -C /tmp/abox-restore\n' "$DIR"
    printf 'cd /tmp/abox-restore && docker compose -f docker-compose.prod.yml --env-file .env.prod build api admin h5\n'
    printf '```\n'
    printf '\n> ⚠️ 源码重建需要 pnpm 拉满依赖，耗时以十分钟计。'
    printf '把它留到最后手段 —— 镜像级回退是秒级的。\n'
  } >"$DIR/ROLLBACK.md"
  say "OK   $DIR/ROLLBACK.md"
fi

printf '\n[完成] 锚点：%s\n' "$DIR"
printf '       回滚时照抄：%s/ROLLBACK.md\n' "$DIR"
printf '       ⚠️ 部署**之前**建锚；部署**之后**立刻跑 ./scripts/smoke-orders.sh\n'
