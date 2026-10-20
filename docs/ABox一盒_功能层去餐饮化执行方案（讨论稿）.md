# ABox 一盒 · 功能层去餐饮化执行方案（讨论稿）

> 状态：讨论稿 · 未执行任何改动
> 范围（用户已裁定）：**P0 + P1 + P2**（必做漏网 + API 契约重命名 + 品类轴 label 去餐饮化）
> 目的：展示端已中性化（主件/辅品/素品/附品/随附/档位/商品），本方案消除功能层的概念漂移与 C 端漏网餐饮词。

---

## 〇、关键简化（先说结论）

- **P0-2 溯源页漏网被 P2 自动覆盖**：C 端 `traceability.vue` 通过 `DISH_CATEGORY_LABEL` 渲染品类标签。P2 只改该 label 的**值**（主荤→主件…），引用名 `DISH_CATEGORY_LABEL` 不变 ⇒ 溯源页**零代码改动**即中性化。因此 P0-2 不再单列代码改动，仅作验证项。
- **商品真实名（红烧肉等）不改**：溯源页 `dishName` 是真实业务数据，不属于术语去餐饮化。
- **合规证照与真实业务描述不改**：`食品经营许可证`/`营业执照`/`food_license`；供应商主营品类（本帮菜/京味等）。

---

## 一、风险分层（决定发版策略）

| 层级 | 性质 | 是否破坏性 | 发版影响 | 风险 |
|---|---|---|---|---|
| P0-1 取消理由 label | 改中文展示值 | 否 | 后端单独发版即可 | 极低 |
| P0-3 注释同步 | 改注释 | 否 | 无 | 零 |
| P2 品类轴 label | 改中文展示值 | 否 | 后端单独发版即可 | 低 |
| **P1 契约重命名** | 改 API 字段名/类型名 | **是** | **需后端 + 小程序 + 后台三端同步发版** | 中-高 |

> ⚠️ P1 是破坏性契约变更：端上按 `dishId`/`dishName`/`dishes` 取数据，字段改名后若任一端未同步发版，会出现"取不到字段"的线上故障。必须作为版本化变更协调发版。

---

## 二、改动清单

### 2.1 P0-1 取消/评价理由 label（C 端选项 + 后台导出直接展示）

文件：`packages/shared-types/src/dto/cancel-reason.dto.ts` · `CANCEL_REASON_LABEL`

| 键 | 旧 label | 建议新 label | 说明 |
|---|---|---|---|
| `dish_dislike` | 菜品不合口味 | **内容不合口味** | 直接 C 端可见，最该改 |
| `delivery_time` | 送餐时间不合适 | **配送时间不合适** | "送餐"餐饮词 |
| `ate_elsewhere` | 改在别处吃 | **改在别处就餐**（候选：保留"吃"） | "吃"是否去化待定 |
| 其余 | 临时有事/不在办公室、价格/预算、重复下单/下错了、其他、超时未支付（系统截单） | 不改 | 无餐饮词 |

> 注：枚举键（`dish_dislike` 等英文）不改，仅改中文值；`CANCEL_REASON_LABEL` 也用于后台导出，一改全端中性。

### 2.2 P0-3 注释同步（修复类型层与展示真源的漂移）

文件：`packages/shared-types/src/dto/home.dto.ts:8`

- 旧：`/** 档位：1 主荤 / 2 半荤 / 3 素菜 / 4 汤 / 5 主食 */`
- 新：`/** 档位：1 主件 / 2 辅品 / 3 素品 / 4 附品 / 5 随附 */`（对齐 `biz.ts` 的 `SET_MEAL_SLOT_LABEL` 真源）

### 2.3 P2 品类轴 label 去餐饮化（后台菜品库/角标 + 顺带覆盖 C 端溯源页）

文件：`packages/shared-types/src/enums/supplier-admin.ts` · `DISH_CATEGORY_LABEL`

| 枚举值 | 旧 label | 新 label（与档位轴对齐） |
|---|---|---|
| `MAIN` | 主荤 | **主件** |
| `HALF` | 半荤 | **辅品** |
| `VEG` | 素菜 | **素品** |
| `SOUP` | 汤品 | **附品** |
| `STAPLE` | 主食 | **随附** |

- 引用名 `DISH_CATEGORY_LABEL` / `DISH_CATEGORY_OPTIONS` **不改名**，仅在 P2 改值 ⇒ 前端 `traceability.vue` 的 `categoryLabel()` 无需改代码。
- 同步更新 `supplier-admin.ts:160` 附近注释：原注释警告"不要把汤品改成汤、不要合并两轴"。P2 实测是"**展示词对齐、字段/枚举仍分离**"（category 值 main/half/veg/soup/staple 与 slot 1–5 仍是两字段），需在注释里澄清，避免后人误以为违反约束。
- 枚举值的开发注释（172–180 行 `主荤（红烧肉/东坡肉）` 等）属开发者文档，建议同步改为中性（主件/辅品…），或保留（纯内部）。

