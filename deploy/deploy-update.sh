#!/usr/bin/env bash
set -euo pipefail

# 切换到脚本所在目录或其父级目录（确保在项目根目录下执行）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -f "$SCRIPT_DIR/compose.yaml" ]; then
  cd "$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../compose.yaml" ]; then
  cd "$SCRIPT_DIR/.."
fi

echo "=========================================================="
echo "  梦飞空间会员管家 - 服务器自动部署与 APK 发布更新"
echo "=========================================================="

if [ ! -f .env ]; then
  echo "❌ 错误: 未检测到 .env 配置文件！"
  echo "请确保在部署目录下运行，且已有 .env 环境配置。"
  exit 1
fi

# 判断是否需要 sudo 运行 docker
SUDO=""
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "❌ 错误: 当前用户没有 Docker 权限，且系统中未安装 sudo"
    exit 1
  fi
fi

# 判断 compose 配置文件参数 (检测是否使用 IP HTTPS 证书)
COMPOSE_ARGS=("-f" "compose.yaml")
if [ -f "deploy/compose.ip.yaml" ] && [ -d "/etc/letsencrypt" ]; then
  echo "ℹ️ 检测到 IP HTTPS 部署环境，自动载入 deploy/compose.ip.yaml"
  COMPOSE_ARGS+=("-f" "deploy/compose.ip.yaml")
fi

echo ">>> [1/2] 正在重新构建并重启服务容器 (Web & API)..."
$SUDO docker compose "${COMPOSE_ARGS[@]}" up -d --build

echo ">>> [2/2] 正在自动发布最新安卓 APK 到云端更新库..."
# 优先寻找 releases 目录下的最新 APK
APK_FILE=$(ls -t releases/hairstudio-member-v*.apk 2>/dev/null | head -n 1 || true)
MANIFEST_FILE="releases/update-manifest.json"

if [ -n "$APK_FILE" ] && [ -f "$MANIFEST_FILE" ]; then
  echo "正在发布: $APK_FILE"
  $SUDO docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps \
    --volume "$PWD/$MANIFEST_FILE:/tmp/update-manifest.json:ro" \
    --volume "$PWD/$APK_FILE:/tmp/update.apk:ro" \
    migrate node server/publish-release.js /tmp/update-manifest.json /tmp/update.apk
  echo "✅ 最新安卓安装包已成功发布并入库！"
else
  echo "⚠️ 未在 releases/ 目录检测到 APK 或 update-manifest.json，跳过 APK 发布步骤。"
fi

echo "=========================================================="
echo "🎉 自动部署与发布已顺利完成！"
echo "• 服务端 Web 与 API 容器已更新至最新版本"
echo "• 手机端现已可打开 App 点击【检查更新】下载新版本！"
echo "=========================================================="
