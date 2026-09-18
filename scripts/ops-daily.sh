#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 运维日巡检（M5-12）
# ============================================================
#
# 用法：
#   ./scripts/ops-daily.sh                        完整日巡检（探针 + 备份新鲜度 + 磁盘余量）
#   ./scripts/ops-daily.sh --url http://127.0.0.1:8080/api/v1
#                                                 指定 API 基址（不从容器内探测）
#   ./scripts/ops-daily.sh --skip-backup          跳过备份新鲜度检查
#   ./scripts/ops-daily.sh --skip-disk            跳过磁盘余量检查
#   ./scripts/ops-daily.sh --help
#
# 退出码：**0 = 通过（允许有 WARN）· 1 = 有 FAIL · 2 = 用法或环境错误**
#   ⚠️ 这个语义是刻意的：cron / 监控只需要看**退出码**就知道「今天要不要人管」，
#      不需要去解析日志文本（解析文本的告警会在文案改动那天静默失效）。
#      WARN 不置 1 的理由：WARN 全是「还没到不可用、但有趋势」的项（如磁盘余量偏低），
#      让它们报警会把真正的 FAIL 淹没（告警疲劳的直接来源）。
#
# ## 为什么需要它（而不是「每天手工跑一次 healthcheck.sh」）
# `healthcheck.sh` 只回答**一个问题**：服务现在活不活。
# 而「昨晚到底跑成了没有」需要看三件事，缺一个都会给出**看起来正常**的结论：
#   ① 探针两级（liveness / readiness）—— 进程活着 ≠ 依赖通、消费者齐
#   ② 备份新鲜度 —— 备份脚本失败是**静默**的（cron 里那行照样退出 0，
#      只要 `backup-db.sh` 自己没报错），而「昨晚没备份」要到**需要恢复的那天**才发现
#   ③ 磁盘余量 —— 磁盘满了以后**第一个坏的不是服务而是 MySQL 的写入**，
#      表现为偶发 500 而非宕机，最容易查错方向
# 三者都过才敢说「昨天是好的」。本脚本把它们收成**一个退出码**。
#
# ## ⚠️ 未在真机执行过（如实标注）
# 开发机无 Docker、也没有 `.env.prod`（见《部署运维手册》§9 遗留风险），
# 故本脚本的**容器内探测路径**只做过静态审查（`bash -n` + 失败路径实测）。
# 首次上服务器时请**先手工跑一次**并核对输出，再交给 cron —— 与 `deploy.sh` 同一纪律。
#
# ## 与其它脚本的关系（不要重复实现）
#   · 探针：**委托** `scripts/healthcheck.sh`（它已实现「容器内 / 网关侧」两种探测方式
#     与退出码 0/1/2）。本脚本不重写第二套探测逻辑 —— 两套必然有一天只改一处。
#   · 备份：**只检查产物**（目录里最新备份的年龄），不触发备份。
#     备份由 cron 的 05:00 那一行负责（见 `deploy/cron/abox-ops.cron`）。
#   · 磁盘：只读 `df`，不做清理（清理是人的决定）。
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_URL="${ABOX_API_URL:-}"
LOG_DIR="${ABOX_LOG_DIR:-/var/log/abox}"
BACKUP_DIR="${ABOX_BACKUP_DIR:-$ROOT/backups}"
# 26 小时（而不是 24）：给「05:00 备份、08:30 巡检」这条链留出抖动余量；
# 卡到 24 小时整会让一次晚点 10 分钟的备份在次日巡检里变成 FAIL（假红会教会人忽略它）。
BACKUP_MAX_AGE_H="${ABOX_BACKUP_MAX_AGE_H:-26}"
DISK_MIN_FREE_PCT="${ABOX_DISK_MIN_FREE_PCT:-15}"

SKIP_BACKUP=0
SKIP_DISK=0

FAILS=0
WARNS=0

sep() { printf '%s\n' '────────────────────────────────────────────────────────'; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }
ok() { printf '     OK   %s\n' "$1"; }
warn() {
  printf '     WARN %s\n' "$1"
  WARNS=$((WARNS + 1))
}
bad() {
  printf '     FAIL %s\n' "$1" >&2
  FAILS=$((FAILS + 1))
}
die() {
  printf '\n[FAIL] %s\n' "$1" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) API_URL="${2:-}"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --skip-disk) SKIP_DISK=1; shift ;;
    -h | --help) sed -n '5,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

