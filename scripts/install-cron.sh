#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 运维 crontab 安装器（M5-12）
# ============================================================
#
# 用法：
#   ./scripts/install-cron.sh                 安装 / 更新（幂等：先删旧块，再写新块）
#   ./scripts/install-cron.sh --dry-run       只打印**渲染后**的内容，不碰 crontab
#   ./scripts/install-cron.sh --list          打印当前 crontab 里属于本项目的块
#   ./scripts/install-cron.sh --uninstall     从 crontab 里摘掉本项目的块（其余条目不动）
#
# 可用环境变量：ABOX_LOG_DIR（默认 /var/log/abox）· ABOX_REPO（默认脚本所在仓库的绝对路径）
#
# 退出码：0 = 成功 · 1 = 未安装 / 无该块（--list 与 --uninstall 用）· 2 = 用法或环境错误
#
# ## 唯一真相纪律（本脚本的全部理由）
# 服务器上的周期性运维动作**只在 `deploy/cron/abox-ops.cron` 声明一次**，
# 本脚本只做「读模板 → 替换占位符 → 幂等写入 crontab」三件事。
# ⚠️ 本脚本**不自己生成任何 crontab 行** —— 那会在模板之外造出第二份表述，
#    而 crontab 里那份不在任何对账路径上。
# ⚠️ 标记行也**从模板里取**（不在这里硬编码）：硬编码的话，模板改了标记、安装器没改，
#    症状是「旧块删不掉」—— 每装一次多两行，而重复的 cron 任务**不会报错**。
#
# ## 为什么必须是「标记块替换」而不是「追加」
# 追加式安装器每次跑都多两行：跑三次就有三份备份任务，只表现为「磁盘莫名涨得快」
# （且备份文件互相覆盖，谁也没发现）。标记块替换让「安装 N 次」= 「安装 1 次」。
#
# ## ⚠️ 未在真机执行过（如实标注）
# 开发机没有 crontab（Windows / 沙箱），故只做了 `--dry-run` 的渲染验证与 `bash -n`
# 静态检查（见《部署运维手册》§7）。首次上服务器请先 `--dry-run` 核对输出，
# 再执行真安装，然后 `crontab -l` 复核 —— 与 `deploy.sh` 同一纪律。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${ABOX_REPO:-$ROOT}"
LOG_DIR="${ABOX_LOG_DIR:-/var/log/abox}"
TEMPLATE="$ROOT/deploy/cron/abox-ops.cron"

MODE="install"

log() { printf '\n[%s] %s\n' "$1" "$2"; }
ok() { printf '     OK   %s\n' "$1"; }
warn() { printf '     WARN %s\n' "$1"; }
die() {
  printf '\n[FAIL] %s\n' "$1" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry"; shift ;;
    --list) MODE="list"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h | --help) sed -n '5,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

[ -f "$TEMPLATE" ] || die "找不到 crontab 模板：$TEMPLATE（本脚本的全部内容都来自它，不会自己编）"

# ------------------------------------------------------------ 标记行（从模板里取）
BEGIN_MARK="$(grep -m1 '^# >>> ABOX OPS' "$TEMPLATE" || true)"
END_MARK="$(grep -m1 '^# <<< ABOX OPS' "$TEMPLATE" || true)"
[ -n "$BEGIN_MARK" ] || die "模板里找不到起始标记行（须以 '# >>> ABOX OPS' 开头）：$TEMPLATE"
[ -n "$END_MARK" ] || die "模板里找不到结束标记行（须以 '# <<< ABOX OPS' 开头）：$TEMPLATE"
[ "$(grep -c '^# >>> ABOX OPS' "$TEMPLATE")" = "1" ] || die "模板里有多个起始标记行 —— 块边界不唯一，删除操作会误伤无关行"
[ "$(grep -c '^# <<< ABOX OPS' "$TEMPLATE")" = "1" ] || die "模板里有多个结束标记行 —— 同上"

# ------------------------------------------------------------ 渲染
RENDERED="$(sed -e "s|{{ABOX_REPO}}|${REPO}|g" -e "s|{{ABOX_LOG_DIR}}|${LOG_DIR}|g" "$TEMPLATE")"

# ⚠️ 占位符没换干净就必须**停**：crontab 会**原样接受**含 `{{...}}` 的命令行，
#    然后每天定时执行一条 shell 语法错误的命令 —— 表现为「cron 什么都没干」，
#    而 `crontab -l` 看上去完全正常。这是本脚本最容易留下的坑。
if printf '%s\n' "$RENDERED" | grep -q '{{'; then
  printf '%s\n' "$RENDERED" | grep -n '{{' >&2
  die "渲染后仍残留 {{ 占位符（见上）—— 模板新增了占位符但安装器没替换它。不写入 crontab"
