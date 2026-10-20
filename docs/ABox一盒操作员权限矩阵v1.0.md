# ABox 一盒 · 操作员权限矩阵 v1.0

> 生成日期：2026-10-19
> 真源：KB 前端 `index.html` 内 `OPS_CATALOG`（16 op）、`OP_DANGER`（危险分级）、`opDanger()` 回退、`execOp`/`submitRequest` 路由与 P2 低危免确认分支。
> 本文件为「内部助手（知识助手）操作员权限」的权限矩阵，不涉及 ABox 小程序买家端、团长端或后台 admin-web 的独立权限体系。

## 一、判定口径

| 维度 | 真源 | 说明 |
| --- | --- | --- |
| 操作清单 | `OPS_CATALOG`（10503 行起） | 当前共 16 个可编排后台操作，每个带 `label / method / endpoint / risk / required / optional / notes` |
| 危险分级 | `OP_DANGER`（10599 行起） | `high`=动钱/动订单/动人员；`mid`=改商品/套餐/分配等结构性；`low`=撤回等可逆低风险 |
| 运行时分级 | `opDanger(code)`（10606 行） | 命中 `OP_DANGER[code]` 用显式值；否则 `OPS_CATALOG[code].risk==='admin' ? 'mid' : 'low'`（fallback） |
| 路由 | `risk==='admin'` → `submitRequest`（两步审批）；`risk==='operator'` → `execOp`（直执行） | 见 11141 行 `isAdmin` 分发与按钮绑定 |
| P2 低危免确认 | `execOp` 内 `_dg === 'low'` 分支（11334 行） | 仅 operator 直执行路径：low 免二次确认弹窗，仍过禁止清单 + 幂等键 |

## 二、全量 16 op 矩阵

危险分级分布：**high 7 / mid 8 / low 1**（合计 16，全部在 `OP_DANGER` 显式登记）。

| # | op code | 操作 | 归属类 | danger | 路由 | P2 免确认 | 影响说明（节选） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | create_dish | 上架新菜品（新增商品） | admin | mid | 审批流 | 不适用（审批流必确认） | 直接改供应商应付与平台毛利 |
| 2 | batch_dish_status | 批量上下架菜品 | admin | high | 审批流 | 不适用 | admin 专属高危 |
| 3 | edit_dish | 编辑菜品 | admin | mid | 审批流 | 不适用 | admin 专属 |
| 4 | create_meal_template | 组合套餐（存为模板） | operator | mid | 直执行 | 有确认弹窗 | operator 可操作（中低风险） |
| 5 | edit_meal_template | 编辑套餐模板 | operator | mid | 直执行 | 有确认弹窗 | operator 可操作 |
| 6 | assign_meal | 给楼分配套餐（创建分配） | operator | mid | 直执行 | 有确认弹窗 | operator 可操作 |
| 7 | publish_assignment | 上架/下架套餐分配 | operator | mid | 直执行 | 有确认弹窗 | operator 可操作 |
| 8 | edit_assignment | 编辑套餐分配 | operator | mid | 直执行 | 有确认弹窗 | operator 可操作 |
| 9 | copy_assignment | 批量复制套餐分配 | operator | mid | 直执行 | 有确认弹窗 | operator 可操作 |
| 10 | change_leader | 变更团长（等级/楼/层） | admin | high | 审批流 | 不适用 | 直接改佣金费率（高危） |
| 11 | appoint_leader | 任命/转交团长 | admin | high | 审批流 | 不适用 | admin 专属 |
| 12 | leader_audit | 团长资质补录（停职/恢复/补签） | admin | high | 审批流 | 不适用 | admin 专属 |
| 13 | send_message | 群发运营通知（按场景触达） | admin | high | 审批流 | 不适用 | 对外部用户有触达影响 |
| 14 | manual_adjust | 手动改单（改份数/改取餐楼） | admin | high | 审批流 | 不适用 | 直接改订单 |
| 15 | force_refund | 强制退款（原路退+反向结算） | admin | high | 审批流 | 不适用 | 直接动钱（含反向结算，高危） |
| 16 | recall_request | 撤回未审批申请 | operator | low | 直执行 | **生效（免二次确认）** | operator 撤回自己提交的待审单（中低危可逆） |

路由汇总：
- **审批流 `submitRequest`（两步审批，后台自动执行）**：9 个 = 7 high + 2 mid，全部 `admin` 归属。
- **直执行 `execOp`（带操作员令牌真实写库）**：7 个 = 6 mid + 1 low，全部 `operator` 归属。

## 三、P2 低危免确认 · 核验结论

- P2「低危免确认」**仅作用于 `execOp` 路径**的 `_dg === 'low'` 分支（11334 行）：low 操作不弹二次确认，直接执行（仍过禁止清单 + 幂等键）。
- 审批流 `submitRequest` 路径（11145 行按钮 + 11352 行确认弹窗）**无论 danger 一律弹确认**，仅 high 加 danger 样式；P2 免确认不涉及该路径。
- 现行 16 op **全部在 `OP_DANGER` 显式登记**，`opDanger()` 永不走 fallback，因此**无现行误判**：唯一 `low` 的 `recall_request`（撤回待审单，可逆）正好是应免确认的操作；其余 operator 操作均为 mid，仍保留确认弹窗。

## 四、残留风险与建议（不阻塞发布）

**风险**：`opDanger()` fallback 对「未登记 `OP_DANGER` 的 op」按归属类回退——`operator` 漏登 → `'low'`，`admin` 漏登 → `'mid'`。后果：
- `operator` 类新 op 若漏登 `OP_DANGER`，会静默回退 `'low'`，`execOp` 跳过二次确认弹窗（安全底线仍在后端 RBAC + 禁止清单 + 幂等键，但前端这道 UX 闸门会丢）。
- `admin` 类漏登回退 `'mid'`，仍走 `submitRequest` 必确认，无影响。

**建议（两条并行最稳）：**
- **A（运行时兜底）**：将 fallback 改为 `risk==='admin' ? 'mid' : (risk==='operator' ? 'mid' : 'low')`——未登记 op 一律按 `mid` 至少保留 `execOp` 确认弹窗；只有显式登记 `'low'`（如 `recall_request`）才免确认。
- **B（提交时兜底）**：加 CI 断言 `Object.keys(OPS_CATALOG).every(k => k in OP_DANGER)`，新增 op 漏登 `OP_DANGER` 即门禁失败。

## 五、与「禁止清单」的关系

- 禁止清单（`kbBlocklist` 本机 / `ab_op_blocklist` 后台）是**独立于 danger 的维度**：任何人可把任意 op 列入禁止，前端在 `execOp`/`submitRequest` 入口直接拦截（11315、11370 行）。
- 后台侧 `OpBlocklistInterceptor` 对携带 `X-KB-OpBlock` 的写请求全局拦截（op 在 `ab_op_blocklist` 抛 `30024`）。
- 结论：**「免确认」≠「免禁止」**。P2 免确认只去掉 `execOp` 的二次确认弹窗；禁止清单与后端 `30024` 闸仍然有效，且 `recall_request` 即便免确认，被禁后仍不可执行。

## 六、与强制改密（项②）的关系

- 后端 `AdminGuard` 在 `mustChangePassword=1` 时对所有业务接口统一返回 `10007`；KB 前端 `execOp`/`submitRequest`/`approvalPost`/`memRecall` 四处 `10007` 分支已接入 `kbMustChange()` 改密 modal（见 11258 行 helper）。
- 改密成功后清空本地令牌并提示重新登录后台获取新令牌。该机制与 danger 分级、禁止清单正交，叠加生效。
