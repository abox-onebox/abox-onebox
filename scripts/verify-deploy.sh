#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 部署生效确认（看**运行中的编译产物**，不看源码）
# ============================================================
#
# 用法：
#   ./scripts/verify-deploy.sh                              验默认两处标记（本轮上线包）
#   ./scripts/verify-deploy.sh --marker foo --marker bar     验自定义标记
#   ./scripts/verify-deploy.sh --old-marker '旧的写法'       额外验「旧写法已消失」（默认不开，见 [2] 段注释）
#   ./scripts/verify-deploy.sh --container abox-api-prod     指定容器（默认就是它）
#   ./scripts/verify-deploy.sh --dist /app/apps/api-server/dist
#   ./scripts/verify-deploy.sh --commit <sha> --manifest <f> [--artifacts-dir <d>]
#                                                            追加验「投递边界」（见 [3] 段）
#   ./scripts/verify-deploy.sh --boundary-only --commit <sha> --manifest <f> [--artifacts-dir <d>]
#                                                            **只**验投递边界（在**投递侧**跑：
#                                                            那台机器有 .git，通常没有 docker）
#
# ⚠️ [0]–[2] 要 docker（生产机有 docker、没有 .git）；[3] 要 .git（投递侧两者相反）。
#    两边前置条件**互斥** ⇒ 没有 `--boundary-only` 时缺 docker 直接退出 2，
#    否则「边界那一层」会在任何一台机器上都跑不到，等于空跑。
#
# 退出码：0 = 标记全在（新代码真在跑）· 1 = 有标记缺失 · 2 = 用法/环境错误
#
# ---- 为什么要有这个脚本（2026-10-27 定）--------------------
#   「代码改对了」和「改对了的代码真的在跑」是两件事，而第二件事**失败时毫无症状**：
#      · 镜像没重建，旧容器照旧服务；
#      · 构建缓存命中旧层，产物里根本没有新函数；
#      · `up -d` 没带 `--force-recreate`，compose 认为「配置没变」于是不重建。
#   这三种情况的共同表现是：**部署命令退出 0、health 全绿、冒烟也全绿** ——
#   因为冒烟验的是**行为**，而像「缺键 fallback 是否修好」这类改动，
#   在默认数据下**行为表现完全一致**，冒烟根本分辨不出来。
#
#   ⇒ 所以必须有一个「看产物」的检查，把「部署是否真的生效」变成可执行、可失败的断言。
#
# ---- 为什么看 dist 而不是看 src --------------------------------
#   `src/` 在服务器上可能压根不是最新的（同步链路独立），而**运行时真正执行的是 dist**。
#   看 src 会给出「代码到了、但没编译、也没重启」的假绿 —— 正是本脚本要排除的形状。
#
# ---- 关于 mtime ----------------------------------------------
#   ⚠️ 不要用 `ls -l` 的 mtime 判「有没有更新」：同步/构建都可能保留旧 mtime，
#      也可能只改了注释就刷新 mtime。判据必须是**产物里的符号**，不是时间戳。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTAINER="${ABOX_CONTAINER:-abox-api-prod}"
DIST="${ABOX_DIST:-/app/apps/api-server/dist}"
MARKERS=()
OLD_MARKERS=()
COMMIT=""
MANIFEST=""
ARTIFACTS_DIR=""
BOUNDARY_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --boundary-only) BOUNDARY_ONLY=1; shift ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --artifacts-dir) ARTIFACTS_DIR="${2:-}"; shift 2 ;;
    --marker) MARKERS+=("${2:-}"); shift 2 ;;
    --old-marker) OLD_MARKERS+=("${2:-}"); shift 2 ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --dist) DIST="${2:-}"; shift 2 ;;
    -h|--help) sed -n '4,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '未知参数：%s（--help 看用法）\n' "$1" >&2; exit 2 ;;
  esac
done

