#!/usr/bin/env bash
set -euo pipefail

BIN="/opt/blockheads/blockheads_server171"

WORLD_NAME="${WORLD_NAME:-MyWorld}"
WORLD_ID="${WORLD_ID:-myworld001}"
PORT="${PORT:-15151}"
MAX_PLAYERS="16"
SAVE_DELAY="${SAVE_DELAY:-1}"
WORLD_WIDTH="${WORLD_WIDTH:-1}"
EXPERT_MODE="${EXPERT_MODE:-false}"

if "$BIN" --list 2>/dev/null | grep -q "$WORLD_ID"; then
  CMD=(
    "$BIN"
    --load "$WORLD_ID"
    --port "$PORT"
    --max_players "$MAX_PLAYERS"
    --save_delay "$SAVE_DELAY"
  )
else
  CMD=(
    "$BIN"
    --new "$WORLD_NAME"
    --world_id "$WORLD_ID"
    --port "$PORT"
    --max_players "$MAX_PLAYERS"
    --save_delay "$SAVE_DELAY"
    --world_width "$WORLD_WIDTH"
  )

  if [ "$EXPERT_MODE" = "true" ]; then
    CMD+=(--expert-mode)
  fi
fi

CMD+=(--no-exit)

exec "${CMD[@]}"