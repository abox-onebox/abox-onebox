# ABox 一盒 · 企业微信 KB 助手发布执行清单 v1.0

> 版本：**v1.0**（2026-10-21 · 路线 B 对话机器人）
> 配套代码：`apps/api-server/src/modules/wecom-kb/`（12 文件）+ 迁移 `1700000000013-wecom-binding`
> 配套文档：《ABox一盒企业微信KB助手部署操作卡v1.0.md》（架构/指令/边界）→ 本清单是它的「照跑版」
> 纪律来源：《ABox一盒部署运维手册v1.0.md》§四（凭据）、§六（禁发窗口）、脚本 `deploy.sh` / `rollback.sh`
> 目标：让同事**不用电脑**、在企业微信里发指令操作 KB 替操作台。

---

## 0. 现状确认（已逐字核实，非假设）

| 项 | 结论 | 判据 |
| --- | --- | --- |
| 代码是否推送 | **已推送，无需再推** | 本地 `main` 跟踪 `origin/main`，HEAD=`bba6597`；`git log origin/main..HEAD` 为空；`wecom-kb/` 12 文件 + 迁移 13 均在 HEAD 树 |
| 类型检查 | 全绿 | 上轮 `tsc --noEmit` 0 错误 |
| 加密自检 | 通过 | `WXBizMsgCrypt` 往返（含 1000 字样本）一致 |
| 回调端点放行 | 已修 | `WecomKbController` 已加 `@Public()`（否则被全局 `JwtAuthGuard` 拦死） |
| 容器内网回放 | 就绪 | bot 调 `127.0.0.1:3000` 复用 `/api/v1` 端点 + `X-KB-*` 头，CORS 不适用 |

> ⚠️ 上一轮对话里的「待授权推送」已过时——代码实际已在 `origin/main`，本清单**不含推送步骤**（仅 §2.1 的 nginx 改动需一次新提交+推送）。

---

## 1. 禁发窗口（硬约束，来自运维手册 §六）

跑批与截单是**唯一不能被打断**的。以下时段**禁止发布 / 重启 / 改配置**：

| 禁发时段（北京时间） | 原因 |
| --- | --- |
| `T-1 23:30 – 24:30` | 截单窗口（`cutoff` 00:00 触发）：取消未支付 + 锁定已支付 + 推备料量 |
| `T 日 10:00 – 12:30` | 出餐 → 集散打包 → 配送 → 11:30 送达高峰 |
| `T 日 13:30 – 14:30` | 自动确认（`auto-confirm` 14:00）：计佣基数定格 |
| `T+1 01:30 – 04:30` | 日结跑批（02:00 佣金 / 02:10 供应商应付 / 04:00 对账） |

**可发窗口（建议）**：`T 日 15:00 – 22:00`，或 `T+1 05:00 – 23:00`。

> 容器重启虽有优雅关闭，但跑批是 `@Cron` 独立流程、不等在途请求 —— **「优雅关闭」≠「可随便重启」**，仍须避开上表。

---

## 2. 发布前准备（你方 + 我方）

### 2.1 给 nginx 加 `/wecom/` 反代块（代码改动，必须进 git）
- 当前 `apps/admin-web/nginx.conf` **没有** `/wecom/` 块（已 Grep 核实）。
- 在 `location /api/ { ... }` 之后追加**附件 A** 片段。
- 提交并推送（这一步是代码改动，服务器 `git pull` 才能取到）：
  ```bash
  cd /opt/abox-onebox  # 本机工作区
  git add apps/admin-web/nginx.conf
  git commit -m "wecom-kb: nginx 加 /wecom/ 回调反代块"
  git push origin main
  ```
- 生效机制：`deploy.sh` 第 137 行 `compose build ... api admin` + 第 161 行 `up -d --force-recreate api admin` 会自动重建 admin 镜像并加载新 conf（admin 是 compose 里**唯一对外入口**，端口 8080，跑 nginx）。

### 2.2 你方准备企业微信凭据（管理员后台「接收消息」应用）
- 拿 `CorpID / AgentID / Secret / Token / EncodingAESKey`。
- `EncodingAESKey` 是后台「随机生成」的 43 字符串，Base64 解码须正好 32 字节，否则启动自检即报错。

### 2.3 你方准备预绑定输入
- 各同事的**预签发令牌**（operator 令牌必填；审批人另给 approverToken）—— 与 KB 网页用的同一套，从你们现有令牌签发流程取。
- 各同事的**企业微信 userid**（后台「通讯录」可见）。

---

## 3. 发布执行（服务器，禁发窗口内）

```bash
cd /opt/abox-onebox
git pull                                   # 取含 §2.1 nginx 改动的 main

# 先 dry-run 看一遍将执行的命令（不真动）
./scripts/deploy.sh --dry-run

# 正式发布：预检 → 备份 → 起依赖 → build api+admin → 迁移 → up → 健康验证
./scripts/deploy.sh
```

- `deploy.sh` 第 5 步自动 `migration:run`，**含本次 `1700000000013`**（建 `ab_wecom_binding`）。
- 失败时不自动回滚（避免「半新半旧」），脚本会打印明确回滚命令并停下（见 §9）。

---

## 4. 迁移核对（必做）

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps --entrypoint sh api -c \
  'node node_modules/typeorm/cli.js migration:show -d apps/api-server/dist/database/data-source.js'