# 默认标记：本轮上线包的两处（改一处就得改这里 —— 与「登记」同一纪律）
if [ "${#MARKERS[@]}" -eq 0 ]; then
  MARKERS+=('pickConfigNumber')      # D-1 · biz-config 缺键 fallback（config-value.ts）
  MARKERS+=('isProductionRuntime')   # 生产禁 mock 改单口（payment.service.ts）
fi

FAILED=0
ok()  { printf '  PASS  %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; FAILED=1; }

printf '部署生效确认 · 容器 %s · dist %s\n\n' "$CONTAINER" "$DIST"

# ------------------------------------------------------------
# 0. 容器在不在、跑的是哪个镜像
# ------------------------------------------------------------
printf '[0] 容器与镜像\n'
if [ "$BOUNDARY_ONLY" = 1 ]; then
  SKIP_CORE=1
  printf '  SKIP  --boundary-only：本段只在生产机跑（要 docker + 容器），投递侧跳过\n'
else
  SKIP_CORE=0
  command -v docker >/dev/null 2>&1 || { printf '  FAIL  本机没有 docker\n' >&2; exit 2; }
  if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    printf '  FAIL  容器不存在：%s\n' "$CONTAINER" >&2; exit 2
  fi
fi

if [ "$SKIP_CORE" = 0 ]; then
STATE="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)"
IMAGE_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null)"
STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null)"
if [ "$STATE" = running ]; then ok "容器状态 running"; else bad "容器状态 = $STATE（期望 running）"; fi
printf '  INFO  镜像 id  = %s\n' "${IMAGE_ID:0:19}"
printf '  INFO  启动时刻 = %s\n' "$STARTED"
printf '  INFO  拿这两个跟锚点 images.txt 对一下，就能确认「跑的是不是刚部署的那个镜像」\n'

# ------------------------------------------------------------
# 1. 产物里的符号
# ------------------------------------------------------------
printf '\n[1] 运行中的编译产物是否含预期符号\n'
for M in "${MARKERS[@]}"; do
  [ -n "$M" ] || continue
  if docker exec "$CONTAINER" grep -rq -- "$M" "$DIST" 2>/dev/null; then
    # 顺带报出落在哪个文件 —— 排障时第一问是「它到底编进去了没有」
    WHERE="$(docker exec "$CONTAINER" grep -rl -- "$M" "$DIST" 2>/dev/null | head -1)"
    ok "dist 内含 '$M'  → ${WHERE:-（未定位到文件）}"
  else
    bad "dist 内**不含** '$M' ⇒ 新代码没有真正生效（镜像未重建 / 容器未重建 / 构建缓存命中旧层）"
  fi
done

# ------------------------------------------------------------
# 2. 旧符号是否已消失（**可选**，默认不开）
# ------------------------------------------------------------
# ⚠️ 这一层**默认不自动判**，因为「旧写法」的判据极易误伤，误伤的代价是**假红**，
#    而假红会让人学会忽略本脚本 —— 那比没有这个脚本更糟。
#    实测踩过一次：本轮 D-1 的修法是把判据抽成 `pickConfigNumber()`，
#    而**新helper 内部本身**就含 `Number.isFinite(n) ? n : fallback` 这一行
#    （它是对「非数字字符串」的正确第二道判定，不是旧 bug）。
#    于是「新符号在 + 旧表达式在」被误判成半新半旧 ⇒ 一次成功的部署被打成 FAIL。
#    ⇒ 结论：旧写法标记**必须由人显式给**（`--old-marker`），且给出前先确认
#      该字符串确实只可能来自旧代码。
printf '\n[2] 旧写法是否已消失（防半新半旧）\n'
if [ "${#OLD_MARKERS[@]}" -eq 0 ]; then
  printf '  SKIP  未给 --old-marker，跳过（默认不猜「旧写法长什么样」，理由见脚本注释）\n'
else
  for OLD in "${OLD_MARKERS[@]}"; do
    [ -n "$OLD" ] || continue
    if docker exec "$CONTAINER" grep -rq -- "$OLD" "$DIST" 2>/dev/null; then
      bad "dist 内仍含旧写法 '$OLD' ⇒ 半新半旧，别继续"
    else
      ok "旧写法 '$OLD' 已消失"
    fi
  done
