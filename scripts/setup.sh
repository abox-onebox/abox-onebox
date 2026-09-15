#!/usr/bin/env bash
# ABox 一盒 · 一键初始化（macOS / Linux / Git Bash）
set -euo pipefail

cd "$(dirname "$0")/.."

echo "🚀 初始化 ABox 一盒 Monorepo..."

command -v node >/dev/null 2>&1 || { echo "❌ 未检测到 node（需 >= 20）"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "❌ 未检测到 pnpm（npm i -g pnpm@9）"; exit 1; }

# 1. 根环境变量
[ -f .env ] || cp .env.example .env
[ -f apps/api-server/.env ] || cp apps/api-server/.env.example apps/api-server/.env

# 2. 安装依赖
echo "📦 pnpm install ..."
pnpm install

# 3. 本地依赖（MySQL / Redis）
if command -v docker >/dev/null 2>&1; then
  echo "🐳 启动 MySQL + Redis ..."
  docker compose up -d
  echo "⏳ 等待 MySQL 就绪 ..."
  for i in $(seq 1 60); do
    if docker exec abox-mysql mysqladmin ping -h localhost -uroot -proot123 --silent >/dev/null 2>&1; then
      echo "✅ MySQL 就绪"
      break
    fi
    sleep 2
  done
else
  echo "⚠️  未检测到 docker，跳过本地依赖启动（请自行准备 MySQL8 / Redis7）"
fi

# 4. 迁移 + 种子
echo "🗄️  数据库迁移 ..."
pnpm db:migrate
echo "🌱 导入种子数据 ..."
pnpm db:seed

echo ""
echo "✅ 初始化完成！启动命令："
echo "  pnpm dev:api      # 后端  http://localhost:3000/api/v1  (Swagger /docs)"
echo "  pnpm dev:admin    # 后台  http://localhost:5173"
echo "  pnpm dev:mp       # 小程序（微信开发者工具导入 apps/miniprogram/dist/dev/mp-weixin）"
