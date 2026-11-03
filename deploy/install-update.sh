#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR=${1:?Usage: install-update.sh deploy-directory update.tar.gz}
BUNDLE=${2:?Missing update archive}
case "$TARGET_DIR" in
  '~') TARGET_DIR="$HOME" ;;
  '~/'*) TARGET_DIR="$HOME/${TARGET_DIR:2}" ;;
esac
mkdir -p -- "$TARGET_DIR"
TARGET_DIR=$(cd -- "$TARGET_DIR" && pwd -P)

# 同一把锁覆盖版本检查、解压、容器更新及 APK 发布。
exec 9>"$TARGET_DIR/.member-deploy.lock"
flock 9
STAGING=$(mktemp -d "$TARGET_DIR/.member-update.XXXXXX")
cleanup() {
  case "$STAGING" in "$TARGET_DIR"/.member-update.*) rm -rf -- "$STAGING" ;; esac
}
trap cleanup EXIT
tar -xzf "$BUNDLE" --no-same-owner -C "$STAGING"
read -r INCOMING_VERSION < "$STAGING/release-version.txt"
[[ "$INCOMING_VERSION" =~ ^[1-9][0-9]{0,9}$ ]] && (( INCOMING_VERSION <= 2100000000 )) || { echo 'Invalid release version'; exit 1; }
test -f "$STAGING/deploy/deploy-update.sh"
MANIFEST_VERSION=$(sed -nE 's/^[[:space:]]*"versionCode"[[:space:]]*:[[:space:]]*([0-9]+),?[[:space:]]*$/\1/p' "$STAGING/releases/update-manifest.json")
[ "$MANIFEST_VERSION" = "$INCOMING_VERSION" ] || { echo 'Archive and APK manifest versions differ'; exit 1; }

CURRENT_VERSION=0
for version_file in "$TARGET_DIR/.member-deployment-version" "$TARGET_DIR/release-version.txt"; do
  if [ -f "$version_file" ]; then
    read -r version < "$version_file"
    [[ "$version" =~ ^[1-9][0-9]{0,9}$ ]] && (( version <= 2100000000 )) || { echo 'Invalid deployed version'; exit 1; }
    if (( version > CURRENT_VERSION )); then CURRENT_VERSION=$version; fi
  fi
done
# 兼容升级到本脚本之前已自动发布的服务器。
if [ -f "$TARGET_DIR/releases/update-manifest.json" ]; then
  version=$(sed -nE 's/^[[:space:]]*"versionCode"[[:space:]]*:[[:space:]]*([0-9]+),?[[:space:]]*$/\1/p' "$TARGET_DIR/releases/update-manifest.json")
  [[ "$version" =~ ^[1-9][0-9]{0,9}$ ]] && (( version <= 2100000000 )) || { echo 'Invalid existing update manifest'; exit 1; }
  if (( version > CURRENT_VERSION )); then CURRENT_VERSION=$version; fi
fi
if (( INCOMING_VERSION < CURRENT_VERSION )); then
  echo "Skipping stale deployment $INCOMING_VERSION; server has version $CURRENT_VERSION"
  exit 0
fi

# 先记录版本下限，失败重试只能采用相同或更新版本，避免回退已启动的服务。
printf '%s\n' "$INCOMING_VERSION" > "$STAGING/.member-deployment-version"
mv -- "$STAGING/.member-deployment-version" "$TARGET_DIR/.member-deployment-version"
cp -a "$STAGING/." "$TARGET_DIR/"
cd -- "$TARGET_DIR"
bash deploy/deploy-update.sh --lock-held
