# ABox 一盒 · 域名 DNS + HTTPS + 真闭环 方案包 v1.0

> 目的：把知识助手（KB）从「mock / 裸 IP」形态，切到 **真实自有域名 + HTTPS + 真实后端** 的可闭环形态。
> 范围：**仅 KB 助手侧的真闭环**（operator / approver 走后台账号 + 令牌，不依赖微信支付商户号）。
> 微信支付 real 模式是另一条独立闸门（需商户号 + APIv3 密钥 + 商户私钥），不在本方案包内。
> 全部为实测事实，来源：`ref/部署与外网测试.md`、`ref/资质与合规.md`、工作区 `MEMORY.md`。

---

## 0 一句话现状（动手前必读）

- 主域 `xunlizhinian.cn`（.cn，企业实名，北京巡礼之年科技）**已购**，状态「域名实名审核中」（2026-10-13），最早 **10-18** 可重提 ICP 备案。
- 服务器 `154.8.164.180`（腾讯云，Ubuntu）：docker 已发布 `abox-api-prod`，对外端口 **8080（admin nginx）/ 8081（h5 nginx）**；mysql / redis **不映射宿主端口**。
- **宿主机当前无 nginx、无域名、无 SSL 证书**（§8.5 / §11.3 实测）→ HTTPS 路径短期不成立，只能靠调试态绕。本方案包正是补这道。
- KB 前端 `KB_API_BASE = 'https://api.xunlizhinian.cn'`（已指向域名）；后端 CORS 白名单已含 `https://abox-kb.app.workbuddy.host`（阶段 2 B1，仅 /admin）。
- `PROVIDER_MODE=mock` 是**微信登录/支付 Provider 开关**，与 KB 助手的 operator/approver 流程**无关**——后者用后台账号登录 + 令牌，不碰微信支付 ⇒ 本方案包的真闭环**不需要切 PROVIDER_MODE**。

---

## 1 角色分工（你做 / 我做）

| 阶段 | 事项 | 谁做 | 阻塞 |
|---|---|---|---|
| 0 | 域名实名审核通过 → 重提 ICP 备案（域名 + 小程序两套，可并行）| 你（腾讯云/工信部）| 备案约 2–3 周 |
| 1 | DNS：A 记录 `api`→154.8.164.180；`admin` 可选（建议不公开解析）| 你（域名控制台）| 无 |
| 2 | 腾讯云安全组放行 **TCP 80 + 443**（80 仅供 ACME 验证，验证后可仅留 443）| 你（云控制台）| 无 |
| 3 | 主机装 nginx + certbot，签发 Let's Encrypt 证书，写站点反代 | 我（ssh 服务器 + docker exec）| 依赖 1+2 |
| 4 | CORS 核对 + KB 重发（已含 P2 的 index.html 部署到 workbuddy 主机）| 我 | 依赖 3 |
| 5 | 真闭环验证（health + KB 真实提交/执行/审批一笔）+ operator1 登录复验 | 我 | 依赖 4 |
| 6 | 公安联网备案（备案成功后 30 日内）| 你（全国互联网安全管理平台）| 依赖 0 |

> 关键：**阶段 1–2 是「你只在注册商/云控制台点几下」的部分**；阶段 3–5 我收到「DNS 已生效」信号后全自动。

---

## 2 阶段 1 · DNS 解析（你做）

在域名服务商控制台给 `xunlizhinian.cn` 加两条 A 记录（主机记录 / 记录类型 / 记录值）：

| 主机记录 | 类型 | 值 | 说明 |
|---|---|---|---|
| `api` | A | `154.8.164.180` | **公网必达**，KB 与小程序端都依赖 |
| `admin` | A | `154.8.164.180` | 含退款/提现审批等资金操作，**不建议无门槛暴露** |

- `admin` 的两种处理（二选一，推荐 A）：
  - **A（更稳）**：**公网 DNS 不解析 `admin`**，仅在安全组把 8080 对运营固定 IP 白名单开放；后台走 `https://<运营IP>:8443` 或 VPN。前端 `request.ts:40` 的 `baseURL` 默认同源相对 `/api/v1`，**一行代码都不用改**。
  - **B**：也解析 `admin` 并同样走 HTTPS，但安全组仍需对后台登录 IP 做限制（资金操作）。
- TTL 先设小（如 600s），便于生效后观察 / 回滚。
- **生效判定**：`nslookup api.xunlizhinian.cn` 返回 `154.8.164.180` 即算生效（全球 propagation 可能几分钟到几小时）。

---

## 3 阶段 2 · 云安全组（你做）

腾讯云控制台 → 该实例「安全组」→ 入站规则加：

- `TCP:80`  允许（源 `0.0.0.0/0`）—— 仅用于 Let's Encrypt HTTP-01 验证；证书签发后可改为仅对 CA 或移除。
- `TCP:443` 允许（源 `0.0.0.0/0`）—— 正式 HTTPS 端口。
- （`8080/8081` 维持现状：若阶段 0 走 A 方案，8080 仅对运营 IP 开放；8081 若小程序 H5 仍需公网则保留。）

> 这是云侧动作，我无法操作；历史上 8081 放行就是用户手动做的（§8.5）。

---

