# ABox 一盒 · 功能层去餐饮化 · P3 数据库重构 + P1 契约重命名 合并方案（草稿）

> 状态：**讨论稿，未执行**。本文用于评审与决策，所有代码改动待拍板后再动手。
> 关联文档：`ABox一盒_文案去餐饮化方案v1.0.html`（展示层 336 处 + 功能层 P0/P2 已交付，见第十节）。
> 起草日期：2026-10-14

---

## 〇、为什么必须合并，不能再"只改展示层 / 只改 DTO"

上一轮功能层去餐饮化，我们执行了 **P0（取消理由 label）+ P2（品类轴 label）**，彻底消除了 C 端用户可见的餐饮词漏网，门禁 `all` 30/30 零回归。

但当时把 **P1（API 契约 `dish*`→`item*`）暂缓、并入 P3**，理由是：回源调研发现 `dish` 相关词在后端不只存在于 API 契约 DTO，还大量躺在**数据库实体层**（`Dish` 实体 / `ab_dish` 表 / `dishRepo` / `dishIds` / `dishesOfSetMeal` 等），且与 P3 数据库重构边界高度交织——`dishId` 子串替换会误伤实体层 `dishIds`（菜品 id 数组），无法干净隔离出"纯 API 契约层"。

**这一轮要做的事，就是当初推迟的合并重构。** 合并后，整条概念链一次性统一：

```
展示层（已中性化）           功能层（本次目标）
商品 / 档位 / 主件…   ←→   内部 item / 数据库 ab_item / 接口 itemId
```

如果不合并，长期会留下"前端说商品、DTO 说 dish、数据库说 ab_dish"的三层概念漂移，是维护隐患，且后续任何新接口都会继续产出 `dishId` 这类字段，越积越难改。

---

## 一、统一术语命名映射（建议值）

内部物理层统一为"**商品 / item**"概念（与 C 端已用的"商品"语义对齐；`item` 在英文里是"项/商品项"，最通用、不与"套餐/订单"等冲突）。

### 1.1 实体 / 仓库 / 局部变量 / 方法名

| 现状 | 建议改 | 类型 |
|---|---|---|
| `Dish` 实体类 | `Item` | 类名 |
| `dishRepo: Repository<Dish>` | `itemRepo: Repository<Item>` | 注入变量 |
| `i.dishId`（局部） | `i.itemId` | 局部变量 |
| `dishIds` 数组 | `itemIds` | 局部变量 |
| `dishesOfSetMeal(...)` | `itemsOfSetMeal(...)` | 方法名 |
| `ab_dish_rating.dish_id` | `item_id` | 外键列 |

### 1.2 数据库表名（破坏性 DDL）

| 现状 | 建议改 | 影响 |
|---|---|---|
| `ab_dish` | `ab_item` | **改名 DDL**（历史数据 RENAME） |
| `ab_dish_rating` | `ab_item_rating` | 改名 DDL |
| `ab_supplier_dish_daily` | `ab_supplier_item_daily` | 改名 DDL |
| `ab_supplier_dish_center_daily` | `ab_supplier_item_center_daily` | 改名 DDL |
| `ab_set_meal_item.dish_id` 列 | `item_id` 列 | **改列名 DDL** |

### 1.3 API 契约字段（原 P1 范围）

| 现状（DTO/前端/断言） | 建议改 |
|---|---|
| `dishes` | `items` |
| `dishId` | `itemId` |
| `dishName` | `itemName` |
| `dishNames` | `itemNames` |
| `mainDishName` | `mainItemName` |
| `dishCount` | `itemCount` |
| `MealDishView` | `MealItemView` |
| `TraceabilityDishView` | `TraceabilityItemView` |
| `DishRatingRow` | `ItemRatingRow` |
| `DishRatingView` | `ItemRatingView` |

---

## 二、实测影响面（grep 全仓，2026-10-14）

> ⚠️ 以下统计用 `[Dd]ish|Dishes|Meal|mealDate|setMeal` 同时命中了 `dish` 与 `meal` 两系，**落地前需再用精确正则拆分 `dish-only` 与 `meal-only`**，此处给范围供评审规模。

| 仓库 | 含 dish/meal 标识的文件数（估算） | 备注 |
|---|---|---|
| `packages/shared-types` | ~8 文件 | DTO + enums（supplier-admin.ts 最密） |
| `packages/shared-utils` | ~1 文件 | `biz.ts` |
| `apps/api-server`（后端） | **~130 文件** | 含实体/表/裸 SQL/字段/注释；`dish` 真实数需拆分，但量级很大 |
| `apps/admin-web`（后台） | ~45 文件 | 含 meal 混合 |
| `apps/miniprogram`（小程序） | ~19 文件 | 含 meal 混合 |
| `apps/api-server/test`（e2e 断言） | 多文件 | m1/m2/m3 含 `dishId`/`dishes` 字段断言，需同步 |

