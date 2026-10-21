# ABox 一盒 · 企业微信 KB 助手部署操作卡 v1.0

> 版本：**v1.0**（2026-10-20 · 路线 B 对话机器人）
> 配套代码：`apps/api-server/src/modules/wecom-kb/`（11 文件）+ 迁移 `1700000000013-wecom-binding`
> 关联文档：《ABox一盒部署运维手册v1.0.md》·《ABox一盒操作员权限矩阵v1.0.md》
> 适用：让同事**不用电脑**、在企业微信里直接发指令操作 KB 替操作台（查询 / 执行 / 提交审批 / 审批 / 撤回）。

---

## 一、架构一句话

```
同事手机企业微信 ──发消息──▶ 企业微信服务器 ──HTTPS 回调──▶ admin nginx(/wecom/) ──▶ api:3000
                                                                                        │
   api:3000 内网回放 KB 网页的请求（复用 /api/v1 端点 + X-KB-* 头）◀───────────────────┘
      │  取 ab_wecom_binding（userid↔令牌）
      ▼  后台校验/幂等/审计/禁止清单/强制改密 原样生效（单一真源）
   结果 ──主动发消息──▶ 同事企业微信
```

**铁律**：bot 不另写 op 逻辑，只把 KB 网页的请求在服务器内网重放一遍。所以后台的全部安全闸（幂等键、审计、禁止清单、强制改密）对 bot 同样生效。

---

## 二、前置条件（逐项打勾）

| # | 条件 | 判据 |
| --- | --- | --- |
| 1 | 企业微信管理员后台能建「自建应用（接收消息）」 | 拿到 `CorpID / AgentID / Secret / Token / EncodingAESKey` |
| 2 | 回调域名已备案 + HTTPS | `curl -I https://<你的api域名>/` 返回 200（沿用现有 api 子域，如 `api.xunlizhinian.cn`） |
| 3 | 能在 api 域根/可访问路径放企业微信域名校验文件 | 后台「可信域名」校验用（与回调同域即可） |
| 4 | 代码已合入 `origin/main` 并部署 | 本次提交含 `wecom-kb` 模块 + 迁移 `1700000000013` |
| 5 | 各同事的预签发令牌已就绪 | operator 令牌 +（审批人）approver 令牌，与 KB 网页用的同一套 |

---

## 三、环境变量（追加到 `.env.prod`）

凭据**只进 `.env.prod`**，不写进代码、不进聊天（见部署手册 §4.3 三条纪律）。在 `.env.prod` 末尾追加：

```bash
# ============================================================
# 企业微信 KB 助手（路线 B · 对话机器人）
# 建应用后由企业微信后台「接收消息」页获取
# ============================================================
WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx          # 企业 ID（receiveId 验真用）
WECOM_AGENT_ID=100000N                    # 自建应用 AgentId
WECOM_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx # 应用 Secret（取 access_token 用）
WECOM_TOKEN=kb_callback_token_xxxx         # 回调 URL 校验 + 消息签名（自定义字符串）
WECOM_ENCODING_AES_KEY=43位EncodingAESKey # 企业微信后台生成，Base64 解码后须为 32 字节
# 可选：bot 在 api 容器内网回放请求用的基址；默认 http://127.0.0.1:${PORT||3000}
#       容器内 api 监听 3000（APP_PORT=3000），默认即可，一般无需改。
# WECOM_INTERNAL_API_BASE=http://127.0.0.1:3000
```

⚠️ `WECOM_ENCODING_AES_KEY` 是**43 字符**的 EncodingAESKey（企业微信后台「接收消息 → 设置 API 接收 → 随机生成」），不是你自己编的串；Base64 解码后必须正好 32 字节，否则服务启动自检即报错。

---

## 四、nginx 反代（admin-web/nginx.conf）

> ✅ **本块在 `origin/main` @ `52ef1e8` 已写入** `apps/admin-web/nginx.conf`。部署时 `git pull` 即带，**勿重复插入**（重复 `location /wecom/` 会让容器 `nginx -t` 报错）。下方片段仅作真源校验参考。

