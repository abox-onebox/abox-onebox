module.exports = {
  root: true,
  env: { node: true, es2022: true, browser: true },
  parser: 'vue-eslint-parser',
  parserOptions: {
    parser: '@typescript-eslint/parser',
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:vue/vue3-recommended',
    'prettier',
  ],
  rules: {
    'vue/multi-word-component-names': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      // 小程序跑在 uni-app 运行时下，`uni` 等是**平台全局**。
      // ⚠️ 必须只在 .vue 上补声明的原因：typescript-eslint 的 eslint-recommended
      //    会对 .ts 关掉 `no-undef`（交给 TS 判断），但 `.vue` 的 script 块不受该
      //    覆盖影响 → 不声明就会把 `uni.showToast(...)` 误报为 no-undef。
      files: ['apps/miniprogram/**/*.{ts,vue}'],
      globals: {
        uni: 'readonly',
        wx: 'readonly',
        getCurrentPages: 'readonly',
        getApp: 'readonly',
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', 'unpackage', 'docs', '*.d.ts'],
};
