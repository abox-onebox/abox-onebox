#!/usr/bin/env bash
# ============================================================
# ABox 一盒 · 上线冒烟（业务级 · 只依赖 curl）
# ============================================================
#
# 用法：
#   ./scripts/smoke-orders.sh                                 默认打 8081（用户端 H5）
#   ABOX_BASE=http://127.0.0.1:8080 ./scripts/smoke-orders.sh 打 8080（运营后台）
#   ABOX_TOKEN=<jwt> ./scripts/smoke-orders.sh                PROVIDER_MODE=real 时用
#   ABOX_DEV_USER=1001 ./scripts/smoke-orders.sh              mock 形态下指定登录身份
#   ABOX_STRICT=1 ./scripts/smoke-orders.sh                   **上线当天**用：WARN 一律按 FAIL 计
#   ABOX_H5_GATE='<凭据>' ./scripts/smoke-orders.sh            打 8081（该站点有 Cookie 闸门）
#
# 退出码：0 = 通过；1 = 有 FAIL。**非 0 就不许宣布上线完成。**
# WARN 单独成一类：既不算 PASS，也不让脚本悄悄变绿 —— 寻常巡检下因为还在 mock
# 而报 WARN 是正常的，但上线当天那条 WARN 就是 FAIL（用 ABOX_STRICT=1 切换）。
#
# ---- 为什么必须有这个脚本（2026-10-27 定）--------------------
#   `/api/v1/health/ready` 只证明「进程活着 + DB / Redis 连得上」，它**不执行任何业务查询**。
#   教训：health 全绿、但订单详情这类核心读接口已经挂了，监控一个都发现不了。
#   而支付链路更隐蔽：`RealWxPayProvider` 构造时缺商户参数**只 WARN 不抛**，
#   服务照常起、health 照常绿，直到有人下单才炸。
#   ⇒ 本脚本必须同时盯三样：**业务读链路 + 形态一致性 + 支付前置条件**。
#
# ---- 三条硬约束 ---------------------------------------------
#   1. **只用 curl + grep/sed**：生产宿主机没有 jq 也没有 node，
#      引依赖 = 上线当天这条命令反而跑不起来。
#   2. **断言 JSON 结构而不只是 HTTP 200**：本项目业务错误一律 `200 + {"code":非 0}`
#      （例：订单详情挂了是 `200 + {"code":30010}`）。只判 200 等于什么都没验。
#   3. **.env.prod 只取「有无/非空」，绝不把值打到终端或日志** —— 那里面有商户密钥。
#
# ---- 关于「要不要建单」---------------------------------------
#   本脚本**不建单、不写任何业务数据**。它只读「该账号已有的最近一单」。
#   若该账号一单都没有，订单详情那步会报 SKIP 而**不是 PASS** ——
#   空账号会给出一条看起来全绿的结论，那是假绿，必须让人看见。
#
# ---- ⛔ 第 [5/5] 步那三条是负向断言，别删 --------------------
#   `/pay/mock/paid`（含大小写 / 尾斜杠变形）在本脚本里**期望得到 404**。
#   它不是功能依赖，是**止血回归**：删掉它，2026-10-27 修的那道 nginx 封口
#   （大小写 / 尾斜杠绕过）就失去了唯一的自动检查，
#   而下一次它被绕过时不会有任何告警。
#   ⇒ 删前请先看：人为把它删掉后脚本必须变红；做不到就说明这个检查是有效的。

set -uo pipefail

BASE="${ABOX_BASE:-http://127.0.0.1:8081}"
DEV_USER="${ABOX_DEV_USER:-1001}"
TOKEN="${ABOX_TOKEN:-}"
ENV_FILE="${ABOX_ENV_FILE:-.env.prod}"
STRICT="${ABOX_STRICT:-0}"

