#!/usr/bin/env bash
# Usage: ./scripts/kill-port.sh [PORT]  (default: 3456)
# Kills every process listening on the given port. Retries until clear.

set -euo pipefail

PORT="${1:-3456}"
MAX_ATTEMPTS=5
ATTEMPT=0

echo "Clearing port $PORT..."

while true; do
  PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)

  if [ -z "$PIDS" ]; then
    echo "✔ Port $PORT is free."
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -gt "$MAX_ATTEMPTS" ]; then
    echo "✘ Failed to free port $PORT after $MAX_ATTEMPTS attempts. Remaining PIDs: $PIDS"
    exit 1
  fi

  for PID in $PIDS; do
    CMD=$(ps -p "$PID" -o command= 2>/dev/null || echo "unknown")
    echo "  Attempt $ATTEMPT: killing PID $PID ($CMD)"

    if [ "$ATTEMPT" -le 2 ]; then
      kill "$PID" 2>/dev/null || true
    else
      kill -9 "$PID" 2>/dev/null || true
    fi
  done

  sleep 0.5
done
