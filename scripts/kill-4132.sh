#!/usr/bin/env bash
# Nukes everything related to port 4132 in this repo:
#  - anything listening on :4132
#  - nodemon processes watching server.js in this repo
#  - node server.js processes from this repo
# Retries until clear.

set -euo pipefail

PORT=4132
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAX_ATTEMPTS=5

echo "Nuking port $PORT and all related node/nodemon processes in $REPO_DIR"

collect_pids() {
  {
    lsof -ti :"$PORT" 2>/dev/null || true
    # node server.js processes where cwd or cmdline references this repo
    pgrep -f "node .*server\.js" 2>/dev/null || true
    # nodemon processes watching server.js
    pgrep -f "nodemon .*server\.js" 2>/dev/null || true
    # npm exec nodemon wrappers
    pgrep -f "npm exec nodemon" 2>/dev/null || true
  } | sort -u | grep -v "^$" || true
}

for ATTEMPT in $(seq 1 $MAX_ATTEMPTS); do
  PIDS=$(collect_pids)

  if [ -z "$PIDS" ]; then
    echo "Port $PORT is free, no stray node/nodemon processes remain."
    exit 0
  fi

  echo "Attempt $ATTEMPT: killing PIDs:"
  for PID in $PIDS; do
    CMD=$(ps -p "$PID" -o command= 2>/dev/null || echo "unknown")
    # Filter to our repo where possible. Port-holders get killed regardless.
    if [[ "$CMD" == *"server.js"* || "$CMD" == *"nodemon"* ]]; then
      echo "   PID $PID  $CMD"
      if [ "$ATTEMPT" -le 2 ]; then
        kill "$PID" 2>/dev/null || true
      else
        kill -9 "$PID" 2>/dev/null || true
      fi
    else
      # Only listening-on-port processes that aren't server.js/nodemon — kill them too.
      if lsof -p "$PID" 2>/dev/null | grep -q ":$PORT"; then
        echo "   PID $PID (port holder)  $CMD"
        kill -9 "$PID" 2>/dev/null || true
      fi
    fi
  done

  sleep 0.5
done

REMAINING=$(collect_pids)
if [ -n "$REMAINING" ]; then
  echo "Failed to clear after $MAX_ATTEMPTS attempts. Remaining PIDs: $REMAINING"
  exit 1
fi

echo "Port $PORT is free."
