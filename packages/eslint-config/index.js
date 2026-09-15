/** 共享 ESLint 配置（按需在子项目 extends 中引用） */
module.exports = {
  root: false,
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
      // 小程序跑在 uni-app 运行时下，`uni` 等是平台全局。
      // ⚠️ typescript-eslint 的 eslint-recommended 只对 .ts 关掉 `no-undef`，
      //    `.vue` 的 script 块不受影响 → 不声明会误报 no-undef。
      files: ['apps/miniprogram/**/*.{ts,vue}'],
      globals: {
        uni: 'readonly',
        wx: 'readonly',
        getCurrentPages: 'readonly',
        getApp: 'readonly',
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', 'unpackage', '*.d.ts'],
};
