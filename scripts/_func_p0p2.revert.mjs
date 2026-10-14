// 批次1（P0 + P2）回退脚本 · 对调 from/to，幂等机制与正向一致
import { readFileSync, writeFileSync } from 'fs';

const ROOT = process.cwd();

const EDITS = [
  {
    file: 'packages/shared-types/src/dto/cancel-reason.dto.ts',
    items: [
      ["dish_dislike: '内容不合口味',", "dish_dislike: '菜品不合口味',"],
      ["delivery_time: '配送时间不合适',", "delivery_time: '送餐时间不合适',"],
      ["ate_elsewhere: '改在别处就餐',", "ate_elsewhere: '改在别处吃',"],
    ],
  },
  {
    file: 'packages/shared-types/src/dto/home.dto.ts',
    items: [
      ["  /** 档位：1 主件 / 2 辅品 / 3 素品 / 4 附品 / 5 随附 */", "  /** 档位：1 主荤 / 2 半荤 / 3 素菜 / 4 汤 / 5 主食 */"],
    ],
  },
  {
    file: 'packages/shared-types/src/enums/supplier-admin.ts',
    items: [
      ["[DishCategory.MAIN]: '主件',", "[DishCategory.MAIN]: '主荤',"],
      ["[DishCategory.HALF]: '辅品',", "[DishCategory.HALF]: '半荤',"],
      ["[DishCategory.VEG]: '素品',", "[DishCategory.VEG]: '素菜',"],
      ["[DishCategory.SOUP]: '附品',", "[DishCategory.SOUP]: '汤品',"],
      ["[DishCategory.STAPLE]: '随附',", "[DishCategory.STAPLE]: '主食',"],
      ["  /** 主件（红烧肉 / 东坡肉） */", "  /** 主荤（红烧肉 / 东坡肉） */"],
      ["  /** 辅品（卤蛋 / 酱牛肉） */", "  /** 半荤（卤蛋 / 酱牛肉） */"],
      ["  /** 素品（清炒时蔬） */", "  /** 素菜（清炒时蔬） */"],
      ["  /** 附品（酸辣汤） */", "  /** 汤品（酸辣汤） */"],
      ["  /** 随附（米饭 / 面点） */", "  /** 主食（米饭 / 面点） */"],
      ["    `main 主件 / half 辅品 / veg 素品 / soup 附品 / staple 随附`", "    `main 主荤 / half 半荤 / veg 素菜 / soup 汤品 / staple 主食`"],
      ["    `1 主件 / 2 辅品 / 3 素品 / 4 附品 / 5 随附`，展示文案", "    `1 主荤 / 2 半荤 / 3 素菜 / 4 汤 / 5 主食`，展示文案"],
      ["两轴**概念相邻、字段 / 枚举仍分离**（category 取值 main/half/veg/soup/staple 与 slot 1–5 仍是两个独立字段）——\n *   **展示词现已对齐为同一套**（主件 / 辅品 / 素品 / 附品 / 随附），这是有意的口径统一，不是合并两轴；\n *   不要因为「中文相同」就误判为字段合并、把 category 直接塞进 slot。",
       "两轴**概念相邻、取值不同、中文不同**（档位写「汤」、品类写「汤品」）——\n *   把「汤品」改成「汤」会连累菜品库 / 角标 / 溯源页的真实展示口径，**不要那样改**。"],
    ],
  },
];

let totalEff = 0;
let totalSkip = 0;

for (const { file, items } of EDITS) {
  const path = `${ROOT}/${file}`;
  let content = readFileSync(path, 'utf8');
  let fileEff = 0;
  for (const [from, to] of items) {
    const cnt = content.split(from).length - 1;
    if (cnt === 0) {
      if (content.includes(to)) {
        totalSkip++;
        continue;
      }
      console.error(`✗ ${file} · 未命中且不含新值： "${from}"`);
      process.exit(1);
    }
    if (cnt > 1) {
      console.error(`✗ ${file} · 命中 ${cnt} 次（非唯一）： "${from}"`);
      process.exit(1);
    }
    content = content.replace(from, to);
    fileEff++;
    totalEff++;
  }
  writeFileSync(path, content);
  console.log(`✔ ${file} · ${fileEff} 处`);
}

console.log(`=== 批次1(P0+P2)回退：本次 ${totalEff} 处生效，${totalSkip} 处已存在跳过 ===`);
