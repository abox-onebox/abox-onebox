import { defineStore } from 'pinia';

/** stores/permission —— 占位骨架（Pinia），开发阶段实现 */
export const usePermissionStore = defineStore('permission', {
  state: () => ({ role: 'admin' as 'admin' | 'supplier' }),
});
