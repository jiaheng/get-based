#!/usr/bin/env bash
# Run all Get Based browser tests headlessly
# Starts a temp server, runs tests, kills server on exit

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=${PORT:-8000}

# Find Puppeteer — check npx cache, then local node_modules
NODE_PATH_EXTRA=""
if [ -d "$HOME/.npm/_npx" ]; then
  NPX_DIR=$(find "$HOME/.npm/_npx" -path "*/node_modules/puppeteer" -type d 2>/dev/null | head -1 | sed 's|/puppeteer$||')
  [ -n "$NPX_DIR" ] && NODE_PATH_EXTRA="$NPX_DIR"
fi
[ -d "$DIR/node_modules/puppeteer" ] && NODE_PATH_EXTRA="$DIR/node_modules"

if [ -z "$NODE_PATH_EXTRA" ]; then
  echo "Puppeteer not found. Install with: npm i -g puppeteer"
  exit 2
fi

# Start server if not already running. nohup + disown fully detaches it
# from the shell — signals sent to the shell's process group (xvfb-run
# on GH Actions has done this in past runs) won't propagate. Log to
# /tmp so we can inspect if it ever dies unexpectedly.
SERVER_PID=""
if ! curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
  nohup node "$DIR/dev-server.js" "$PORT" > /tmp/dev-server.log 2>&1 < /dev/null &
  SERVER_PID=$!
  disown "$SERVER_PID" 2>/dev/null || true
  # Poll until listen actually succeeds — a plain sleep 1 was racy on
  # slower CI runners. 10s ceiling is defensive.
  for i in $(seq 1 40); do
    if curl -s -o /dev/null -m 1 "http://localhost:$PORT/"; then break; fi
    sleep 0.25
  done
  echo "Started server on :$PORT (PID $SERVER_PID)"
fi

# Assert dev-server is reachable — fail fast with a useful message if
# something killed it between startup and here. On CI we also tail its
# log for diagnostics.
ensure_server() {
  if ! curl -s -o /dev/null -m 2 "http://localhost:$PORT/"; then
    echo "dev-server on :$PORT not reachable — aborting"
    if [ -f /tmp/dev-server.log ]; then
      echo "--- /tmp/dev-server.log (last 40 lines) ---"
      tail -40 /tmp/dev-server.log
    fi
    exit 2
  fi
}

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && echo "Stopped server"
  return 0
}
trap cleanup EXIT

# Node-side tests first — no browser, fail fast on module / helper regressions.
# ensure_server is called between each so that if dev-server dies (has
# happened on GH Actions xvfb runners) we get a precise which-test-killed-it
# signal instead of cascading ECONNREFUSED in the HTTP tests.
node "$DIR/tests/test-electron-helpers.js" || exit 1
ensure_server
node "$DIR/tests/test-lens-local-utils.js" || exit 1
ensure_server
node "$DIR/tests/test-electron-ipc.js" || exit 1
ensure_server
node "$DIR/tests/test-electron-ipc-drift.js" || exit 1
ensure_server
node "$DIR/tests/test-updater-wiring.js" || exit 1
ensure_server
# HTTP-reliant tests before the Electron E2E, so the E2E doesn't
# cascade-kill downstream tests if it takes dev-server down with it.
PORT=$PORT node "$DIR/tests/test-dev-server-origin.js" || exit 1
PORT=$PORT NODE_PATH="$NODE_PATH_EXTRA" node "$DIR/run-tests.js"
# Full Electron E2E last. Graceful-skips if no display available.
node "$DIR/tests/test-electron-e2e.js" || exit 1
