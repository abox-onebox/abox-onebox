#!/usr/bin/env node
/**
 * 安装 Git 钩子（husky install），由 package.json 的 `prepare` 调用。
 *
 * 设计为**永不失败**：在没有 git 的环境（CI 精简镜像、沙箱 PATH 未含 git、
 * 或解压出来的非 Git 目录）里，pnpm install 不应因为装钩子而整体中断。
 */
import { execSync } from 'node:child_process';

try {
  execSync('husky install', { stdio: 'inherit' });
} catch (err) {
  console.warn(
    `[husky] 跳过钩子安装（未找到 git 或当前不是 Git 仓库）：${String(err.message).split('\n')[0]}`,
  );
  console.warn('[husky] 手动安装：git 可用后在仓库根执行 `pnpm exec husky install`');
}
