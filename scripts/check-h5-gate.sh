#!/usr/bin/env bash
# ============================================================
# ABox · H5（8081）临时访问控制巡检
# ============================================================
#
# 背景：8081 是 `--mode development` 构建的 H5，`?devCode=<任意>` 可免密切换任意身份，
#   而它对外开放 ⇒ 2026-10-27 给它加了一道 **Cookie 闸门**（`abox_gate`）作临时访问控制。
#   理由 / 凭据怎么发 / 怎么换 / 撤除条件见 `apps/miniprogram/nginx.conf`
#   上方的「Cookie 闸门」段与文件末尾的「闸门运维」段。
#
# ⚠️ 为什么是 Cookie 而不是基本认证（别改回去）：
#   浏览器一旦被 JS 用 `Authorization: Bearer <jwt>` 覆盖掉 Authorization 头，就不再带
#   Basic 凭据 ⇒ nginx 回 401 ⇒ **首页能开、一登录就全挂**。实测（2026-10-27）：
#     · 仅 `-u`（无 Bearer）：`GET /api/v1/health/ready` -> 200
#     · `-u` + Bearer：`GET /api/v1/orders` -> 401
#   本脚本第 [3/4] 步最后一条断言**专门盯这个**：带 Bearer 的业务请求必须不被拦。
#   它要是变红，说明有人把闸门改回了基本认证（或别的会跟 Authorization 头打架的方案）。
#
# 用法：
#   ABOX_H5_GATE='<凭据>' ./scripts/check-h5-gate.sh
#
# 退出码：0 = 通过；1 = 有 FAIL。「授权可用」在没给凭据时报 SKIP 而不是 PASS ——
#   没验就说通过，是这类门禁最常见的假绿。

set -uo pipefail

PORT="${ABOX_H5_PORT:-8081}"
ADMIN_PORT="${ABOX_ADMIN_PORT:-8080}"
GATE="${ABOX_H5_GATE:-}"
BASE="http://127.0.0.1:${PORT}"

FAILED=0
SKIPPED=0

ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }
skip() { printf '  SKIP  %s\n' "$1"; SKIPPED=$((SKIPPED + 1)); }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

printf 'H5 访问控制巡检 · %s\n' "$BASE"

# ------------------------------------------------------------
# 1. 未授权必须被拦
# ------------------------------------------------------------
printf '\n[1/4] 无 Cookie 应当被拦（401）\n'
C1=$(code "$BASE/")
C2=$(code "$BASE/index.html")
C3=$(code "$BASE/api/v1/health/ready")
[ "$C1" = 401 ] && ok 'GET / -> 401'                    || bad "GET / -> $C1（期望 401 ⇒ 闸门失效，等于门户大开）"
[ "$C2" = 401 ] && ok 'GET /index.html -> 401'          || bad "GET /index.html -> $C2（期望 401）"
[ "$C3" = 401 ] && ok 'GET /api/v1/health/ready -> 401' || bad "GET /api/v1/health/ready -> $C3（期望 401 ⇒ 反代那条没被盖住）"

# ------------------------------------------------------------
# 2. 错凭据必须被拦（防「填对一半也算过」）
# ------------------------------------------------------------
printf '\n[2/4] 错 Cookie / 错 ?gate 应当被拦\n'
CW=$(code -H 'Cookie: abox_gate=this-is-not-the-gate' "$BASE/")
[ "$CW" = 401 ] && ok '错 Cookie -> 401' || bad "错 Cookie -> $CW（期望 401）"
CG=$(code "$BASE/?gate=this-is-not-the-gate")
[ "$CG" = 401 ] && ok '错 ?gate -> 401' || bad "错 ?gate -> $CG（期望 401）"

# ------------------------------------------------------------
# 3. 授权可用（业务要真的通，不只是首页 200）
# ------------------------------------------------------------
printf '\n[3/4] 授权可用\n'
if [ -z "$GATE" ]; then
  skip '未给 ABOX_H5_GATE，授权侧未验证（不知道凭据时无法判断同事能不能用）'