# ---- 8081 临时访问控制的凭据（2026-10-27 加 · 备案+HTTPS 就绪后可撤）------
#   H5 站点（8081）加了 nginx Cookie 闸门 `abox_gate`（理由与撤法见
#   apps/miniprogram/nginx.conf 的「Cookie 闸门」段）⇒ 冒烟不带 Cookie 会拿到 401。
#   而 401 会把「订单详情真的挂了」和「门禁把我拦了」混成同一种红，**无从分辨** ——
#   那比不做检查更糟：它会让上线当天的人去查一个不存在的故障。
# 用法：ABOX_H5_GATE='<凭据>' ./scripts/smoke-orders.sh
#
# ⚠️ 为什么是 Cookie 而不是 `-u`（基本认证）：本脚本第 [4/5] 步要带
#   `Authorization: Bearer` 打订单接口，而 **Basic 与 Bearer 会在 Authorization 头上
#   打架** ⇒ 基本认证下那条请求必吃 401（2026-10-27 实测）。Cookie 与 Authorization
#   头互不干扰，故闸门用 Cookie、这里也用 Cookie。
#
# 做法：把 Cookie 写进临时 `.curlrc`，再用 `CURL_HOME` 指过去 —— 这样**脚本里每一条
#   curl 都自动带上**，不必逐个加 `-H`；漏一条就是一次假红，那种错误很难查。
# ⚠️ `.curlrc` 里是明文凭据，故落在 `mktemp -d`（0700）里，并用 trap 在退出时删除。
ABOX_H5_GATE="${ABOX_H5_GATE:-}"
CURLRC_DIR=""
if [ -n "$ABOX_H5_GATE" ]; then
  CURLRC_DIR="$(mktemp -d)"
  printf 'cookie = "abox_gate=%s"\n' "$ABOX_H5_GATE" > "$CURLRC_DIR/.curlrc"
  export CURL_HOME="$CURLRC_DIR"
  printf 'INFO  已带上门闸 Cookie（H5 8081 临时访问控制）\n'
fi
cleanup_curlrc() { [ -n "$CURLRC_DIR" ] && rm -rf "$CURLRC_DIR"; }
trap cleanup_curlrc EXIT

FAILED=0
SKIPPED=0
WARNED=0

ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; FAILED=1; }
skip() { printf '  SKIP  %s\n' "$1"; SKIPPED=1; }
warn() {
  # 计数而非置位：有 2 条告警就必须报「2 项」，写成 =1 会让多条塌缩成一条
  if [ "$STRICT" = 1 ]; then
    printf '  FAIL  %s（ABOX_STRICT=1 下 WARN 按失败计）\n' "$1"; FAILED=$((FAILED + 1))
  else
    printf '  WARN  %s\n' "$1"; WARNED=$((WARNED + 1))
  fi
}