## 4 阶段 3 · 主机 nginx + TLS（我做，DNS 生效后进行）

登录 `154.8.164.180`（ssh，`id_ed25519_abox_srv`），在**宿主机**层操作（容器内已有 h5/admin nginx，但宿主机无 TLS）：

```bash
# 4.1 安装（Ubuntu）
sudo apt-get update && sudo apt-get install -y nginx certbot python3-certbot-nginx

# 4.2 签发证书（api 必做；admin 按阶段 1 选择）
sudo certbot --nginx -d api.xunlizhinian.cn            # 含 admin 时追加 -d admin.xunlizhinian.cn
#   → certbot 自动改写 nginx 站点、开启 443 + HTTP→HTTPS 跳转；证书 90 天，crontab 自动续期

# 4.3 站点反代（api.xunlizhinian.cn）
#     host nginx :443 → 127.0.0.1:8081（h5 nginx 已反代 /api/ → api:3000）
#     ⚠ 必须带两个易漏项（§3）：client_max_body_size 20m + proxy_request_buffering off
```

nginx `api.xunlizhinian.cn.conf` 关键片段（我落地时写入）：

```nginx
server {
    listen 443 ssl;
    server_name api.xunlizhinian.cn;
    # certbot 注入 ssl_certificate / ssl_certificate_key

    client_max_body_size 20m;                 # 否则传图 413
    location /api/ {
        proxy_request_buffering off;          # 微信支付 V3 回调要原始报文验签
        proxy_pass http://127.0.0.1:8081;     # h5 nginx 已反代 /api/ → api:3000
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server { listen 80; server_name api.xunlizhinian.cn;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}
```

- `admin` 同构，指向 `127.0.0.1:8080`（admin nginx）。
- 复验：`sudo nginx -t && sudo systemctl reload nginx`。

---

## 5 阶段 4 · CORS 核对 + KB 重发（我做）

- **CORS 现状已满足**：KB 托管于 `https://abox-kb.app.workbuddy.host`，其调用 `api.xunlizhinian.cn` 时 `Origin` = `https://abox-kb.app.workbuddy.host`，已在后端 CORS 白名单（B1）。**无需改后端**。
  - 若将来 KB 改挂自有子域（如 `kb.xunlizhinian.cn`），则需在后端 CORS 白名单补该 origin（一行 env/config 改动 + 重启 api 容器，我处理）。
- **KB 重发**：把已含 P2 打磨的 `_app/abox-kb/index.html` 重新部署到 workbuddy 主机（`abox-kb.app.workbuddy.host`）。触发即生效，KB 自动以 `https://api.xunlizhinian.cn` 打真实后端。

---

## 6 阶段 5 · 真闭环验证（我做）

```bash
# 6.1 后端健康（宿主机）
curl -fsS https://api.xunlizhinian.cn/api/v1/health/ready      # 期望 ready

# 6.2 KB 真实流一笔（用重置后的 operator1 令牌，见 operator1 收口）
#     memResubmit / submitRequest / approveReq / executeReq 各跑一次
#     期望：code=0，操作日志落 ab_operation_log，且 X-KB-OPERATOR 正确入库

# 6.3 跨域复验
curl -fsS -H 'Origin: https://abox-kb.app.workbuddy.host' \
  https://api.xunlizhinian.cn/api/v1/health/ready | head   # 期望响应头含 Access-Control-Allow-Origin
```

- 失败回滚：任一阶段异常 → 先把 host nginx 该 server 段注释、回退 8081 裸 IP 调试态（§11.3），不影响已部署容器。

---

## 7 风险与回滚

| 风险 | 缓解 |
|---|---|
| 证书签发失败（80 未放行 / 域名未生效）| 阶段 2 放行 80 + 阶段 1 生效判定后再跑 certbot |
| CORS 在自有域名下被拦 | 阶段 4 补白名单一行 + 重启 api |
| 公网暴露 admin 资金操作 | 阶段 1 走 A 方案（admin 不公开解析）+ 安全组 IP 白名单 |
| 备案未完成就上线 | 阶段 0 两套备案完成前，KB 仍走 workbuddy 主机 + 域名解析可暂缓；**备案是外部硬前置** |

---

## 8 检查清单（照着打勾）

- [ ] 域名实名已通过，ICP 备案（域名 + 小程序）已提交并在审
- [ ] `api.xunlizhinian.cn` A 记录 → 154.8.164.180，`nslookup` 验证生效
- [ ] （可选）`admin` 不公开解析，安全组对运营 IP 白名单
- [ ] 腾讯云安全组放行 80 / 443
- [ ] 我：主机 nginx + certbot 签发，站点反代写好，`nginx -t` 通过
- [ ] 我：CORS 核对（当前已满足）/ KB 重发 P2 版
- [ ] 我：health + KB 真实流一笔 + 跨域头验证全绿
- [ ] 你：备案成功后 30 日内公安联网备案
- [ ] operator1 口令已收口（见独立交接说明）

---

> 本方案包只覆盖「KB 助手真闭环」。小程序正式上线另需：食品经营许可 / 小程序备案 / 微信服务类目（食品资质）/ 体验版→production 重传 / 微信支付商户号（real 模式）。这些与域名 HTTPS 可并行推进，但不阻塞 KB 助手闭环。
