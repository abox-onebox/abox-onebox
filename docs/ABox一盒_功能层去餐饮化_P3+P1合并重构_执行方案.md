# ABox 一盒 · 功能层去餐饮化 P3 + P1 合并重构 · 执行方案（v2 定稿）

> 本文档由草稿升级为**可执行方案**。决策点已按用户裁定锁定，**仍未动手**，待用户喊"动手"后再落码。
> 配套历史：展示层去餐饮化（commit `8b568bb`）+ 功能层 P0+P2（commit `4ef2d2c`）已交付并推送，C 端可见餐饮词已清零。

---

## 一、决策锁定（5 点，按建议）

| # | 决策点 | 裁定 |
|---|---|---|
| 1 | `meal` 系（套餐）是否纳入 | **否**——`ab_set_meal`/`ab_meal_assignment`/`MealEntity`/`mealDate` 全不动；仅改 `ab_set_meal_item.dish_id` 列（→`item_id`） |
| 2 | 命名 `item` 是否认可 | **是**——`dish`→`item`，不用 `ab_product`/`ab_goods` |
| 3 | 发版策略 | **停机迁移**（测试团有业务空窗；双写兼容收益低、复杂度高，弃用） |
| 4 | 目录 `modules/supplier/dish/` 是否改名 | **是**——→ `modules/supplier/item/`（仅 3 文件 + `supplier.module.ts` 两行 import，干净隔离） |
| 5 | 执行节奏 | **本轮拆批做**——但内部按 A–G 七个子批顺序推进，每批跑 `gate.mjs all`，末批跑 `verify` |

---

## 二、规模重估（真实 dish-only 数据，非草稿预估）

| 目录 | 命中文件 | 命中行 |
|---|---|---|
| `apps/api-server/src` | 51 | 684 |
| `apps/admin-web/src` | 25 | 219 |
| `apps/miniprogram/src` | 9 | 78 |
| `packages/shared-types` | 21 | 121 |
| `packages/shared-utils` | 3 | 12 |
| `scripts`（含 e2e） | 17 | 339 |
| **全仓合计** | **237 文件命中 `dish`** | — |

> ⚠️ 远比草稿预估（"后端 ~130 文件含 meal"）大。属**全栈级重构**：5 张表、2 个实体类、2 个裸 SQL 种子、1 个新迁移、1 个模块目录、e2e 字段断言、约 237 文件。

### 真实 DB 表面（改名必须覆盖）
- **表**：`ab_dish`→`ab_item`；`ab_dish_rating`→`ab_item_rating`；`ab_supplier_dish_daily`→`ab_supplier_item_daily`；`ab_supplier_dish_center_daily`→`ab_supplier_item_center_daily`
- **列 `dish_id`**：`ab_set_meal_item`、`ab_item_rating`（原名 ab_dish_rating）、`ab_supplier_item_daily`、`ab_supplier_item_center_daily`、`ab_supplier_share` → `item_id`
- **列 `dish_name`**：`ab_item_rating`、`ab_supplier_share` → `item_name`
- **实体类**：`Dish`→`Item`；`DishRating`→`ItemRating`；`SupplierDishDaily`→`SupplierItemDaily`；`SupplierDishCenterDaily`→`SupplierItemCenterDaily`
- **索引名**：`uk_supplier_dish_date`→`uk_supplier_item_date`；`uk_sddc`→`uk_sidc`（可选）
- **repo/方法/字段**：`dishRepo`→`itemRepo`；`dishesOfSetMeal`→`itemsOfSetMeal`；`dishId`→`itemId`；`dishName`→`itemName`；`dishIds`→`itemIds`；`dishCount`→`itemCount`；`mainDishName`→`mainItemName`；`dishes`→`items`；`dishNames`→`itemNames`
- **DTO/视图类型**：`MealDishView`→`MealItemView`；`TraceabilityDishView`→`TraceabilityItemView`；`DishRatingRow`→`ItemRatingRow`；`DishRatingView`→`ItemRatingView`

---

## 三、改名映射总表（执行用 · 精确 token，非盲子串）

> 替换一律用**完整 token 精确匹配**（沿用展示层已验证的幂等脚本机制：命中数断言 + 旧/新串校验），**禁用盲 `dish`→`item` 子串替换**——否则会误伤 `DishCategory`。

