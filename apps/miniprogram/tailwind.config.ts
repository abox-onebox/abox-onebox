import type { Config } from 'tailwindcss';

/** 仅在需要原子类时使用；品牌视觉请优先用 src/styles/tokens.scss 的 token */
export default {
  content: ['./src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: '#F6F0E5',
          text: '#6E5435',
          gold: '#C9A876',
          success: '#5B7C3A',
          warning: '#C44536',
          info: '#4A6FA5',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
