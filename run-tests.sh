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

# Start server if not already running. setsid detaches it from the shell's
# process group so a signal aimed at this script (xvfb-run on GH Actions
# does this on some paths) doesn't propagate and kill the dev-server
# mid-suite. `< /dev/null` prevents SIGHUP from closed stdin.
SERVER_PID=""
if ! curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
  setsid node "$DIR/dev-server.js" "$PORT" &>/dev/null < /dev/null &
  SERVER_PID=$!
  sleep 1
  echo "Started server on :$PORT (PID $SERVER_PID)"
fi

# Assert dev-server is reachable — fail fast with a useful message if
# something killed it between startup and here.
ensure_server() {
  if ! curl -s -o /dev/null -m 2 "http://localhost:$PORT/"; then
    echo "dev-server on :$PORT not reachable — aborting"
    exit 2
  fi
}

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && echo "Stopped server"
  return 0
}
trap cleanup EXIT

# Node-side tests first — no browser, fail fast on module / helper regressions
node "$DIR/tests/test-electron-helpers.js" || exit 1
node "$DIR/tests/test-lens-local-utils.js" || exit 1
node "$DIR/tests/test-electron-ipc.js" || exit 1
node "$DIR/tests/test-electron-ipc-drift.js" || exit 1
node "$DIR/tests/test-updater-wiring.js" || exit 1
# Full Electron E2E — graceful-skips if no display available.
# Re-assert dev-server after E2E: Electron E2E has historically been the
# suspect when dev-server disappears mid-suite on CI. If it died, bail
# out with a clear message rather than cascading ECONNREFUSED failures.
node "$DIR/tests/test-electron-e2e.js" || exit 1
ensure_server
PORT=$PORT node "$DIR/tests/test-dev-server-origin.js" || exit 1
PORT=$PORT NODE_PATH="$NODE_PATH_EXTRA" node "$DIR/run-tests.js"
