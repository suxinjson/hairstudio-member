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

# 提取当前 PUBLIC_DOMAIN
PUBLIC_DOMAIN=$(grep -E '^PUBLIC_DOMAIN=' .env | cut -d '=' -f2- | tr -d '\r"' | tr -d "'" || true)
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-124.70.184.136}"

# 仅公网地址为 IPv4 时加载 IP 证书配置，宿主机其他网站的 Certbot 目录不参与判断。
COMPOSE_ARGS=("-f" "compose.yaml")
if [[ "$PUBLIC_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  if [ ! -f "deploy/compose.ip.yaml" ]; then
    echo "❌ 错误: IP HTTPS 部署缺少 deploy/compose.ip.yaml，停止更新。"
    exit 1
  fi
  echo "🔒 检测到 IP HTTPS 证书环境 ($PUBLIC_DOMAIN)，自动挂载 deploy/compose.ip.yaml 和宿主机证书"
  COMPOSE_ARGS+=("-f" "deploy/compose.ip.yaml")
else
  echo "🌐 检测到标准域名环境 ($PUBLIC_DOMAIN)，使用标准 compose 启动"
fi

echo ">>> [1/3] 正在重新构建并平滑重启服务容器 (Web & API)..."
$SUDO docker compose "${COMPOSE_ARGS[@]}" up -d --build

echo ">>> [2/3] 正在验证 HTTPS 与反向代理服务状态..."
# 配置校验失败时保留日志并停止发布。
if ! $SUDO docker compose "${COMPOSE_ARGS[@]}" exec -T web caddy validate --config /etc/caddy/Caddyfile; then
  echo "❌ Caddy 配置校验失败，停止 APK 发布。"
  $SUDO docker compose "${COMPOSE_ARGS[@]}" logs --tail=50 web api || true
  exit 1
fi

HEALTH_URL="https://${PUBLIC_DOMAIN}/api/health"
echo "正在探测健康接口: $HEALTH_URL"
HTTPS_READY=0
for attempt in {1..12}; do
  if HEALTH_STATUS=$(curl -fsS --connect-timeout 8 --max-time 15 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null) && [ "$HEALTH_STATUS" = "200" ]; then
    HTTPS_READY=1
    break
  fi
  echo "等待 HTTPS 服务就绪 ($attempt/12)..."
  if [ "$attempt" -lt 12 ]; then sleep 5; fi
done
if [ "$HTTPS_READY" -ne 1 ]; then
  echo "❌ HTTPS 健康检查持续失败，停止 APK 发布。"
  $SUDO docker compose "${COMPOSE_ARGS[@]}" logs --tail=50 web api || true
  exit 1
fi
echo "✅ HTTPS 服务正常且证书有效！($HEALTH_URL 响应 200 OK)"

echo ">>> [3/3] 正在自动发布最新安卓 APK 到云端更新库..."
# 优先寻找 releases 目录下的最新 APK 与 manifest
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
echo "• HTTPS 证书与健康接口检查已通过"
echo "• 手机端现已可打开 App 点击【检查更新】下载新版本！"
echo "=========================================================="
