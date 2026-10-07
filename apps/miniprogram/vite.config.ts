import { defineConfig, type Plugin } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';

/**
 * ⛔ mp 端不得有任何字体二进制进包 —— 这是 γ「楷体死资源」的根治处。
 *
 * 背景（2026-10-07 实测，别凭印象改）：
 *   `@font-face` 写在 H5 条件编译块内（`#ifdef H5`）⇒ **条件编译是生效的**（产物 wxss 里 `ABoxKai` 命中 0 次，
 *   也没有任何 wxss 引用 `ab-kaiti`）。但 vite 收集 CSS 里的 `url()` 发生在**条件编译之前**，
 *   ⇒ 字体照样被当成 asset 产出，只是**没人引用** —— 871 KB 死资源，占主包一半。
 *   光把字体从 `static/` 挪到 `assets/` 治不了这个（挪完照样进包，实测过）。
 *
 * 为什么可以无差别删：**wxss 的 `src` 只接受网络地址或 base64**（依据见 `src/styles/icons.scss`），
 * 本地字体文件在 mp 端**永远不会被引用**。图标字体 ABoxIcons 是 base64 内嵌在 CSS 里的，
 * **不是独立 asset**，不受影响。
 *
 * 门禁 `mp:no-font` 会在构建后复核本插件的产出，插件失效时门禁报红。
 */
function dropMpFontAssets(): Plugin {
  const FONT_RE = /\.(woff2?|ttf|otf)$/i;
  return {
    name: 'abox:mp-no-font-asset',
    enforce: 'post',
    generateBundle(_options, bundle) {
      if (process.env.UNI_PLATFORM !== 'mp-weixin') return;
      let dropped = 0;
      let freed = 0;
      for (const [key, item] of Object.entries(bundle)) {
        if (item.type !== 'asset' || !FONT_RE.test(key)) continue;
        freed += String((item as { source?: unknown }).source ?? '').length;
        delete bundle[key];
        dropped += 1;
      }
      if (dropped > 0) {
        console.log(
          `[abox:mp-no-font-asset] mp 端剔除字体 ${dropped} 个（约 ${(freed / 1024).toFixed(0)} KB）—— wxss 不支持本地字体路径`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [uni(), dropMpFontAssets()],
  css: {
    preprocessorOptions: {
      scss: { charset: false },
    },
  },
  server: {
    port: 5174,
  },
});
