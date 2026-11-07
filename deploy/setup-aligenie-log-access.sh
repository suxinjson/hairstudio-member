#!/usr/bin/env bash
set -euo pipefail

# Run as the same user used to SSH into this server. No SSH daemon or sudoers
# changes are made. This public key is restricted to read-aligenie-logs.sh.
PUBLIC_KEY="${1:-}"
read -r KEY_TYPE KEY_DATA _ <<< "$PUBLIC_KEY"
if [[ "${KEY_TYPE:-}" != ssh-ed25519 || ! "${KEY_DATA:-}" =~ ^[A-Za-z0-9+/]{64,100}={0,2}$ ]]; then
  echo "用法：bash deploy/setup-aligenie-log-access.sh 'ssh-ed25519 公钥内容'" >&2
  exit 64
fi
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ ! "$PROJECT_DIR" =~ ^/[A-Za-z0-9_./-]+$ || ! -f "$PROJECT_DIR/deploy/read-aligenie-logs.sh" ]]; then
  echo '请将项目放在不含空格或特殊字符的目录中，并先更新日志读取脚本。' >&2
  exit 64
fi
SSH_DIR="${HOME:?}/.ssh"
AUTHORIZED_KEYS="$SSH_DIR/authorized_keys"
if [[ -L "$SSH_DIR" || -L "$AUTHORIZED_KEYS" ]]; then
  echo '.ssh 或 authorized_keys 是符号链接，请先核对实际路径。' >&2
  exit 64
fi
mkdir -p -- "$SSH_DIR"
chmod 700 -- "$SSH_DIR"
touch -- "$AUTHORIZED_KEYS"
chmod 600 -- "$AUTHORIZED_KEYS"
if awk -v key="$KEY_TYPE $KEY_DATA" 'index($0,key) { found=1 } END { exit !found }' "$AUTHORIZED_KEYS"; then
  echo '该公钥已存在，未添加重复授权；请核对已有条目的限制。'
  exit 0
fi
printf '\nrestrict,command="/usr/bin/bash %s/deploy/read-aligenie-logs.sh" %s %s member-aligenie-log-reader\n' \
  "$PROJECT_DIR" "$KEY_TYPE" "$KEY_DATA" >> "$AUTHORIZED_KEYS"
echo '已添加只允许读取天猫精灵日志的公钥。'
echo '本机仍可使用原来的密码登录。'
