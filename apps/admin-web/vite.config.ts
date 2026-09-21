import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    vue(),
    /**
     * ⚠️ `importStyle: false` —— 这不是优化，是**必需项**（2026-09-21 实测发现）。
     *
     * 背景：`main.ts` 已 `import 'element-plus/dist/index.css'`（**全量**），
     *   而这两个 resolver 默认会**再按需注入一次**组件样式 ⇒ 构建出 68 个 chunk css，
     *   其中 `el-*.css` 合计 208KB 全是重复（主入口 css 381KB 已含全部组件样式）。
     *
     * ⚠️ 真正的危害不是体积，而是**加载顺序**：
     *   chunk css 由路由懒加载在运行时插入 `<head>` 末尾 ⇒ **晚于**入口 css ⇒ 其中的
     *     · `:root{--el-color-primary:#409eff;--el-color-success:#67c23a;…}`（Element 默认六色）
     *     · `.el-tag--success{--el-tag-text-color:var(--el-color-success)}`（状态原色裸奔）
     *   会**反过来覆盖** `styles/element-override.scss` 的全部主题与组件覆盖。
     *   而且这是**静默**的：build 不报错、产物里两套规则并存，只有运行时才见分晓。
     *   （实测证据：`dist/assets/base-*.css` 含 Element 默认六色、`el-tag-*.css` 含裸奔文字色，
     *     二者均被主入口 JS 的 css 依赖表引用 ⇒ 路由加载时动态插入。）
     *
     * ⇒ 关掉按需样式后，入口 css 成为 Element 样式的**唯一来源**，覆盖顺序确定。
     * 门禁：`_tmp/icons/ui-gate.py` 断言「产物中不得存在含 `--el-color-primary:#409eff` 的 css」。
     */
    AutoImport({
      resolvers: [ElementPlusResolver({ importStyle: false })],
      imports: ['vue', 'vue-router', 'pinia'],
    }),
    Components({ resolvers: [ElementPlusResolver({ importStyle: false })] }),
  ],
  css: {
    preprocessorOptions: {
      scss: {
        /**
         * 设计 token 自动注入（协作规范 §7.3：token 只写 tokens.scss，禁止硬编码色值）。
         *
         * 为什么必须注入：`@use` 的作用域是「本文件」，父文件 `@use` 进来的变量
         * 不会传递到被 `@use` 的子文件，也不会传递到各 SFC 的 <style lang="scss">。
         * 所以 33 个视图里直接写 $space-4 / $c-text 必须靠这里统一注入。
         */
        additionalData: `@use "@/styles/tokens.scss" as *;\n`,
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
