import { defineStore } from 'pinia';

/** stores/app —— 占位骨架（Pinia），开发阶段实现 */
export const useAppStore = defineStore('app', {
  state: () => ({ role: 'admin' as 'admin' | 'supplier' }),
});
