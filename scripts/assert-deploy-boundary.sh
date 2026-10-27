#!/usr/bin/env bash
# ============================================================
# scripts/assert-deploy-boundary.sh —— 投递边界自检（六特征）
# ============================================================
#
# 用法：
#   ./scripts/assert-deploy-boundary.sh \
#       --commit <sha>                 # 本轮部署要用的 commit（必须是已推送的）
#       --manifest <file>              # 交付清单：一行一个仓库内相对路径
#       --artifacts-dir <dir>          # 实际投递出去的那些文件（目录结构与清单一致）
#      [--repo <dir>]                  # 默认当前仓库
#      [--branch main]                 # 远端分支，默认 main
#      [--deny-grep <path>:<regex>]    # 追加一条「本轮不发布」特征（可重复）
#      [--allow-no-artifacts]          # 明确承认「没有交付物可比」（仅本地推演用）
#      [--selftest]                    # 自证：必绿样本 1 个 + 必红样本 7 个
#
# 退出码：0 = 六条全绿；1 = 至少一条红；2 = 用法错误
#
# ---- 为什么要有这个脚本（2026-10-27 立）--------------------
#   「投递边界」= **产物里到底装的是哪个 commit 的内容**。
#   出过的事：后端把 `main.ts`（`bodyParser: false`）与
#   `common/middleware/request-body.middleware.ts` 作为**本轮不发布**的改动
#   留在工作树里，而工作树文件一旦被打包进投递物，就等于**悄悄发布了未提交代码**
#   —— 且它在 dist 里毫无特征可查（编译后两边长得一样）。
#   ⇒ 边界只能**在投递那一刻**证明，事后在服务器上怎么查都补不回来。
#
# ---- 六特征（每条都必须能红，见 --selftest）----------------
#   A1  commit 可解析        —— `git cat-file -e <sha>^{commit}`
#   A2  commit 已推送到远端  —— `ls-remote` 拿到远端 sha，要求相等或是其祖先
#                              （防「本地 ref 骗人」；无 origin / 取不到 ⇒ 红）
#   A3  清单文件都在 commit 里 —— 每个路径 `git rev-parse <sha>:<path>` 必须成功
#   A4  投递物字节 == commit blob —— `git hash-object <投递物>` 必须等于 A3 那个 blob
#                              （不给 --artifacts-dir ⇒ **红**，fail-closed，不许恒绿）
#   A5  清单里没有脏文件      —— 清单路径在 `git status --porcelain` 里必须干净
#                              （脏 = 你极可能递的是工作树版本）
#   A6  「本轮不发布」特征不在 commit 里 —— 默认两条：
#                              · `apps/api-server/src/main.ts` 不含 `bodyParser: false`
#                              · `common/middleware/request-body.middleware.ts` 不存在
#
# ---- ⛔ 与《部署运维手册》§4.4 的关系 --------------------
#   本脚本**只读** git 对象，不停服务、不写库，不属于「主动破坏性动作」，
#   随时可跑。它管的是「发什么」，§4.4 管的是「发的时候能不能打断服务」，
#   两件事不许互相顶替。
# ============================================================
set -uo pipefail

REPO="$(pwd)"
COMMIT=""
MANIFEST=""
ARTIFACTS_DIR=""
BRANCH="main"
ALLOW_NO_ARTIFACTS=0
SELFTEST=0
SELFTEST_TMP=""
DENY_GREP=()
DENY_ABSENT=()

die() { printf '[FAIL] %s\n' "$1" >&2; exit 2; }
g() { git -C "$REPO" "$@"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --artifacts-dir) ARTIFACTS_DIR="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --deny-grep) DENY_GREP+=("${2:-}"); shift 2 ;;
    --deny-absent) DENY_ABSENT+=("${2:-}"); shift 2 ;;
    --allow-no-artifacts) ALLOW_NO_ARTIFACTS=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    -h|--help) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

