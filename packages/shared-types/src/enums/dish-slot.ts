/** 菜品分类槽位：一饭四菜 = 主菜 1 + 素菜/配菜 + 汤品 + 主食 */
export enum DishSlot {
  MAIN = 'main',
  VEGETABLE = 'vegetable',
  SIDE = 'side',
  SOUP = 'soup',
  STAPLE = 'staple',
}

export const DISH_SLOT_LABEL: Record<DishSlot, string> = {
  [DishSlot.MAIN]: '主菜',
  [DishSlot.VEGETABLE]: '素菜',
  [DishSlot.SIDE]: '配菜',
  [DishSlot.SOUP]: '汤品',
  [DishSlot.STAPLE]: '主食',
};
