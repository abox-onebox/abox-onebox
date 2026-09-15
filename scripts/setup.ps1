# ABox 一盒 · 一键初始化（Windows / PowerShell 5.1+）
# 支持两种模式：Docker 完整模式（mysql+redis）与 零依赖模式（sqlite+memory）
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host '初始化 ABox 一盒 Monorepo...' -ForegroundColor Cyan

# ---------- 1. Node ----------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '未检测到 node（需 >= 20）' }

# ---------- 2. pnpm（优先 corepack 自举，无需手动安装） ----------
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host '未检测到 pnpm，尝试用 corepack 启用...' -ForegroundColor Yellow
  corepack enable pnpm 2>$null
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'pnpm 不可用：请先执行 `corepack enable pnpm` 或 `npm i -g pnpm@9`'
}

# ---------- 3. .env ----------
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host '已生成 .env' -ForegroundColor Green
}

# ---------- 4. 读取驱动开关 ----------
function Get-EnvValue([string]$key, [string]$default) {
  $hit = Select-String -Path '.env' -Pattern "^$key=(.*)$" | Select-Object -First 1
  if ($hit) { return $hit.Matches[0].Groups[1].Value.Trim() }
  return $default
}

$dbDriver = Get-EnvValue 'DB_DRIVER' 'mysql'
$queueDriver = Get-EnvValue 'QUEUE_DRIVER' 'redis'
$providerMode = Get-EnvValue 'PROVIDER_MODE' 'mock'
$hasDocker = [bool](Get-Command docker -ErrorAction SilentlyContinue)

Write-Host ("模式：db={0} queue={1} provider={2} docker={3}" -f $dbDriver, $queueDriver, $providerMode, $(if ($hasDocker) { '已安装' } else { '未安装' })) -ForegroundColor Cyan

# ---------- 5. 安装依赖 ----------
Write-Host 'pnpm install ...' -ForegroundColor Yellow
pnpm install

# ---------- 5.5 构建共享包 ----------
# @abox/shared-types / shared-utils 需先产出 dist（js + d.ts）：
# api-server 是 tsc/CJS 编译，若直接编译跨包源码会触发 TS6059 而构建失败。
Write-Host '构建 @abox/shared-types / @abox/shared-utils ...' -ForegroundColor Yellow
pnpm run build:shared

# ---------- 6. 本地依赖与建表 ----------
if ($dbDriver -eq 'mysql') {
  if (-not $hasDocker) {
    Write-Warning 'DB_DRIVER=mysql 但未检测到 Docker，无法启动本地数据库。'
    Write-Host '  方案 A（推荐）：安装 Docker Desktop 后重跑本脚本；' -ForegroundColor Yellow
    Write-Host '  方案 B（零依赖）：把 .env 里的 DB_DRIVER 改成 sqlite、QUEUE_DRIVER 改成 memory，再重跑。' -ForegroundColor Yellow
    exit 1
  }

  Write-Host '启动 MySQL + Redis ...' -ForegroundColor Yellow
  docker compose up -d

  Write-Host '等待 MySQL 就绪 ...'
  $ok = $false
  foreach ($i in 1..60) {
    docker exec abox-mysql mysqladmin ping -h localhost -uroot -proot123 --silent 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ok) { Write-Warning 'MySQL 未在预期时间内就绪，请查看 docker compose logs mysql' } else { Write-Host 'MySQL 就绪' -ForegroundColor Green }

  Write-Host '数据库迁移 ...' -ForegroundColor Yellow
  pnpm db:migrate
}
else {
  Write-Host 'sqlite 模式：跳过迁移（API 首次启动时 synchronize 自动建 24 张表）' -ForegroundColor Yellow
}

# ---------- 7. 种子 ----------
Write-Host '导入种子数据 ...' -ForegroundColor Yellow
pnpm db:seed

# ---------- 8. 完成 ----------
Write-Host ''
Write-Host '初始化完成！启动命令：' -ForegroundColor Green
Write-Host '  pnpm dev:api      # 后端  http://localhost:3000/api/v1   (Swagger: /docs)'
Write-Host '  pnpm dev:admin    # 后台  http://localhost:5173'
Write-Host '  pnpm dev:mp       # 小程序（微信开发者工具导入 apps/miniprogram/dist/dev/mp-weixin）'
Write-Host ''
if ($providerMode -eq 'mock') {
  Write-Host 'MOCK 模式登录（无需任何微信账号）：' -ForegroundColor Cyan
  Write-Host '  curl -X POST http://localhost:3000/api/v1/auth/login -H "Content-Type: application/json" -d "{\"code\":\"dev:1001\"}"'
  Write-Host '  李明=dev:1001（首席）王芳=dev:1002（金牌）陈强=dev:1005（见习）'
}
Write-Host '详见 ..\ABox一盒本地开发手册v1.0.md' -ForegroundColor DarkGray