case "$BACKUP_MAX_AGE_H" in '' | *[!0-9]*) die "ABOX_BACKUP_MAX_AGE_H 必须是整数小时（收到：$BACKUP_MAX_AGE_H）" ;; esac
case "$DISK_MIN_FREE_PCT" in '' | *[!0-9]*) die "ABOX_DISK_MIN_FREE_PCT 必须是整数百分比（收到：$DISK_MIN_FREE_PCT）" ;; esac

sep
printf 'ABox 一盒 · 运维日巡检   %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
printf '仓库根：%s\n' "$ROOT"
sep

# ============================================================
# ① 探针（两级）
# ============================================================
# ⚠️ 两级必须**分别**跑：readiness 天然包含 liveness 的语义时也一样 ——
#    「进程不答」与「进程答了但依赖不通」的处置动作完全不同
#    （前者重启容器、后者摘流量 / 查依赖），报成一个数就丢了处置依据。
step 1 "探针（两级）"

# ⚠️⚠️ **必须显式清掉代理环境变量**（`http_proxy` / `https_proxy` / `ALL_PROXY` …）。
#
# `curl` 默认尊重这些变量，于是「探测 http://127.0.0.1:8080/api/v1/health」会变成
# 「探测 http://<代理主机>:<端口>」，而**探针脚本从输出上看不出这件事**：
# 代理对连不上的上游会回 `502 upstream connect failed`，与本机服务真的挂了**长得一模一样**。
# 本项目实测踩到过：开发机上 `http_proxy=http://127.0.0.1:1907` 已设，
# 探针打一个**确实在监听**的本地端口，返回的却是代理的 502 ——
# 若这是巡检，它会每天报「服务不可用」，而人排查半天服务一直是好的（告警疲劳的直接来源）。
#
# 为什么在**本脚本**里清、而不是改 `healthcheck.sh`：后者也可能被用来探测
# 网关侧的外网域名（那时代理可能反而是需要的）。「探针不许过代理」是本巡检的判据，
# 故由本脚本承担；`healthcheck.sh` 保持它已有的两档语义不变。
CURL_ENV_STRIP=(env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy)

probe() {
  local label="$1"
  shift
  local out rc
  local hc=("$ROOT/scripts/healthcheck.sh")
  if [ -n "$API_URL" ]; then
    hc+=(--url "$API_URL")
  fi
  hc+=("$@")
  out="$("${CURL_ENV_STRIP[@]}" "${hc[@]}" 2>&1)"
  rc=$?
  printf '%s\n' "$out" | sed 's/^/       /'
  if [ "$rc" -eq 0 ]; then
    ok "$label 通过"
  elif [ "$rc" -eq 2 ]; then
    bad "$label 无法执行（用法/环境错误，退出码 2）—— 排查：$([ -n "$API_URL" ] && echo '宿主是否装了 curl / 地址是否可达' || echo '是否有 docker 与 .env.prod')"
  else
    bad "$label 未通过（退出码 1）—— 服务现在不可用，先按《部署运维手册》§8 应急处置"
  fi
}

probe "liveness（/health · 判「要不要重启容器」）" --liveness
probe "readiness（/health/ready · 判「要不要摘流量」）"

# ============================================================
# ② 备份新鲜度
# ============================================================
# ⚠️ 判据是**产物的年龄**，不是「备份脚本有没有报错」。
#    cron 那行只要脚本自己退出 0，cron 就认为成功；而「文件其实没写出来」
#    （磁盘满、权限错、mysqldump 版本不兼容但不报错）在退出码上看不出来。
#    检查产物是唯一与「真有一份可恢复的东西」等价的判据。
step 2 "备份新鲜度（阈值 ${BACKUP_MAX_AGE_H}h）"

if [ "$SKIP_BACKUP" -eq 1 ]; then
  warn "已按参数跳过备份检查（--skip-backup）—— 本次结论**不覆盖**「昨晚有没有备份」"
elif [ ! -d "$BACKUP_DIR" ]; then
  bad "备份目录不存在：$BACKUP_DIR —— 说明备份**从来没有成功过**（或路径未配置）。可用 ABOX_BACKUP_DIR 指定"