| 类别 | 旧 token | 新 token |
|---|---|---|
| 实体类 | `Dish` `DishRating` `SupplierDishDaily` `SupplierDishCenterDaily` `DishService` `DishAdminController` `DishAdminService` | `Item` `ItemRating` `SupplierItemDaily` `SupplierItemCenterDaily` `ItemService` `ItemAdminController` `ItemAdminService` |
| 列名(实体注解) | `name: 'dish_id'` `name: 'dish_name'` | `name: 'item_id'` `name: 'item_name'` |
| 字段 | `dishId` `dishName` `dishIds` `dishCount` `mainDishName` `dishes` `dishNames` | `itemId` `itemName` `itemIds` `itemCount` `mainItemName` `items` `itemNames` |
| repo/方法 | `dishRepo` `dishesOfSetMeal` | `itemRepo` `itemsOfSetMeal` |
| 视图类型 | `MealDishView` `TraceabilityDishView` `DishRatingRow` `DishRatingView` | `MealItemView` `TraceabilityItemView` `ItemRatingRow` `ItemRatingView` |
| 索引 | `uk_supplier_dish_date` `uk_sddc` | `uk_supplier_item_date` `uk_sidc` |
| 目录/文件 | `modules/supplier/dish/` `dish.service.ts` `dish-admin.controller.ts` `dish-admin.service.ts` | `modules/supplier/item/` `item.service.ts` `item-admin.controller.ts` `item-admin.service.ts` |
| 注释/兜底串 | `菜品 #` `菜品#` `菜品 ${` `菜品 ${i.dishId}` 等中文"菜品" | `商品 #` `商品#` `商品 ${` `商品 ${i.itemId}` |
| DB 表(SQL/迁移) | `ab_dish` `ab_dish_rating` `ab_supplier_dish_daily` `ab_supplier_dish_center_daily` `dish_id` `dish_name` | `ab_item` `ab_item_rating` `ab_supplier_item_daily` `ab_supplier_item_center_daily` `item_id` `item_name` |

---

## 四、排除清单（**绝不改动**——触碰即破坏）

1. **`DishCategory` / `DISH_CATEGORY_LABEL` / `.category` 品类轴**（P2 已中性化，约 10 处）——整体保留。
2. **`meal` 系**：`ab_set_meal` `ab_meal_assignment` `MealEntity` `mealDate` `setMealId` `MealItem` 类名、`ab_set_meal_item` 表名——除 `dish_id` 列外全保留。
3. **路由 URL**：`/supplier/dish-library` `/supplier/dishes`——后台角色权限键、导航一致性检查（`check-nav-consistency.mjs:165`）、e2e-m3 断言（`e2e-m3.mjs:433`）硬依赖，且绑定"商家端/平台端分家"设计。**不改**。
4. **view 文件名**：`apps/admin-web/src/views/supplier/dish-library.vue` `dishes.vue`——与路由 URL 绑定。**不改**（仅改其内部 `dishId`/`dishName` 等 token）。
5. **`docs/` 全部 markdown**——文档，提及 `/supplier/dishes` 等历史路径，不动。
6. **`ab_supplier_share.dish_id/dish_name` 改名须经结算回归**——允许改列，但列为高危（见风险登记）。

---

## 五、数据库迁移设计（最高风险 · 先做且独立验证）

**新增迁移 `apps/api-server/src/database/migrations/1700000000005-dish-rename.ts`**（幂等 up/down）：

```sql
-- UP（幂等：先判存在再 CHANGE；RENAME TABLE 自带幂等需包一层存在性判断）
RENAME TABLE ab_dish                TO ab_item,
             ab_dish_rating         TO ab_item_rating,
             ab_supplier_dish_daily TO ab_supplier_item_daily,
             ab_supplier_dish_center_daily TO ab_supplier_item_center_daily;

ALTER TABLE ab_set_meal_item      CHANGE dish_id item_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE ab_item_rating        CHANGE dish_id item_id BIGINT UNSIGNED NOT NULL,
                                    CHANGE dish_name item_name VARCHAR(64);
ALTER TABLE ab_supplier_item_daily CHANGE dish_id item_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE ab_supplier_item_center_daily CHANGE dish_id item_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE ab_supplier_share     CHANGE dish_id item_id BIGINT UNSIGNED DEFAULT NULL,
                                    CHANGE dish_name item_name VARCHAR(64);
```
- **外键**：先核 `1700000000000-init.ts` 中 `ab_set_meal_item.dish_id` 是否定义 FK。若定义，UP 先 `DROP FOREIGN KEY`、再 RENAME、再 `ADD FOREIGN KEY` 指向 `ab_item(id)`；DOWN 反向。
- **不回改旧迁移**：`1700000000003-dish-rating.ts` 仍建 `ab_dish_rating`，由本迁移在已部署库/全新库上统一改名（全新库链路：建→改名，结果一致）。
- **先副本试跑**：在 `/tmp` 复制一份 DB 跑迁移 + seed，确认无数据丢失、无类型报错，再上测试/生产。
- **生产库**：迁移照跑；**生产库不跑 seed**（既有约定）。

---

## 六、分批执行清单（A–G）

> 每批用幂等原子脚本（命中数断言）落地；批次间跑 `gate.mjs all` 门禁；A 批必须先行（DB 契约）。

