#!/usr/bin/env bash
# 导入种子数据（12 栋办公楼 / 5 楼群 / 4 供应商 / 4 集散中心 / 菜品库 / 定价与佣金）
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --filter api-server db:seed
