#!/usr/bin/env bash
# 一键部署（构建镜像 → 推送 → 滚动更新）
# 前置：已配置 docker registry 与 k8s context
set -euo pipefail

TAG="${1:-$(git rev-parse --short HEAD)}"
REGISTRY="${REGISTRY:-registry.example.com/abox}"

echo "🐳 构建镜像 tag=$TAG"
docker build -t "$REGISTRY/api-server:$TAG" -f apps/api-server/Dockerfile .

echo "📤 推送镜像"
docker push "$REGISTRY/api-server:$TAG"

echo "🚀 应用部署清单"
kubectl set image deployment/abox-api api="$REGISTRY/api-server:$TAG" -n abox

echo "✅ 部署完成：$TAG"