现有 `apps/admin-web/nginx.conf` 把 `/api/`、`/static/`、`/wecom/` 反代到 `api:3000`。bot 回调在 `/wecom/`，与 `/api/` 同款反代。已落盘内容：

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

> 若你的 HTTPS 是在**宿主机层**（而非 admin 容器内）做 SSL 终止再反代到 8080，请确保那一层也放行 `/wecom/` 路径（整段转发即可），否则请求到不了 admin nginx 的 `/wecom/` 块。

---

## 五、代码部署

### 主路径：deploy.sh（推荐，自动跑迁移）

```bash
cd /opt/abox-onebox            # 服务器上的交付目录
git pull                        # 取含 wecom-kb 的 main
./scripts/deploy.sh            # 预检 → 备份 → 起依赖 → 构建 → 执行迁移 → up -d → 健康验证
```

`deploy.sh` 第 5 步会自动执行数据库迁移，含本次新增的 `1700000000013`。

### 手动路径（git archive 投递，无 .git）

若沿用「`git archive` + scp + `tar xzf`」交付（见 working memory：服务器无 `.git`）：

```bash
# 1) 本机打归档（在含 .git 的工作区）
git archive --format=tar.gz -o /tmp/abox-wecom.tar.gz HEAD
# 2) 投递 + 解包到 /opt/abox-onebox（覆盖，勿 rm -rf 旧产物）
scp /tmp/abox-wecom.tar.gz abox-srv:/opt/abox-onebox/incoming/
ssh abox-srv "cd /opt/abox-onebox && tar xzf incoming/abox-wecom.tar.gz"
# 3) 重启 api（镜像/进程按你的实际方式）
# 4) 手动跑迁移（见第六节命令）
```

---

## 六、迁移核对（必做）

迁移执行后核对 `ab_wecom_binding` 已建。在 api 容器内执行（与 `deploy.sh` 同源 data-source）：

```bash
# 容器内（dist 已构建）
node node_modules/typeorm/cli.js migration:show -d apps/api-server/dist/database/data-source.js
# 期望列出 WecomBinding1700000000013 且标记为 [X]（已应用）
```

若需单独跑迁移（手动交付时）：

```bash
node node_modules/typeorm/cli.js migration:run -d apps/api-server/dist/database/data-source.js
```

表结构（`ab_wecom_binding`）：`userid`(PK) / `operator_name` / `operator_token`(可空) / `approver_token`(可空) / `created_at` / `updated_at`。

---

## 七、企业微信后台配置

1. **建应用**：企业微信管理后台 → 应用管理 → 自建 → 创建应用（接收消息），拿到 `AgentID / Secret`。
2. **填 API 接收**：应用 → 接收消息 → 设置 API →
   - URL：`https://<你的api域名>/wecom/kb/callback`
   - Token：填与 `.env.prod` 里 **`WECOM_TOKEN`** 完全相同的串
   - EncodingAESKey：点「随机生成」，把得到的 43 字符串填进 **`WECOM_ENCODING_AES_KEY`**
   - 保存时企业微信会发一次 GET 校验 → 命中 `GET /wecom/kb/callback`，返回解密 echostr 即通过。
3. **可信域名**（若后台要求）：在应用「可信域名」里填 `<你的api域名>`，并按提示把校验文件放到该域根路径（复用现有 api 站点的静态托管/反代即可）。
4. **可见范围**：把要操作的同事（及审批人）加到应用可见范围——只有可见范围内的 userid 能发消息、且 bot 按 `FromUserName`(=userid) 取绑定。

---

## 八、预绑定同事（管理员操作）

bot 按企业微信 `userid` 取令牌。管理员用 super_admin/admin 的 JWT 调绑定端点：