# 取 JSON 里的第一个匹配字段（顶层 `code` 恒为第一个，故 head -1 取到的是它）
jcode() { printf '%s' "$1" | grep -o '"code":[0-9-]*'   | head -1 | cut -d: -f2; }
jstr()  { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

# 读 .env.prod 的键 —— **只看有无 / 是否非空，不取值**（里面有商户密钥）
envhas() { [ -f "$ENV_FILE" ] && grep -qE "^$1=.+" "$ENV_FILE"; }
envget() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

printf 'ABox 上线冒烟 · %s\n' "$BASE"

# ------------------------------------------------------------
# 0. 站点可达
# ------------------------------------------------------------
printf '\n[0/5] 站点可达\n'
ROOT_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/")
if [ "$ROOT_CODE" = 200 ]; then ok "GET / -> 200"; else bad "GET / -> $ROOT_CODE（期望 200）"; fi

# ------------------------------------------------------------
# 1. 进程探针（health 只当「进程活着」看，不作为业务健康的证据）
# ------------------------------------------------------------
printf '\n[1/5] 进程探针\n'
READY=$(curl -s --max-time 10 "$BASE/api/v1/health/ready")
if [ "$(jcode "$READY")" = 0 ]; then ok 'GET /api/v1/health/ready -> code 0'; else bad "health/ready -> code=$(jcode "$READY")"; fi
RUN_MODE=$(printf '%s' "$READY" | grep -o '"providerMode":"[^"]*"' | head -1 | cut -d'"' -f4)
RUN_ESC=$(printf '%s' "$READY"  | grep -o '"mockEscaped":[a-z]*'   | head -1 | cut -d: -f2)
[ -n "$RUN_MODE" ] && printf '  INFO  运行期 providerMode=%s mockEscaped=%s\n' "$RUN_MODE" "$RUN_ESC"

# ------------------------------------------------------------
# 2. 形态一致性 + 支付前置条件
#    ⚠️ 这一步存在的理由：支付缺参数时**服务照常起、health 照常绿**，
#       只有把「.env 里写了什么」和「运行期生效了什么」对着看才能提前发现。
# ------------------------------------------------------------
printf '\n[2/5] 形态一致性 + 支付前置条件\n'
if [ ! -f "$ENV_FILE" ]; then
  skip "无 $ENV_FILE，形态检查未执行（用 ABOX_ENV_FILE 指定路径）"
else
  CFG_MODE="$(envget PROVIDER_MODE)"
  # ① 配置 vs 运行期：改了 .env 没重启 ⇒ 两者分岔，且没人会报这个错
  if [ -n "$CFG_MODE" ] && [ -n "$RUN_MODE" ] && [ "$CFG_MODE" != "$RUN_MODE" ]; then
    bad "形态分岔：$ENV_FILE 写 $CFG_MODE、运行期是 $RUN_MODE ⇒ 改了配置没重启容器"
  elif [ -n "$RUN_MODE" ]; then
    ok "形态一致：配置与运行期同为 $RUN_MODE"
  fi

  # ② 逃生开关：上线当天它必须**彻底删掉**，留 `0` 也算没开，但留着就是隐患
  if envhas ALLOW_MOCK_IN_PROD; then
    warn 'ALLOW_MOCK_IN_PROD 有值 —— 上线前应连这一行一起删掉（不只是置 0）'
  else
    ok 'ALLOW_MOCK_IN_PROD 未启用'
  fi

  # ③ 分形态检查前置条件
  if [ "$RUN_MODE" = mock ]; then
    warn '运行期仍是 mock：免密登录任意身份 + 免鉴权改支付状态，上线必须切 real'
  elif [ "$RUN_MODE" = real ]; then
    ok '运行期 providerMode=real'
    # `RealWxPayProvider` 的 5 项硬前提（缺则**调用时**才抛，启动与 health 都不报）
    MISSING=''
    for K in WX_MINI_APPID WXPAY_MCH_ID WXPAY_API_V3_KEY WXPAY_SERIAL_NO WXPAY_NOTIFY_URL; do
      envhas "$K" || MISSING="${MISSING} $K"
    done
    if [ -n "$MISSING" ]; then
      bad "real 形态缺必配项：${MISSING} ⇒ 下单/退款会在**调用时**才炸，而 health 是绿的"
    else
      ok 'real 形态必配的 5 项齐全（WX_MINI_APPID / MCH_ID / API_V3_KEY / SERIAL_NO / NOTIFY_URL）'
    fi
    # ④ 私钥：容器里读的是 WXPAY_PRIVATE_KEY_PATH，宿主机侧落在 WXPAY_CERT_DIR。
    #    compose 把 ${WXPAY_CERT_DIR:-./deploy/certs} 挂到 /etc/abox/certs，
    #    目录不存在时 docker 会**建个空目录** ⇒ 服务照起、支付全废，只有一条 ERROR 日志。
    PK="$(envget WXPAY_PRIVATE_KEY_PATH)"
    # 不写 `${WXPAY_CERT_DIR:-$(envget ...)}`：**${} 套 $() 会让 bash 把引号吞掉**，
    # 写成两行是等价的且不会踩到那个解析坑。
    CERT_DIR="$(envget WXPAY_CERT_DIR)"
    CERT_DIR="${CERT_DIR:-${WXPAY_CERT_DIR:-./deploy/certs}}"
    if [ -z "$PK" ]; then
      bad 'WXPAY_PRIVATE_KEY_PATH 未配 ⇒ 无法向微信签名，下单必失败'
    elif [ ! -f "${CERT_DIR}/$(basename "$PK")" ]; then
      bad "私钥文件不在挂载目录：${CERT_DIR}/$(basename "$PK") 不存在（当前挂载目录是空目录）"
    else
      ok "商户私钥就位于挂载目录（${CERT_DIR}/$(basename "$PK")）"
    fi
    # ⑤ 回调地址必须是公网 HTTPS，http 会被微信拒收 ⇒ 用户付了钱、订单不生效
    NU="$(envget WXPAY_NOTIFY_URL)"
    case "$NU" in
      https://*) ok 'WXPAY_NOTIFY_URL 是 HTTPS' ;;
      '')       bad 'WXPAY_NOTIFY_URL 未配' ;;
      *)        bad "WXPAY_NOTIFY_URL 不是 HTTPS（当前 ${NU}）⇒ 微信不会回调，订单停在待支付" ;;
    esac
  else
    skip "providerMode 未知（$RUN_MODE），前置条件未检查"
  fi
fi