fi

# ------------------------------------------------------------ crontab 读写
# ⚠️ 一律用**变量**往返，不用 `cmd | grep -q`：
#    `grep -q` 命中即退出会让上游收 SIGPIPE，配 `set -o pipefail` 时把成功变成失败
#    （「装上了却报错」这种假故障最难查）。`case` 匹配没有这个问题。
CUR="$(crontab -l 2>/dev/null || true)"

has_block() {
  case "$CUR" in
    *"$BEGIN_MARK"*) return 0 ;;
    *) return 1 ;;
  esac
}

strip_block() {
  # 删掉「起始标记 → 结束标记」之间的全部行（含标记行）。
  # 用 `awk` 而不是 `sed '/r1/,/r2/d'`：后者在**有起无终**（上一次安装被打断）
  # 时会一路删到文件末尾 —— 把用户自己的条目一起删掉，且不报错。
  printf '%s\n' "$CUR" | awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    skip != 1 { print }
  '
}

print_block() {
  printf '%s\n' "$RENDERED" | awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    $0 == b { keep = 1 }
    keep == 1 { print }
    $0 == e { keep = 0 }
  '
}

# 命令路径可执行性（**只警告**：安装常在部署之前跑，此刻脚本已入库、但服务器可能还没 chmod）
check_cmd_path() {
  local p="$1"
  if [ ! -f "$p" ]; then
    warn "目标脚本不存在：$p（部署尚未完成？装上去会定时报 command not found）"
  elif [ ! -x "$p" ]; then
    warn "目标脚本不可执行：$p（chmod +x 修复）"
  else
    ok "可执行：$p"
  fi
}

case "$MODE" in
  dry)
    log "预览（--dry-run）" "模板：$TEMPLATE"
    printf '     仓库根：%s\n     日志目录：%s\n' "$REPO" "$LOG_DIR"
    check_cmd_path "$REPO/scripts/ops-daily.sh"
    check_cmd_path "$REPO/scripts/backup-db.sh"
    log "将写入 crontab 的内容" ''
    print_block
    printf '\n（未写入 crontab —— 这是 --dry-run）\n'
    exit 0
    ;;

  list)
    log "当前 crontab" "（只显示本项目块）"
    if has_block; then
      print_block
      exit 0
    fi
    printf '     （未安装：crontab 里找不到起始标记行）\n'
    exit 1
    ;;

  uninstall)
    log "卸载" ''
    if ! has_block; then
      printf '     （未安装，无需卸载）\n'
      exit 1
    fi
    strip_block | crontab -
    ok "已从 crontab 移除本项目块（其余条目未改动）"
    printf '     复核：crontab -l\n'
    exit 0
    ;;

  install | *)
    log "安装" "模板：$TEMPLATE"
    printf '     仓库根：%s\n     日志目录：%s\n' "$REPO" "$LOG_DIR"
    check_cmd_path "$REPO/scripts/ops-daily.sh"
    check_cmd_path "$REPO/scripts/backup-db.sh"

    # 日志目录必须真的存在：cron 重定向 `>> /var/log/abox/x.log` 时若目录不存在，
    # 那行命令整体失败（cron 会往 root 发一封没人看的邮件），巡检结论**一行都不会落盘**。
    mkdir -p "$LOG_DIR" || die "无法创建日志目录：$LOG_DIR（可用 ABOX_LOG_DIR 指定一个可写目录）"
    ok "日志目录就绪：$LOG_DIR"

    if has_block; then
      printf '     已存在旧块 → 先整块删除再写入（幂等）\n'
    fi
    NEW="$(strip_block
    print_block)"
    printf '%s\n' "$NEW" | crontab -

    log "完成" ''
    printf '     当前 crontab（本项目块）：\n\n'
    crontab -l 2>/dev/null | awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
      $0 == b { keep = 1 }
      keep == 1 { print "       " $0 }
      $0 == e { keep = 0 }
    '
    printf '\n     复核建议：crontab -l · 次日检查 %s/ops-daily.log\n' "$LOG_DIR"
    printf '     ⚠️ 首次安装后请**手工跑一次** %s/scripts/ops-daily.sh 并核对输出，\n' "$REPO"
    printf '        再交给 cron —— 与 deploy.sh 同一纪律（不能让机器第一次就跑它）。\n'
    exit 0
    ;;
esac
