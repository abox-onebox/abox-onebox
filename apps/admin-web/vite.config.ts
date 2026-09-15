import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({ resolvers: [ElementPlusResolver()], imports: ['vue', 'vue-router', 'pinia'] }),
    Components({ resolvers: [ElementPlusResolver()] }),
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
