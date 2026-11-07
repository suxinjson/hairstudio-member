#!/usr/bin/env bash
set -euo pipefail

# The forced SSH command accepts only bounded reads of this project's API logs.
# Never evaluate SSH_ORIGINAL_COMMAND as shell code.
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if (($#)); then
  ARGS=("aligenie-logs" "$@")
else
  read -r -a ARGS <<< "${SSH_ORIGINAL_COMMAND:-aligenie-logs}"
fi
if [[ "${ARGS[0]:-}" != "aligenie-logs" ]]; then
  echo '此公钥仅允许读取天猫精灵日志。' >&2
  exit 64
fi
TAIL=200
SINCE=30m
FOLLOW=()
for ((INDEX=1; INDEX<${#ARGS[@]}; INDEX++)); do
  case "${ARGS[$INDEX]}" in
    --tail)
      INDEX=$((INDEX + 1)); TAIL="${ARGS[$INDEX]:-}"
      [[ "$TAIL" =~ ^[0-9]{1,4}$ ]] && ((10#$TAIL >= 1 && 10#$TAIL <= 1000)) || { echo 'tail 必须是 1 至 1000。' >&2; exit 64; }
      ;;
    --since)
      INDEX=$((INDEX + 1)); SINCE="${ARGS[$INDEX]:-}"
      [[ "$SINCE" =~ ^([1-9][0-9]?m|([1-9]|1[0-9]|2[0-4])h)$ ]] || { echo 'since 支持 1 至 99m 或 1 至 24h。' >&2; exit 64; }
      ;;
    --follow) FOLLOW=(--follow) ;;
    *) echo '仅支持 --tail、--since 和 --follow。' >&2; exit 64 ;;
  esac
done
COMPOSE=(--project-directory "$PROJECT_DIR" -f "$PROJECT_DIR/compose.yaml")
if [[ -f "$PROJECT_DIR/deploy/compose.ip.yaml" ]]; then
  COMPOSE+=(-f "$PROJECT_DIR/deploy/compose.ip.yaml")
fi
SUDO=()
if ! docker info >/dev/null 2>&1; then SUDO=(sudo -n); fi
"${SUDO[@]}" docker compose "${COMPOSE[@]}" logs --no-color --no-log-prefix --tail "$TAIL" --since "$SINCE" "${FOLLOW[@]}" api |
  awk '/"event":"aligenie\./ { print; fflush() }'