# ------------------------------------------------------------
# 3. 登录取 token
# ------------------------------------------------------------
printf '\n[3/5] 登录\n'
if [ -z "$TOKEN" ]; then
  LOGIN=$(curl -s --max-time 10 -X POST "$BASE/api/v1/auth/login" \
    -H 'Content-Type: application/json' -d "{\"code\":\"dev:${DEV_USER}\"}")
  if [ "$(jcode "$LOGIN")" = 0 ]; then
    TOKEN=$(jstr "$LOGIN" token)
    printf '  INFO  dev:%s 登录（mock 形态专用；切 real 后此路不通，改传 ABOX_TOKEN）\n' "$DEV_USER"
  else
    bad "auth/login -> code=$(jcode "$LOGIN")（若已切 real，改用 ABOX_TOKEN 传入 JWT）"
  fi
else
  printf '  INFO  使用 ABOX_TOKEN（real 形态）\n'
fi
if [ -n "$TOKEN" ]; then ok "token 拿到（长度 ${#TOKEN}）"; else bad 'token 为空，后续业务断言无法执行'; fi
AUTH_HDR=(-H "Authorization: Bearer ${TOKEN}")

# ------------------------------------------------------------
# 4. 订单列表 -> 订单详情（核心读接口）
# ------------------------------------------------------------
printf '\n[4/5] 订单链路（业务级）\n'
ORDER_NO=''
if [ -n "$TOKEN" ]; then
  LIST=$(curl -s --max-time 10 "$BASE/api/v1/orders" "${AUTH_HDR[@]}")
  if [ "$(jcode "$LIST")" = 0 ]; then
    ok 'GET /api/v1/orders -> code 0'
    ORDER_NO=$(jstr "$LIST" orderNo)
  else
    bad "GET /api/v1/orders -> code=$(jcode "$LIST")"
  fi

  if [ -n "$ORDER_NO" ]; then
    # ⚠️ 三重断言：HTTP 200 **且** 业务码 0 **且** 回包真的带了订单号。
    #    只判前两项的话，「业务码 0 但 data 是空壳 / 序列化坏了」照样会被判过。
    HCODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/v1/orders/${ORDER_NO}" "${AUTH_HDR[@]}")
    D=$(curl -s --max-time 10 "$BASE/api/v1/orders/${ORDER_NO}" "${AUTH_HDR[@]}")
    C=$(jcode "$D")
    HAS=$(printf '%s' "$D" | grep -c "\"orderNo\":\"${ORDER_NO}\"")
    if [ "$HCODE" = 200 ] && [ "$C" = 0 ] && [ "$HAS" -ge 1 ]; then
      ok "GET /api/v1/orders/${ORDER_NO} -> 200 + code 0 + 带回该单号"
    else
      bad "订单详情 ${ORDER_NO}：HTTP=${HCODE} code=${C} 含本单号=${HAS}（三项须全成立）"
    fi
  else
    skip '该账号无任何订单，订单详情未被验证（空账号 ⇒ 这条链路没被走到，不算绿）'
  fi
else
  skip '无 token，订单链路未验证'
fi

# ------------------------------------------------------------
# 5. 止血回归：免鉴权 mock 改单口必须仍是 404
# ------------------------------------------------------------
printf '\n[5/5] 安全止血回归（大小写 / 尾斜杠变形）\n'
for U in '/api/v1/pay/mock/paid' '/api/v1/pay/MOCK/paid' '/api/v1/pay/mock/paid/'; do
  C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$BASE$U" \
    -H 'Content-Type: application/json' -d '{"orderNo":"AB0000000000000000"}')
  if [ "$C" = 404 ]; then ok "POST $U -> 404"; else bad "POST $U -> $C（期望 404，nginx 止血失效）"; fi
done

# ------------------------------------------------------------
printf '\n'
if [ "$FAILED" -gt 0 ]; then
  printf '[结果] FAIL —— %s 项未通过（%s）。不要宣布上线完成。\n' "$FAILED" "$BASE"; exit 1
elif [ "$SKIPPED" -gt 0 ]; then
  printf '[结果] PASS（含 %s 项跳过、%s 项告警）—— 有链路未验证，别当全绿\n' "$SKIPPED" "$WARNED"; exit 0
elif [ "$WARNED" -gt 0 ]; then
  printf '[结果] PASS（%s 项告警）—— 寻常巡检可接受；**上线当天请改用 ABOX_STRICT=1**\n' "$WARNED"; exit 0
else
  printf '[结果] PASS —— 全项通过（%s）\n' "$BASE"; exit 0
fi