```bash
# 1) 拿管理员 JWT（从运营后台登录，或你们现有的 admin 登录接口），记为 $ADMIN_JWT
# 2) 预绑定一个同事（operator 令牌必填；审批人另给 approverToken）
curl -X POST "https://<你的api域名>/api/v1/wecom/kb/bindings" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "ZhangSan",
    "operatorName": "张三",
    "operatorToken": "<该同事的 KB 操作员预签发令牌>",
    "approverToken": "<该同事的 KB 审批人预签发令牌，仅审批人需要>"
  }'
# 成功返回绑定记录（不含令牌明文）
```

配套管理端点（均受 `AdminGuard` + `Roles('super_admin','admin')` 保护）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/wecom/kb/bindings` | 新增/更新绑定（令牌留空串 = 清空该令牌） |
| `GET` | `/api/v1/wecom/kb/bindings` | 列表（**不回显令牌明文**，只回 `hasOperatorToken`/`hasApproverToken` 标记） |
| `DELETE` | `/api/v1/wecom/kb/bindings/:userId` | 解绑 |

> `operatorToken` / `approverToken` 与 KB 网页里同事粘贴的预签发令牌是**同一套**——从你们现有的令牌签发流程取，不要新造。

---

## 九、端到端自测

1. **URL 校验**：在企业微信后台「接收消息」点保存，观察是否提示校验通过（= `GET /wecom/kb/callback` 返回正确 echostr）。
2. **发消息**：用已绑定的同事企业微信，给应用发 `帮助` → 应收到指令帮助文本回执。
3. **查状态**：发 `查询 q_orders date=2026-10-20` → 应收到对应查询结果（失败会带 `code` 与原因）。
4. **两步审批闭环**：operator 发 `提交 force_refund orderNo=A123 reason=错单` → 收到待审单号 → approver 发 `审批通过 <单号>` → 收到执行结果。
5. **未绑定提示**：用未绑定的同事发任意消息 → 应收到「尚未绑定 KB 令牌，请联系管理员」提示。

---

## 十、指令速查（同事在企业微信里发）

```
帮助                                  查看全部可用指令
我的申请                              查看我提交的待审/进度
查询 q_orders date=2026-10-20         只读查数（q_my_requests / q_orders / q_assignment ...）
执行 publish_assignment id=123 action=publish   直执行 low 危 op（high/mid 仍过后台校验）
提交 force_refund orderNo=A123 reason=错单       提交两步审批申请（operator）
撤回 <requestId> reason=...           撤回未审批申请
审批通过 <requestId>                  审批通过（approver）
审批拒绝 <requestId> reason=...       审批拒绝（approver）
```

参数写法：`key=value`，多值用逗号 `ids=1,2,3`。op 与查询码与 KB 网页 `OPS_CATALOG` 同源（见 `op-meta.ts`）。

---

## 十一、已知边界与回滚

**边界（设计取舍，非缺陷）**
- 指令是**结构化命令语言**（保证可追溯、不误执行）；自由自然语言留作后续。
- bot 走官方 HTTP API（`qyapi.weixin.qq.com`），不依赖 WorkBuddy 企业微信连接器也能收发；但稳定性建议你从左侧「+」开启企业微信连接器。
- 回调 POST 立即回 200、结果走主动发消息（避开企业微信 5s 超时重试）；用 `MsgId` 做 5 分钟去重，重试不会重复执行写操作。
- `op-meta.ts` 与 KB 前端 `OPS_CATALOG` 同源独立维护——前端改目录时此处须同步。

**回滚**
- 代码回滚：`rollback.sh`（保留新迁移列通常更安全，见部署手册 §5.5「默认不回退迁移」）。
- 模块隔离：`wecom-kb` 为独立模块，凭据缺失时仅自检 warn、不阻塞启动；若要彻底下线，从 `AppModule` 摘掉 `WecomKbModule` 并删 nginx 的 `/wecom/` 块即可。

**安全**
- 令牌明文存 `ab_wecom_binding`（管理员预绑定路线固有形态）；管理列表接口不回显明文。
- `WECOM_*` 凭据只进 `.env.prod`，按部署手册 §4.3 三条纪律管理。