**结论**：这是一次**全栈级重构**，不是"改几个字段"。真实改动点保守估计 **数百处**，涉及 5 个包、200+ 文件。规模与风险远大于展示层那次 336 处（那次零逻辑改动）。

### 2.1 关键高风险文件（局部抽查确认）

- `apps/api-server/src/database/migrations/1700000000000-init.ts`：`CREATE TABLE ab_dish` 等建表（IF NOT EXISTS），改名需**新增独立迁移**而非改 init。
- `apps/api-server/src/database/migrations/1700000000003-dish-rating.ts`：`CREATE TABLE ab_dish_rating`，同上。
- `apps/api-server/src/database/seeds/seed.ts`：`dishRepo` + 裸 `dishRepo.clear()/save`。
- `apps/api-server/src/database/seeds/seed-demo.ts`：**大量裸 SQL** `DELETE FROM ab_meal_assignment`、`SELECT … FROM ab_set_meal`、`SELECT id, cost_price FROM ab_dish`、`ab_set_meal_item` 等——表名/列名硬编码，改名必须同步。
- `apps/api-server/src/modules/supplier/dish/dish-admin.service.ts`：整文件围绕 `ab_dish`/`dishRepo`，且**目录名本身叫 `dish/`**（`modules/supplier/dish/`），是否一并改目录名也需决策。
- `apps/api-server/src/modules/meal/meal.service.ts`：`dishesOfSetMeal()` 方法、`dishRepo` 注入。
- 多模块 service（order/rating/finance/supplier/stats）：均有 `this.dishRepo` 注入与 `dishId` 局部变量。

---

## 三、技术难点与风险

1. **【最高风险】数据库表/列改名 = 破坏性 DDL**
   - 存量生产数据需 `RENAME TABLE ab_dish TO ab_item` 等；列改 `dish_id→item_id` 需 `ALTER TABLE`。
   - 主键/外键/索引需重新核对；`ab_set_meal_item.dish_id` 是外键指向 `ab_dish.id`，改名要一并处理。
   - 旧库已存在这些表，`init.ts` 用 `IF NOT EXISTS` 不会重建——**必须单独写一条"改名迁移"**，且幂等（先判表是否存在旧名）。

2. **【高】子串误伤**
   - `dishId` 同时是"API 字段"和"实体局部变量"，全仓替换 `dishId→itemId` 会同时命中两者——这其实是**想要的**（整条链统一），但要确认不会误伤非 `dish` 语义的词（如 `dishing` 等英文单词；实测 `dishes` 作为英文"盘子"语义在代码里基本没有，都是"菜品"语义，可整体替换，但需逐文件 grep 复核）。
   - `dishesOfSetMeal` 是方法名，要整体改名而非子串。

3. **【中】TS 全仓 typecheck 必须过**
   - `Dish` 实体改名后，所有 `import { Dish }`、`Repository<Dish>`、`@Entity` 引用都要跟着改；NestJS DI 注入 token 也依赖类名。
   - 后端 3 个 typecheck 门禁 + 3 个构建门禁会全部重跑。

4. **【中】e2e 全链路断言同步**
   - `gate.mjs verify` 的 m1/m2/m3 含 `dishId`/`dishes` 字段级断言，改名后断言必须同步，否则 verify 红。

5. **【中】种子数据裸 SQL**
   - `seed.ts`/`seed-demo.ts` 大量裸 SQL 写死表名/列名，是改名最易漏的点（typecheck 抓不到 SQL 字符串）。

6. **【低】门禁 `lock:version` / `dup:const` / `nav:consistency`**
   - 涉及真源字面量外溢、pages/manifest 一致性，改名若动到这些需复核。

---

## 四、执行批次建议（避免一次性巨型 PR）

合并后虽是"一次发版"，但**代码改动按批提交、分批 review** 更稳：

- **批 A（代码层，纯重命名，可独立 review）**：`Dish`→`Item` 实体类、`dishRepo`→`itemRepo`、局部 `dishId`→`itemId`、`dishIds`→`itemIds`、`dishesOfSetMeal`→`itemsOfSetMeal`。
  - 注意：批 A 改了实体类名后，**同一次部署**必须连带批 B/C，否则编译不过——所以批 A/B/C 是"同一发版窗口内的连续 commit"，不是可独立上线的 PR。