| 批 | 范围 | 目标 token | 文件 | 门禁 |
|---|---|---|---|---|
| **A 迁移** | 新迁移文件 + 实体列名注解 | 表/列改名（见五） | 新迁移 + `entities/*.ts` 的 `@Column name` | 迁移副本试跑通过 |
| **B 实体类** | 实体类名 + `@Entity` 表名 + 索引 | `Dish`→`Item` 等 4 类 + `@Entity('ab_*')` + 索引名 | `supplier.entity.ts` `order.entity.ts` `meal.entity.ts` `finance.entity.ts` `entities/index.ts` | `all` |
| **C 后端 service/controller/dto** | repo/方法/字段/兜底串 + 模块目录改名 | `dishRepo`/`dishesOfSetMeal`/`dishId`/`dishName`/`菜品`→`商品`；`modules/supplier/dish/`→`item/` + `supplier.module.ts` import | ~10 个 service + 3 个 dish 文件 + `supplier.module.ts` | `all` |
| **D 共享类型 + 前端** | DTO/视图类型 + 字段 | `MealDishView`→`MealItemView` 等 4 类型；`dishId/dishName/dishes/dishNames/mainDishName/dishCount` | `shared-types` 21 文件、`admin-web` 25 文件、`miniprogram` 9 文件 | `all` |
| **E 种子裸 SQL** | seed 文件 | `dishRepo`→`itemRepo`；seed.ts 插入键 `dishId:`→`itemId:`；seed-demo.ts 裸 SQL `ab_dish`/`ab_set_meal_item`/`dish_id`→新名；`菜品`→`商品` | `seed.ts` `seed-demo.ts` | `all` + 手动 seed 试跑 |
| **F e2e 断言** | 字段断言同步 | `dishId`→`itemId` `dishName`→`itemName`（**不动** `/supplier/dishes` 路由断言） | `scripts/e2e-m1/m2/m3.mjs` | `all` |
| **G 验收** | 全量 | — | — | `all`(30) + `verify`(seed+e2e) |

### 注释归一（非破坏，随 C/D 顺手做，不单列批次）
- `meal.dto.ts:41`、 `order.entity.ts:481` 等"档位快照：1主荤 2半荤 3素菜 4汤 5主食"旧注释 → 对齐 biz.ts 真源 `1 主件/2 辅品/3 素品/4 附品/5 随附`。
- 内部"菜品"中文注释 → "商品"（兜底串除外已单独处理）。

---

## 七、回退策略

- **代码回退**：每批生成对应 `.revert.mjs`（from/to 对调、幂等、命中数断言），顺序与正向相反。
- **迁移回退**：`1700000000005` 的 `down()` 反向 RENAME/CHANGE（含 FK 还原）。
- **回退演练**：在 `/tmp` 副本实跑"正向全批→回退全批→再正向"验证可逆，再上真仓。

---

## 八、风险登记（高危点 + 缓解）

| 风险 | 位置 | 缓解 |
|---|---|---|
| **分账历史对账错位** | `ab_supplier_share.dish_id/dish_name` | 改名后跑结算回归（supplier-share.service 全链路）；副本试跑比对金额 |
| **裸 SQL typecheck 抓不到** | `seed.ts` `seed-demo.ts` | 人工逐行核对 + 副本 seed 实跑 + e2e m3（含排期/分账断言） |
| **`DishCategory` 误伤** | 品类轴 10 处 | 精确 token 替换，绝不盲子串；改完 grep 确认 `DishCategory` 数 = 10 不变 |
| **模块目录 import 路径** | `supplier.module.ts` + 3 文件互引 | typecheck 兜底；改名后用 `git grep` 确认无残留 `modules/supplier/dish` |
| **e2e 路由断言误改** | `e2e-m3.mjs:433` `/supplier/dishes` | 明确排除路由 URL；仅改字段断言 |
| **FK 破坏** | `ab_set_meal_item.dish_id` | 迁移前核 init.ts 是否定义 FK，UP/DOWN 对称处理 |
| **`ab_dish_rating` 已成表** | 迁移 3 已建 | 不回改旧迁移，本迁移统一改名，全新库/已部署库结果一致 |

---

## 九、执行前检查 + 发版/维护窗口

1. 核 `1700000000000-init.ts:206-216` 的 FK 定义（决定迁移写法）。
2. 在 `/tmp` 复制 DB → 跑新迁移 → 跑 seed → 跑 e2e 子集，确认无数据丢失。
3. **停机维护窗口**执行生产迁移（测试团业务空窗）；生产库不跑 seed。
4. 三端（后端 + 小程序 + 后台）**同一次发版**（P1 破坏性字段改名，必须同步）。

---

## 十、门禁与验收

- 每批后：`node scripts/gate.mjs all`（30 道，裸跑，git/python 可用）。
- 全批后：`node scripts/gate.mjs verify`（seed 重置 + e2e:m1 116 / m2 162 / m3 1351）。
- 验收口径：全仓 `dish` 命中归零（排除四·排除清单与 docs）；`DishCategory` 仍 10 处；`/supplier/dish*` 路由断言仍通过。

---

## 十一、状态

- ✅ 展示层 336 处 + 功能层漏网 P0+P2（C 端可见餐饮词）已清零，门禁 30/30。
- ⏸️ 本次 P3+P1 合并重构：**方案定稿，未动手**，待用户喊"动手"后按 A–G 落地。
- 回退脚本机制、迁移设计、风险登记已就绪。
