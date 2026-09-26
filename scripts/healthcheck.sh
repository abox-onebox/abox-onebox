#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 健康探针查询（M5-0）
# ============================================================
#
# 用法：
#   ./scripts/healthcheck.sh                              从容器内查一次（api 服务）
#   ./scripts/healthcheck.sh --watch 60                   轮询直到 ready 或超时 60s
#   ./scripts/healthcheck.sh --url http://localhost:8080/api/v1
#                                                         改从宿主 / 网关侧探测
#   ./scripts/healthcheck.sh --liveness                   只查存活（不检依赖）
#
# 退出码：0 = 通过（ready / ok）· 1 = 未通过 · 2 = 用法或环境错误
#   ⚠️ 0/1 的区分让它可以**直接进 CI、cron 或监控告警**，不需要解析输出。
#
# 两个探针的区别（《部署运维手册》§7）：
#   /health       · 存活：进程能应答就 ok，**不检依赖** → 判「要不要重启容器」
#   /health/ready · 就绪：DB 通 + 队列消费者齐 → 判「要不要摘流量 / 这次发布算不算成功」
#
# ⚠️ 本脚本未在真机执行过（开发机无 Docker，见《部署运维手册》§9）。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"

PATH_SUFFIX="/health/ready"
URL=""
WATCH_TIMEOUT="${WATCH_TIMEOUT:-0}"
INTERVAL=3

log() { printf '\n[%s] %s\n' "$1" "$2"; }
ok() { printf '     OK   %s\n' "$1"; }
warn() { printf '     WARN %s\n' "$1"; }
die() { printf '\n[FAIL] %s\n' "$1" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --watch) WATCH_TIMEOUT="${2:-60}"; shift 2 ;;
    --interval) INTERVAL="${2:-3}"; shift 2 ;;
    --liveness) PATH_SUFFIX="/health"; shift ;;
    -h|--help) sed -n '5,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

case "$WATCH_TIMEOUT" in ''|*[!0-9]*) die "--watch 必须是整数秒（收到：$WATCH_TIMEOUT）" ;; esac
case "$INTERVAL" in ''|*[!0-9]*) die "--interval 必须是整数秒（收到：$INTERVAL）" ;; esac

# 探测实现：优先用宿主可用的探测方式，没有就落回容器内的 node
probe_once() {
  if [ -n "$URL" ]; then
    full="${URL%/}${PATH_SUFFIX}"
    if command -v curl >/dev/null 2>&1; then
      # ⚠️ `--noproxy '*'` 不可省：宿主若设了 http_proxy / https_proxy，探本机地址会
      #    经代理拿回 502 —— 与「服务真挂了」**同形**，会把环境问题误判成服务故障。
      #    （同款坑见 ops-daily.sh:115 的 `env -u http_proxy` 包法，这里从源头堵住。）
      code="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 5 "$full" || true)"
      body="$(curl -s --noproxy '*' --max-time 5 "$full" || true)"
    else
      printf '     WARN 宿主无 curl，请用 --url 之外的方式（本机自带容器内探测）\n'
      return 1
    fi
    printf '     %s → HTTP %s\n' "$full" "$code"
    printf '     %s\n' "$body"
    [ "$code" = "200" ]
    return
  fi

  if [ ! -f "$COMPOSE_FILE" ] || [ ! -f "$ENV_FILE" ]; then
    die "从容器内探测需要 $COMPOSE_FILE 与 $ENV_FILE；或改用 --url 指定网关地址"
  fi
  command -v docker >/dev/null 2>&1 || die "未找到 docker 命令；或改用 --url 指定网关地址"

  # 用镜像里自带的 node 做探测（不依赖容器里有 curl/wget）
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T api node -e "
    fetch('http://127.0.0.1:3000/api/v1${PATH_SUFFIX}')
      .then(async (r) => { console.log('     HTTP ' + r.status); console.log('     ' + JSON.stringify(await r.json())); process.exit(r.ok ? 0 : 1); })
      .catch((e) => { console.log('     探测失败：' + e.message); process.exit(1); });
  "
}

log "探针" "目标：$([ -n "$URL" ] && printf '%s%s' "${URL%/}" "$PATH_SUFFIX" || printf '容器 api:%s' "$PATH_SUFFIX")"

if [ "$WATCH_TIMEOUT" = 0 ]; then
  if probe_once; then
    printf '\n[结果] 通过\n'
    exit 0
  fi
  printf '\n[结果] 未通过\n'
  exit 1
fi

elapsed=0
while [ "$elapsed" -lt "$WATCH_TIMEOUT" ]; do
  printf '\n  第 %ss / %ss\n' "$elapsed" "$WATCH_TIMEOUT"
  if probe_once; then
    printf '\n[结果] 通过（用时约 %ss）\n' "$elapsed"
    exit 0
  fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

printf '\n[结果] 未通过（已等 %ss）\n' "$WATCH_TIMEOUT"
warn "排查建议：docker compose -f $COMPOSE_FILE logs --tail=200 api"
exit 1
