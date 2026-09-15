#!/usr/bin/env bash
# 数据库迁移
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --filter api-server db:migrate