# 「本轮不发布」的 B 组默认特征（后端 request-body 那批）
if [ ${#DENY_GREP[@]} -eq 0 ]; then
  DENY_GREP+=("apps/api-server/src/main.ts:bodyParser: *false")
fi
if [ ${#DENY_ABSENT[@]} -eq 0 ]; then
  DENY_ABSENT+=("apps/api-server/src/common/middleware/request-body.middleware.ts")
fi

# ------------------------------------------------------------
# 断言执行器：fail-closed，任何一条红 ⇒ 退出码 1
# ------------------------------------------------------------
FAILS=()
RESULT_LINES=()
record() { # record <A?> <0|1> <文案>
  local code="$1" ok="$2" msg="$3"
  if [ "$ok" = 1 ]; then
    RESULT_LINES+=("$(printf '%s  OK    %s' "$code" "$msg")")
  else
    RESULT_LINES+=("$(printf '%s  FAIL  %s' "$code" "$msg")")
    FAILS+=("$code")
  fi
}

# A1 commit 可解析
a1() {
  if [ -z "$COMMIT" ]; then record A1 0 "未给 --commit"; return; fi
  if g cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then
    local full; full="$(g rev-parse "${COMMIT}^{commit}" 2>/dev/null)"
    record A1 1 "commit 可解析：$COMMIT → ${full:0:12}"
  else
    record A1 0 "commit 不可解析：$COMMIT（本地没有这个对象，或拼错）"
  fi
}

# A2 commit 已推送到远端
a2() {
  local full=""
  if g cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then
    full="$(g rev-parse "${COMMIT}^{commit}" 2>/dev/null || true)"
  fi
  # ⚠️ 没有 --verify 时，git rev-parse 对**解析不了**的对象会把原串原样打印回来，
  #    于是 full 非空却不是真 sha ⇒ A2 会拿一个假 sha 去比，判据形同虚设。
  #    故这里先 `cat-file -e` 判存在，再取 sha。
  if [ -z "$full" ]; then record A2 0 "A1 已红，无法判 A2"; return; fi
  if ! g remote get-url origin >/dev/null 2>&1; then
    record A2 0 "仓库没有 origin 远端 ⇒ 无法证明该 commit 已推送（fail-closed）"
    return
  fi
  local rsha
  rsha="$(g ls-remote origin "refs/heads/${BRANCH}" 2>/dev/null | awk '{print $1}' | head -1)"
  if [ -z "$rsha" ]; then
    record A2 0 "取不到远端 refs/heads/${BRANCH}（离线？分支名错？）⇒ 按未推送处理"
    return
  fi
  if [ "$full" = "$rsha" ]; then
    record A2 1 "commit 等于远端 ${BRANCH} 的 HEAD（${rsha:0:12}）"
  elif g merge-base --is-ancestor "$full" "$rsha" 2>/dev/null; then
    record A2 1 "commit 是远端 ${BRANCH} HEAD（${rsha:0:12}）的祖先 ⇒ 属已发布历史"
  else
    record A2 0 "commit ${full:0:12} 不在远端 ${BRANCH}（${rsha:0:12}）的历史里 ⇒ 只存在于本地"
  fi
}

# A3/A4/A5 共用的清单读取
read_manifest() {
  [ -n "$MANIFEST" ] && [ -f "$MANIFEST" ] || { echo ""; return 1; }
  sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$MANIFEST" | grep -v '^$'
}

# A3 清单文件都在 commit 里
a3() {
  local files n=0 bad=""
  if ! files="$(read_manifest)"; then record A3 0 "清单不可读：$MANIFEST"; return; fi
  [ -z "$files" ] && { record A3 0 "清单为空：$MANIFEST"; return; }
  while IFS= read -r p; do
    n=$((n + 1))
    if ! g rev-parse --verify "${COMMIT}:${p}" >/dev/null 2>&1; then
      bad="${bad}${p} "
    fi
  done <<<"$files"
  if [ -z "$bad" ]; then
    record A3 1 "清单 ${n} 个文件全部能在 ${COMMIT} 里取到 blob"
  else
    record A3 0 "这些文件在 ${COMMIT} 里不存在（未提交？路径错？）：${bad}"
  fi
}

# A4 投递物字节 == commit blob
a4() {
  local files n=0 bad="" missing=""
  if ! files="$(read_manifest)"; then record A4 0 "清单不可读：$MANIFEST"; return; fi
  [ -z "$files" ] && { record A4 0 "清单为空：$MANIFEST"; return; }
  if [ -z "$ARTIFACTS_DIR" ]; then
    if [ "$ALLOW_NO_ARTIFACTS" = 1 ]; then
      record A4 1 "已显式 --allow-no-artifacts：本次只推演清单，未比对字节（**不构成投递证明**）"
    else
      record A4 0 "未给 --artifacts-dir ⇒ 无法证明投递物字节来自 ${COMMIT}（fail-closed；真要跳过请显式 --allow-no-artifacts）"
    fi
    return
  fi
  while IFS= read -r p; do
    n=$((n + 1))
    local f="${ARTIFACTS_DIR}/${p}"
    if [ ! -f "$f" ]; then missing="${missing}${p} "; continue; fi
    local want have
    want="$(g rev-parse "${COMMIT}:${p}" 2>/dev/null || true)"
    have="$(git hash-object "$f" 2>/dev/null || true)"
    [ -n "$want" ] && [ "$want" = "$have" ] || bad="${bad}${p} "
  done <<<"$files"
  if [ -n "$missing" ]; then
    record A4 0 "交付目录里缺文件：${missing}"
  elif [ -z "$bad" ]; then
    record A4 1 "交付目录 ${n} 个文件与 ${COMMIT} 的 blob **逐字节一致**"
  else
    record A4 0 "这些投递物与 ${COMMIT} 的 blob 不一致（递的是工作树版本？）：${bad}"
  fi
}

# A5 清单里没有脏文件
a5() {
  local files dirty=""
  if ! files="$(read_manifest)"; then record A5 0 "清单不可读：$MANIFEST"; return; fi
  [ -z "$files" ] && { record A5 0 "清单为空：$MANIFEST"; return; }
  while IFS= read -r p; do
    if [ -n "$(g status --porcelain -- "$p" 2>/dev/null)" ]; then dirty="${dirty}${p} "; fi
  done <<<"$files"
  if [ -z "$dirty" ]; then
    record A5 1 "清单路径在工作树里全部干净（无未提交改动混进来）"
  else
    record A5 0 "这些清单路径在工作树里是**脏**的 ⇒ 极可能递的是工作树版本：${dirty}"
  fi
}

# A6 「本轮不发布」特征不在 commit 里
a6() {
  local bad=""
  local spec path re content
  for spec in "${DENY_GREP[@]}"; do
    path="${spec%%:*}"; re="${spec#*:}"
    if g rev-parse --verify "${COMMIT}:${path}" >/dev/null 2>&1; then
      content="$(g show "${COMMIT}:${path}" 2>/dev/null || true)"
      if printf '%s' "$content" | grep -Eq "$re"; then
        bad="${bad}[在] ${path} 命中 ${re} "
      fi
    fi
  done
  for path in "${DENY_ABSENT[@]}"; do
    if g rev-parse --verify "${COMMIT}:${path}" >/dev/null 2>&1; then
      bad="${bad}[有] ${path} 出现在 ${COMMIT} 里 "
    fi
  done
  if [ -z "$bad" ]; then
    record A6 1 "「本轮不发布」特征在 ${COMMIT} 里全部不存在（B 组未混入）"
  else
    record A6 0 "${bad}"
  fi
}

run_all() {
  FAILS=(); RESULT_LINES=()
  a1; a2; a3; a4; a5; a6
  local line
  for line in "${RESULT_LINES[@]}"; do printf '     %s\n' "$line"; done
  if [ ${#FAILS[@]} -eq 0 ]; then
    printf '\n[PASS] 投递边界六特征全绿（commit=%s）\n' "$COMMIT"
    return 0
  fi
  printf '\n[FAIL] 投递边界 %s 条红：%s\n' "${#FAILS[@]}" "${FAILS[*]}"
  return 1
}

# ------------------------------------------------------------
# --selftest：必绿 1 个 + 必红 7 个（每个必红样本点名必须红的那一条）
# 用一次性临时仓库，不依赖本仓当前状态
# ------------------------------------------------------------
selftest() {
  # ⚠️ trap 里不能引用 `local` 变量：函数返回后它就消失了（`unbound variable`）。
  SELFTEST_TMP="$(mktemp -d)"
  local tmp="$SELFTEST_TMP"
  local r="$tmp/repo" remote="$tmp/remote.git"
  git init -q --bare "$remote"
  git init -q "$r"
  git -C "$r" symbolic-ref HEAD refs/heads/main
  git -C "$r" config user.email t@example.com
  git -C "$r" config user.name selftest
  git -C "$r" remote add origin "$remote"

  mkdir -p "$r/scripts" "$r/apps/api-server/src/common/middleware"
  printf '# v1\n' >"$r/scripts/deploy.sh"
  printf '// clean main\n' >"$r/apps/api-server/src/main.ts"
  git -C "$r" add -A >/dev/null
  git -C "$r" commit -qm c1 >/dev/null
  git -C "$r" push -q origin main >/dev/null
  local c1; c1="$(git -C "$r" rev-parse HEAD)"

  # 交付物目录：用 git show 抽出（真实投递方式）
  local art="$tmp/art"; mkdir -p "$art/scripts"
  git -C "$r" show "$c1:scripts/deploy.sh" >"$art/scripts/deploy.sh"
  local mf="$tmp/mf.txt"; printf 'scripts/deploy.sh\n' >"$mf"

  local pass=0 fail=0
  expect() { # expect <期望:GREEN|RED> <必红代号> <说明> <命令...>
    local want="$1" code="$2" desc="$3"; shift 3
    local out rc
    out="$("$@" 2>&1)"; rc=$?
    if [ "$want" = GREEN ]; then
      if [ $rc -eq 0 ]; then
        printf '     OK   必绿样本 · %s\n' "$desc"; pass=$((pass + 1))
      else
        printf '     FAIL 必绿样本竟然红 · %s\n%s\n' "$desc" "$out"; fail=$((fail + 1))
      fi
    else
      # 断言行格式是 `A1  FAIL  文案` ⇒ 必须按「代号在前」匹配，
      # 写成 `FAIL  A1` 会永远匹配不上，必红样本就变成恒绿样本了。
      if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qE "^[[:space:]]*${code}[[:space:]]+FAIL"; then
        printf '     OK   必红样本 · %s（确由 %s 转红）\n' "$desc" "$code"; pass=$((pass + 1))
      else
        printf '     FAIL 必红样本没红/没由 %s 红 · %s\n%s\n' "$code" "$desc" "$out"; fail=$((fail + 1))
      fi
    fi
  }

  printf '\n[selftest] 临时仓库 %s\n' "$r"

  # --- 必绿样本 ---
  expect GREEN "" "干净 commit + 真实投递物 ⇒ 六条全绿" \
    bash "$0" --repo "$r" --commit "$c1" --manifest "$mf" --artifacts-dir "$art" --branch main

  # --- 必红样本 ---
  # 1) A1：commit 不存在
  expect RED A1 "commit 拼错 ⇒ A1 红" \
    bash "$0" --repo "$r" --commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef --manifest "$mf" --artifacts-dir "$art"

  # 2) A2：只在本地、没推送的 commit
  printf '# local only\n' >>"$r/scripts/deploy.sh"
  git -C "$r" add -A >/dev/null
  git -C "$r" commit -qm c2-local >/dev/null
  local c2; c2="$(git -C "$r" rev-parse HEAD)"
  local art2="$tmp/art2"; mkdir -p "$art2/scripts"
  git -C "$r" show "$c2:scripts/deploy.sh" >"$art2/scripts/deploy.sh"
  expect RED A2 "未推送的本地 commit ⇒ A2 红" \
    bash "$0" --repo "$r" --commit "$c2" --manifest "$mf" --artifacts-dir "$art2"

  # 回到已推送的 c1 继续
  git -C "$r" checkout -q "$c1" -- . 2>/dev/null || true
  git -C "$r" reset -q --hard "$c1"

  # 3) A3：清单里有 commit 里不存在的文件
  local mf3="$tmp/mf3.txt"; printf 'scripts/deploy.sh\nnope/missing.txt\n' >"$mf3"
  expect RED A3 "清单含 commit 里没有的路径 ⇒ A3 红" \
    bash "$0" --repo "$r" --commit "$c1" --manifest "$mf3" --artifacts-dir "$art"

  # 4) A4：投递物字节被改（模拟把工作树文件打包进去）
  local art4="$tmp/art4"; mkdir -p "$art4/scripts"
  printf '# 工作树版本（未提交）\n' >"$art4/scripts/deploy.sh"
  expect RED A4 "投递物字节 ≠ commit blob ⇒ A4 红" \
    bash "$0" --repo "$r" --commit "$c1" --manifest "$mf" --artifacts-dir "$art4"

  # 5) A4：不给 --artifacts-dir ⇒ fail-closed 红（不许恒绿）
  expect RED A4 "不给交付物目录 ⇒ A4 红（fail-closed）" \
    bash "$0" --repo "$r" --commit "$c1" --manifest "$mf"

  # 6) A5：清单路径在工作树被改脏
  printf '# dirty\n' >>"$r/scripts/deploy.sh"
  expect RED A5 "清单路径工作树脏 ⇒ A5 红" \
    bash "$0" --repo "$r" --commit "$c1" --manifest "$mf" --artifacts-dir "$art"
  git -C "$r" checkout -q -- scripts/deploy.sh

  # 7) A6：commit 里出现 B 组特征（main.ts 带 bodyParser: false + 新中间件文件）
  printf '  bodyParser: false,\n' >>"$r/apps/api-server/src/main.ts"
  printf 'export class RequestBodyMiddleware {}\n' >"$r/apps/api-server/src/common/middleware/request-body.middleware.ts"
  git -C "$r" add -A >/dev/null
  git -C "$r" commit -qm c3-bgroup >/dev/null
  git -C "$r" push -q origin main >/dev/null
  local c3; c3="$(git -C "$r" rev-parse HEAD)"
  expect RED A6 "commit 里混入 B 组特征 ⇒ A6 红" \
    bash "$0" --repo "$r" --commit "$c3" --manifest "$mf" --artifacts-dir "$art" --branch main

  printf '\n[selftest] 通过 %s / 失败 %s\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

# ------------------------------------------------------------
if [ "$SELFTEST" = 1 ]; then
  trap '[ -n "${SELFTEST_TMP:-}" ] && rm -rf "$SELFTEST_TMP"' EXIT
  selftest
  exit $?
fi

[ -n "$COMMIT" ] || die "需要 --commit <sha>（或 --selftest）"
[ -n "$MANIFEST" ] || die "需要 --manifest <file>（或 --selftest）"
[ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || die "--repo 不是 git 仓库：$REPO"

printf '\n[投递边界自检] repo=%s commit=%s\n' "$REPO" "$COMMIT"
run_all
exit $?