### 2.4 P1 API 契约重命名（dish* → item*）

#### 字段/类型映射表（真源：shared-types DTO）

| 旧 | 新 | 出现位置 |
|---|---|---|
| `dishes` | `items` | home.dto（MealDishView[]）、traceability.dto（TraceabilityDishView[]） |
| `dishNames` | `itemNames` | home.dto |
| `dishId` | `itemId` | order.dto、rating.dto |
| `dishName` | `itemName` | order.dto、rating.dto、traceability.dto |
| `mainDishName` | `mainItemName`（候选 `mainName`） | order.dto |
| `MealDishView` | `MealItemView` | home.dto |
| `TraceabilityDishView` | `TraceabilityItemView` | traceability.dto |
| `DishRatingRow` | `ItemRatingRow` | rating.dto |
| `DishRatingView` | `ItemRatingView` | rating.dto |
| `dishCount` | `itemCount` | rating.dto |
| `worstThree[].dishId/dishName` | `itemId/itemName` | rating.dto |
| `items: DishRatingRow[]` | `ItemRatingRow[]` | rating.dto |

> **不动**：`DISH_CATEGORY_LABEL` / `DISH_CATEGORY_OPTIONS` / `.category` / `categoryLabel()`（属 P2，改值不改名）。
> **待定**：`mealDate` 等 `meal` 系——见 §四决策点 2。

#### 影响面统计（grep 命中文件数，已去重）

| 端 | 文件数 | 代表文件 |
|---|---|---|
| 小程序 `miniprogram` | 10 | order-detail.vue(21)、traceability.vue(8)、index.vue、supplier/detail.vue、api/order.ts |
| 后台 `admin-web` | 25 | dish-library.vue(19)、stats/dish-heat.vue(6)、meal/edit.vue(14)、api/meal.ts、api/supplier*.ts |
| 后端 `api-server` | ~80（含 `.category`/`mealDate`，纯 dish 字段更少） | rating.service、traceability.service、meal.service、order 相关 |
| 类型 `shared-types` | 6 | home/order/rating/traceability/create-order/supplier-qualification dto |
| e2e 脚本 | 需补充 grep | scripts/e2e-m1/m2/m3 断言这些字段 |

#### P1 破坏性处理策略（必读）

- **方案 A（推荐 · 同步发版）**：后端 + 小程序 + 后台在同一发版窗口同时上线新字段名。优点：一次性干净；缺点：三端必须严格同步，任一端延迟即故障。
- **方案 B（兼容过渡）**：后端先同时下发新旧字段（旧 `dishes` + 新 `items`）一段时间，端上逐步切到新字段后，再下个版本移除旧字段。优点：无发版耦合；缺点：临时双字段、工作量翻倍。

---

## 三、回退策略

沿用展示层已验证的幂等机制（scripts 下 neutralize 系列）：

- 为每个改动层写**幂等替换脚本**（按子串精确命中；旧串不在但含新串→跳过；都不含→报错退出，绝不静默误改）。
- 反向回退脚本对调 from/to。
- 副本实跑验证：回退后差异恰好 = 覆盖范围，再正向还原差异归零。
- P1 因是破坏性契约变更，**回退意味着恢复旧字段名**——同样需三端同步回退，不能只退后端。

---

## 四、待你确认的决策点

1. **`ate_elsewhere` 改法**：`改在别处就餐`（彻底去化）/ 保留 `改在别处吃`（"吃"视为通用动词）。
2. **`mealDate` 及 `meal` 系是否纳入 P1**：建议**不纳入**（meal=套餐，内部语义不妨碍，改名波及极大、收益低，与 P3 表名重构同处理）；若坚持改，需额外评估 `boxDate`/`deliveryDate` 命名与三端同步。
3. **P1 发版策略**：同步发版（A）/ 兼容过渡（B）。
4. **执行顺序**：建议第一批先做 P0+P2（非破坏、立即消除 C 端漏网、低风险），第二批再做 P1（破坏性、需发版协调）。是否同意拆分批次？

---

## 五、验证

- 每批完成后跑 `node scripts/gate.mjs all`（30 道静态+构建+单测）与 `node scripts/gate.mjs verify`（seed + e2e 全链路）。
- P1 额外：e2e 断言字段名同步改；真机验证小程序/后台三端字段对齐无取空。

---

## 六、不纳入本次（明确排除）

- P3 数据库表名/实体类大重构（`ab_dish`/`ab_set_meal*`/`ab_meal_assignment`/`MealEntity` 等）—— 高成本高风险，留待专门重构。
- 合规证照、真实商品名、供应商主营品类 —— 真实业务数据/法律要求。
- P5 后端 ~70 文件注释里的"菜品/餐/一饭四菜"等纯内部措辞 —— 可选轻改，不阻塞，可后续顺手做。