- **批 B（契约层，原 P1）**：DTO 字段 `dishes/dishId/dishName/…→item*`，前端引用、e2e 断言同步。
- **批 C（DB 层，破坏性）**：新增改名迁移（`ab_dish→ab_item` 等 + 列改名），`seed.ts/seed-demo.ts` 裸 SQL 同步，`app.module.ts` 实体注册同步。
- **批 D（清理层）**：注释/文档去餐饮化（`一饭四菜`、`菜品` 等内部注释、`dish-rating` 迁移注释），以及**目录名 `modules/supplier/dish/` 是否改名**（见决策点 4）。

---

## 五、发版策略（破坏性 DB 变更必选其一）

| 策略 | 做法 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| **A. 停机迁移** | 低峰停机 → 跑改名迁移 + RENAME → 一次性部署新代码 → 完整 e2e 回归 | 简单、无双写复杂度、最不易出错 | 有短暂停机（分钟级） | **推荐**：当前是测试团、用户量小、且有 T-1 截单窗口，可安排在凌晨/非截单时段 |
| B. 双写兼容 | 保留旧表 + 新表，应用先读写双写，跑稳后删旧表 | 零停机 | 迁移脚本复杂、回滚难、双写期间数据一致性风险、工期翻倍 | 不建议：收益不抵成本 |

**推荐 A**：内部系统、用户量小、有现成的"T-1 24:00 截单→次日 11:30 送达"业务空窗，可在非截单时段执行。

---

## 六、meal 系（套餐）是否纳入本次 —— 待决策

P1 当初明确"**meal 系不纳入**"（meal = 套餐，内部语义不妨碍，改名波及极大收益低）。但 P3 是 DB 重构，需重新确认：

- `ab_set_meal`（套餐模板）、`ab_meal_assignment`（套餐-楼群-日期分配）、`MealEntity`、`mealDate` 这些。
- C 端展示已叫"本日精选"，后台叫"套餐模板"，`meal` 在内部语义清晰、**用户不可见**。

**两种走法：**

- **走法 1（推荐，最小动）：meal 系保留**，仅把 `ab_set_meal_item.dish_id` 列改为 `item_id`（因为它指向被改名的 `ab_item`）。`ab_set_meal`/`ab_meal_assignment` 表名、`MealEntity` 类名、`mealDate` 字段一律不动。
- **走法 2（彻底去化）：meal 系一并改**（如 `ab_set_meal→ab_combo` / `ab_meal_assignment→ab_assignment` / `MealEntity→ComboEntity`），与 dish→item 同批。代价是又多出约 30+ 文件改动，且 `meal` 在内部本就中性，收益有限。

---

## 七、待你拍板的决策点

1. **meal 系是否纳入本次**（走法 1 vs 走法 2）？
2. **表名/实体命名 `item` 是否认可**？还是偏好 `ab_product` / `ab_goods`（需确认与现有表 `ab_*` 命名风格不冲突）？
3. **发版策略**：停机迁移（A）vs 双写兼容（B）？（我推荐 A）
4. **目录名 `apps/api-server/src/modules/supplier/dish/` 是否一并改名为 `item/`**？（纯工程整洁，不影响功能）
5. **执行节奏**：现在动手（拆批 A/B/C/D 在本轮内完成），还是排到专门重构版本、先 freeze 当前已交付的 P0+P2？

---

## 八、明确不做的事（边界）

以下**绝对不改**，与去餐饮化目标无关或属合规/真实业务数据：

- 商品真实名（"红烧肉""清炒时蔬"等）——这是供应商真实 SKU，不是术语。
- `food_license` / 食品经营许可证 / 营业执照 —— 合规证照。
- 供应商主营品类（本帮菜 / 京味等）—— 真实业务描述。
- `ab_set_meal.price` 等"套餐展示价"语义—— 除非走法 2 整批改。
- 上一轮已交付的展示层 336 处 + P0/P2（已入库、已推送、门禁 30/30）—— 不回退。

---

## 九、落地前必做（执行阶段，非本草稿范围）

1. 精确 grep 拆分 `dish-only` 与 `meal-only` 文件清单（确认真实改动点计数）。
2. 列出所有 `ab_dish*` / `ab_set_meal_item.dish_id` 的裸 SQL 出现位置（seed / 迁移 / service 裸 query）。
3. 设计改名迁移脚本，确保幂等（旧表存在才 RENAME，旧列存在才 ALTER）。
4. 沿用已验证的幂等替换 + 回退脚本机制（参考 `scripts/_neutralize_display_copy.mjs` / `_func_p0p2.mjs` 的模式），每张表/每段替换配套回退脚本。
5. 每批落盘后跑 `gate.mjs all` + `gate.mjs verify` 全绿再进下一批。

---

*（本草稿不改动任何代码、不提交 git。待决策点 1-5 确认后，再进入执行阶段。）*