else
  CA=$(code -H "Cookie: abox_gate=$GATE" "$BASE/")
  [ "$CA" = 200 ] && ok 'GET / -> 200' || bad "GET / -> $CA（期望 200 ⇒ 同事也会吃闭门羹）"

  BODY=$(curl -s -H "Cookie: abox_gate=$GATE" --max-time 10 "$BASE/api/v1/health/ready")
  BC=$(printf '%s' "$BODY" | grep -o '"code":[0-9-]*' | head -1 | cut -d: -f2)
  [ "$BC" = 0 ] && ok 'GET /api/v1/health/ready -> code 0（反代通，不只是首页能开）' \
                || bad "health/ready -> code=${BC:-无}（期望 0）"

  # ⭐ 这一条是本门禁的**命门**：带 `Authorization: Bearer` 的业务请求不能被闸门误伤。
  #   基本认证方案正是栽在这里（详见文件头注释），别让它悄悄退化回去。
  LOGIN=$(curl -s -H "Cookie: abox_gate=$GATE" --max-time 10 -X POST "$BASE/api/v1/auth/login" \
    -H 'Content-Type: application/json' -d '{"code":"dev:1001"}')
  TOKEN=$(printf '%s' "$LOGIN" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$TOKEN" ]; then
    bad "登录失败（code=$(printf '%s' "$LOGIN" | grep -o '\"code\":[0-9-]*' | head -1 | cut -d: -f2)）⇒ 带 Bearer 的断言无法执行"
  else
    ORD=$(curl -s -w '\n%{http_code}' -H "Cookie: abox_gate=$GATE" \
          -H "Authorization: Bearer $TOKEN" --max-time 10 "$BASE/api/v1/orders")
    OH=$(printf '%s' "$ORD" | tail -1)
    OC=$(printf '%s' "$ORD" | grep -o '"code":[0-9-]*' | head -1 | cut -d: -f2)
    if [ "$OH" = 401 ]; then
      bad '带 Cookie + Bearer 的订单请求 -> 401 ⇒ 闸门与 Authorization 头冲突（基本认证方案的典型症状）'
    elif [ "$OH" = 200 ] && [ "$OC" = 0 ]; then
      ok 'GET /api/v1/orders（Cookie + Bearer）-> 200 + code 0 ⇒ 闸门不误伤业务请求'
    else
      bad "GET /api/v1/orders -> HTTP $OH / code=${OC:-无}（期望 200 + code 0）"
    fi
  fi
fi

# ------------------------------------------------------------
# 4. 止血回归 + 后台不受影响
# ------------------------------------------------------------
printf '\n[4/4] 止血回归 与 后台（%s）不受影响\n' "$ADMIN_PORT"
# ⚠️ 未过闸时这里是 **401 而不是 404**：闸门那句 `if (...) { return 401; }` 写在 server 级，
#    属于 **server rewrite 阶段**，早于 location 匹配 ⇒ 它比 mock 拦截的 `return 404` 先执行。
#    两种码都表示「没进业务层」，只是顺序决定了谁先答。**过闸之后**才轮到 404。
#    （这个顺序差别正是本步要钉住的：哪天它变成 200/30010，就是封口被绕过了。）
CM=$(code -X POST "$BASE/api/v1/pay/mock/paid")
[ "$CM" = 401 ] && ok '未过闸：POST /api/v1/pay/mock/paid -> 401（同样进不了业务层）' \
                || bad "未过闸：POST /api/v1/pay/mock/paid -> $CM（期望 401 ⇒ 闸门可能没生效）"
CMU=$(code -X POST "$BASE/api/v1/pay/MOCK/paid")
[ "$CMU" = 401 ] && ok '未过闸：POST /api/v1/pay/MOCK/paid -> 401（大小写变形）' \
                 || bad "未过闸：POST /api/v1/pay/MOCK/paid -> $CMU（期望 401）"
if [ -z "$GATE" ]; then
  skip '未给 ABOX_H5_GATE，过闸后的 404 未验证'
else
  CMG=$(code -H "Cookie: abox_gate=$GATE" -X POST "$BASE/api/v1/pay/mock/paid")
  [ "$CMG" = 404 ] && ok '过闸后：POST /api/v1/pay/mock/paid -> 404（nginx 层拦死，未进 Nest）' \
                  || bad "过闸后：POST /api/v1/pay/mock/paid -> $CMG（期望 404 ⇒ 止血封口被绕过）"
  CMUG=$(code -H "Cookie: abox_gate=$GATE" -X POST "$BASE/api/v1/pay/MOCK/paid/")
  [ "$CMUG" = 404 ] && ok '过闸后：POST /api/v1/pay/MOCK/paid/ -> 404（大小写 + 尾斜杠变形）' \
                   || bad "过闸后：POST /api/v1/pay/MOCK/paid/ -> $CMUG（期望 404 ⇒ 止血封口被绕过）"
fi
AD=$(code "http://127.0.0.1:${ADMIN_PORT}/")
[ "$AD" = 200 ] && ok "后台 ${ADMIN_PORT} 无需凭据 -> 200（闸门只加在 H5 上）" \
                || bad "后台 ${ADMIN_PORT} -> $AD（期望 200 ⇒ 误伤到后台了）"

printf '\n'
if [ "$FAILED" -gt 0 ]; then
  printf '[结果] FAIL —— %s 项未通过（%s）\n' "$FAILED" "$BASE"
  exit 1
fi
if [ "$SKIPPED" -gt 0 ]; then
  printf '[结果] 通过（有 %s 项未验证，不算全绿）\n' "$SKIPPED"
  exit 0
fi
printf '[结果] PASS —— 未授权被拦、授权可用、业务请求不误伤、后台未受影响\n'
exit 0