fi
else
  printf '\n[1] 运行中的编译产物是否含预期符号\n  SKIP  --boundary-only：跳过\n'
  printf '\n[2] 旧写法是否已消失（防半新半旧）\n  SKIP  --boundary-only：跳过\n'
fi

# ------------------------------------------------------------
# 3. 投递边界（「装进去的是不是那个 commit 的内容」）
# ------------------------------------------------------------
# ⚠️ 这一层与 [1][2] **不是一回事**：[1][2] 证明「产物里有没有新符号」，
#    本层证明「投递物里有没有夹带**未提交**的东西」。
#    出过的事：后端把 `main.ts`（`bodyParser: false`）与
#    `common/middleware/request-body.middleware.ts` 作为**本轮不发布**的改动
#    留在工作树里；工作树文件一旦被打包，等于悄悄发布了未提交代码，
#    而它在 dist 里**毫无特征可查**（编译后两边长得一样）⇒ 只能在投递那一刻证明。
#
#    本层依赖 `.git`，而生产机**没有** `.git` ⇒ 生产机上必然跑不了。
#    ⇒ 缺前置条件时**明确打 SKIP 并声明「未证明」**，不打 PASS ——
#      打了 PASS 就成了「没验也算验过」，那比没有这一层更糟。
printf '\n[3] 投递边界（产物是否只含已提交内容）\n'
if [ ! -d "$ROOT/.git" ] && [ ! -f "$ROOT/.git" ]; then
  printf '  SKIP  当前目录没有 .git（生产机通常如此）⇒ **本轮投递边界未经证明**\n'
  printf '        要在投递侧补跑：./scripts/assert-deploy-boundary.sh --commit <sha> --manifest <f> --artifacts-dir <d>\n'
elif [ -z "$COMMIT" ] || [ -z "$MANIFEST" ]; then
  printf '  SKIP  未给 --commit / --manifest ⇒ **本轮投递边界未经证明**\n'
  printf '        补跑：./scripts/assert-deploy-boundary.sh --commit <sha> --manifest <f> --artifacts-dir <d>\n'
else
  BOUNDARY_ARGS=(--repo "$ROOT" --commit "$COMMIT" --manifest "$MANIFEST")
  [ -n "$ARTIFACTS_DIR" ] && BOUNDARY_ARGS+=(--artifacts-dir "$ARTIFACTS_DIR")
  if BOUNDARY_OUT="$(bash "$ROOT/scripts/assert-deploy-boundary.sh" "${BOUNDARY_ARGS[@]}" 2>&1)"; then
    printf '%s\n' "$BOUNDARY_OUT" | sed 's/^/  /'
    ok "投递边界六特征全绿（A1–A6）"
  else
    printf '%s\n' "$BOUNDARY_OUT" | sed 's/^/  /'
    bad "投递边界有红 ⇒ 产物里可能夹带了未提交内容，别宣布上线完成"
  fi
fi

# ------------------------------------------------------------
printf '\n'
if [ "$FAILED" -gt 0 ]; then
  printf '[结果] FAIL —— 部署**未**生效或处于半新半旧态。不要宣布上线完成。\n'
  printf '       排查：docker compose -f docker-compose.prod.yml --env-file .env.prod build --no-cache api\n'
  printf '       再：  docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate api\n'
  exit 1
fi
if [ "${SKIP_CORE:-0}" = 1 ]; then
  # ⚠️ 不许在这里打 PASS：核心段没跑，说「一致」是撒谎。
  printf '[结果] **部分验证** —— 只跑了投递边界 [3]，[0]–[2]（容器 / dist 符号）**未跑**。\n'
  printf '       这不算「部署生效确认」，生产机那边还要再跑一次不带 --boundary-only 的本脚本。\n'
  exit 0
fi
printf '[结果] PASS —— 运行中的产物与本次上线包一致\n'