else
  newest="$(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.sql' -o -name '*.sql.gz' \) -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)"
  if [ -z "$newest" ]; then
    bad "备份目录里没有任何 .sql / .sql.gz：$BACKUP_DIR —— 目录在、产物不在（同 #71/#72 的形态：流程走完了，东西没落地）"
  else
    # ⚠️ 用 `-mmin`（分钟）而不是 `-newermt "-26 hours"`：后者依赖 `date` 对相对时间串的解析，
    #    在精简镜像（busybox date）里行为不一致 —— 一个**巡检脚本**不该在容器里解析日期串。
    newer_than_h="$(find "$BACKUP_DIR" -maxdepth 1 -type f -mmin "-$((BACKUP_MAX_AGE_H * 60))" \( -name '*.sql' -o -name '*.sql.gz' \) 2>/dev/null | head -n 1)"
    size="$(wc -c <"$newest" | tr -d ' ')"
    if [ -n "$newer_than_h" ]; then
      ok "最新备份 $newest（${size} 字节 · ${BACKUP_MAX_AGE_H}h 内）"
      # 空导出是备份最阴的失败形态：文件在、时间新、大小 0 —— 恢复时才知道是空的
      if [ "$size" -lt 1024 ]; then
        bad "最新备份只有 ${size} 字节 —— 这几乎肯定是**空导出**（备份脚本自带 size 检查，但那只管它自己那一次；手工或外部产物不受它管）"
      fi
    else
      bad "最新备份是 $newest，但已超过 ${BACKUP_MAX_AGE_H} 小时 —— 昨晚那一次没成功（检查 $LOG_DIR/backup.log）"
    fi
  fi
fi

# ============================================================
# ③ 磁盘余量
# ============================================================
# ⚠️ 分别检查**两个**挂载点：仓库所在分区（日志/构建产物）与备份目录所在分区
#    （备份常年增长）。两者同分区时只报一次，避免把同一件事说两遍。
step 3 "磁盘余量（阈值 ${DISK_MIN_FREE_PCT}%）"

check_disk() {
  local target="$1" label="$2" line mount total free pct
  [ -d "$target" ] || return 0
  line="$(df -Pk "$target" 2>/dev/null | awk 'NR==2')"
  [ -n "$line" ] || {
    warn "$label：无法读取 df 输出（$target）"
    return 0
  }
  mount="$(printf '%s' "$line" | awk '{print $6}')"
  total="$(printf '%s' "$line" | awk '{print $2}')"
  free="$(printf '%s' "$line" | awk '{print $4}')"
  # ⚠️ 判据必须是**可用百分比**，不是「可用多少 MB」：
  #    固定 MB 阈值在 40G 盘上恒过、在 100G 盘上恒红 —— 两种都等于没有检查。
  if [ "$total" -le 0 ]; then
    warn "$label：df 报出的总容量非法（$total KB）"
    return 0
  fi
  pct=$(((free * 100) / total))
  printf '     %s：挂载点 %s · 可用 %s%%（%s / %s KB）\n' "$label" "$mount" "$pct" "$free" "$total"
  if [ "$pct" -lt "$DISK_MIN_FREE_PCT" ]; then
    bad "$label 可用空间不足 ${DISK_MIN_FREE_PCT}%（挂载点 $mount 当前 ${pct}%）—— 磁盘满的第一个症状通常不是宕机，而是 MySQL 写入偶发失败"
  else
    ok "$label 余量充足（${pct}%）"
  fi
}

if [ "$SKIP_DISK" -eq 1 ]; then
  warn "已按参数跳过磁盘检查（--skip-disk）"
else
  check_disk "$ROOT" "仓库分区"
  # 同分区时 awk 取到的挂载点相同 → 不重复报
  repo_mount="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {print $6}')"
  bak_mount="$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 {print $6}')"
  if [ -n "$bak_mount" ] && [ "$bak_mount" != "$repo_mount" ]; then
    check_disk "$BACKUP_DIR" "备份分区"
  fi
fi

# ============================================================
# 汇总
# ============================================================
sep
if [ "$FAILS" -gt 0 ]; then
  printf '[结果] 未通过：%s 项 FAIL · %s 项 WARN\n' "$FAILS" "$WARNS"
  printf '%s\n' '       排查顺序建议：① 探针 FAIL → 《部署运维手册》§8 应急预案'
  printf '%s\n' '                     ② 备份 FAIL → 先手工跑 ./scripts/backup-db.sh 看真实报错（cron 里看不到它的 stderr）'
  printf '%s\n' '                     ③ 磁盘 FAIL → 先看日志体积（compose 已限 max-size:50m），再考虑清旧备份'
  sep
  exit 1
fi

if [ "$WARNS" -gt 0 ]; then
  printf '[结果] 通过（%s 项 WARN，未到不可用）\n' "$WARNS"
  sep
  exit 0
fi

printf '[结果] 通过\n'
sep
exit 0