# 期望：WecomBinding1700000000013 标记 [X]（已应用）
```

---

## 5. 填 WECOM_* 凭据（你方给串，贴 .env.prod）

在服务器 `.env.prod` 末尾追加**附件 B** 的 6 个 `WECOM_*`。

- ⚠️ **改完 `.env.prod` 须让 api 重读**：`docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate api admin`
  （凭据经 `env_file` 进 api 容器；admin 一起 recreate 顺带加载 §2.1 新 conf）。
- ⚠️ 凭据**只进 `.env.prod`**（运维手册 §4.3 三条纪律）：不写进 compose、不进代码、不贴聊天。`.dockerignore` 已排除 `.env*`，别改它。

---

## 6. 企业微信后台配置

1. 应用管理 → 自建 → 创建应用（接收消息），拿 `AgentID / Secret`。
2. 应用 → 接收消息 → 设置 API：
   - **URL**：`https://<对外域名>/wecom/kb/callback`
     （对外域名 = admin 容器 8080 那层的公网 HTTPS 域名，如 `api.xunlizhinian.cn`；即微信回调能到达 admin nginx 的域名）
   - **Token**：与 `.env.prod` 的 `WECOM_TOKEN` **完全相同**
   - **EncodingAESKey**：点「随机生成」，把 43 字符串填进 `WECOM_ENCODING_AES_KEY`
   - 保存时企业微信发 GET 校验 → 命中 `GET /wecom/kb/callback` 返回 echostr 即通过
3. 可信域名（若后台要求）：填 `<对外域名>`，按提示放校验文件到该域根（复用现有 api 站点静态托管）。
4. **可见范围**：把要操作的同事 + 审批人加进去——只有可见范围内、且已预绑定的 userid 能驱动 bot。

---

## 7. 预绑定同事（管理员操作）

```bash
# 1) 拿管理员 JWT（运营后台登录），记为 $ADMIN_JWT
# 2) 预绑定（operatorToken 必填；审批人另给 approverToken）
curl -X POST "https://<对外域名>/api/v1/wecom/kb/bindings" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"userId":"ZhangSan","operatorName":"张三","operatorToken":"<该同事KB操作员令牌>","approverToken":"<审批令牌,仅审批人>"}'
# 成功返回绑定记录（不含令牌明文）；列表 GET 同路径只回 hasOperatorToken/hasApproverToken 标记
```

管理端点（均受 `AdminGuard` + `Roles('super_admin','admin')`）：`POST` 新增/更新 · `GET` 列表 · `DELETE /:userId` 解绑。

---

## 8. 端到端自测（禁发窗口内或测试环境）

1. 后台「接收消息」点保存 → 校验通过（= GET 回 echostr）。
2. 已绑定同事发 `帮助` → 收到指令帮助文本。
3. 发 `查询 q_orders date=2026-10-20` → 收到查询结果（失败带 `code`+原因）。
4. 两步审批闭环：operator 发 `提交 force_refund orderNo=A123 reason=错单` → 收待审单号 → approver 发 `审批通过 <单号>` → 收执行结果。
5. 未绑定同事发任意消息 → 收「尚未绑定 KB 令牌，请联系管理员」。

---

## 9. 回滚（如异常）

```bash
# 回滚到 .deploy-state 里的 PREV_TAG（默认不回退迁移：多出的列不影响旧代码）
./scripts/rollback.sh

# 仅当明确知道本次迁移与旧代码不兼容（危险：down() 可能 drop 列/表，数据不可找回）：
./scripts/rollback.sh --with-migrate-revert
```

- ⚠️ 旧镜像须仍在本地（回滚不重新构建）—— **勿**在生产机跑 `docker image prune -a`。
- ⚠️ 本回滚脚本**未在真机执行过**（运维手册 §9 注明：开发机无 Docker）；首次真机回滚前建议先 `--dry-run` 看一遍。

---

## 附件 A：nginx `/wecom/` 块（`apps/admin-web/nginx.conf`，插在 `location /api/ {}` 之后）

```nginx
    # ---------- 企业微信 KB 机器人回调 ----------
    # 企业微信回调 XML 原文需保留做签名验真（Nest 侧开 rawBody），故关请求缓冲
    location /wecom/ {
        proxy_pass         http://api:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_request_buffering off;
        proxy_read_timeout      15s;
        proxy_send_timeout      15s;
    }
```

## 附件 B：`.env.prod` 末尾追加（WECOM_*）

```bash
# ============================================================
# 企业微信 KB 助手（路线 B · 对话机器人）
# 建应用后由企业微信后台「接收消息」页获取
# ============================================================
WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx          # 企业 ID（receiveId 验真用）
WECOM_AGENT_ID=100000N                    # 自建应用 AgentId
WECOM_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx # 应用 Secret（取 access_token 用）
WECOM_TOKEN=kb_callback_token_xxxx         # 回调 URL 校验 + 消息签名（自定义字符串）
WECOM_ENCODING_AES_KEY=43位EncodingAESKey # 后台随机生成，Base64 解码后须为 32 字节
# 可选：bot 内网回放基址；默认 http://127.0.0.1:${PORT||3000}，容器内 api 监听 3000，一般无需改
# WECOM_INTERNAL_API_BASE=http://127.0.0.1:3000
```

---

## 勾选检查表

- [ ] 选在禁发窗口外的可发时段（§1）
- [ ] §2.1 nginx `/wecom/` 块已加、已提交、已推送
- [ ] §2.2 企业微信凭据已拿到
- [ ] §2.3 各同事令牌 + userid 已备
- [ ] §3 `git pull` + `deploy.sh`（先 --dry-run）
- [ ] §4 `migration:show` 见 `WecomBinding1700000000013` = `[X]`
- [ ] §5 `.env.prod` 填 WECOM_* 并重跑 `up -d --force-recreate api admin`
- [ ] §6 后台应用 URL/Token/EncodingAESKey 一致、可见范围已加人
- [ ] §7 各同事已预绑定（列表接口确认 hasOperatorToken）
- [ ] §8 端到端自测 5 项全过
