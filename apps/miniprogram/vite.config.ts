import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';

export default defineConfig({
  plugins: [uni()],
  css: {
    preprocessorOptions: {
      scss: { charset: false },
    },
  },
  server: {
    port: 5174,
  },
});
