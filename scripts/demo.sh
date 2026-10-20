#!/usr/bin/env bash
#
# Offline demo of Punani powerd.
#
# Starts a mock OpenAI-compatible server, points Punani at it, and runs a
# scripted task against the sample project. No API key and no network needed.
#
#   bash scripts/demo.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PUNANI_DEMO_PORT:-3011}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/punani-demo-XXXXXX")"
CONFIG="$WORKDIR/config.json"
DATA="$WORKDIR/data"
PROJECT="$WORKDIR/hello-node"
MOCK_PID=""

cleanup() {
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

say() { printf '\n\033[36m▸ %s\033[0m\n' "$1"; }

say "building"
cd "$ROOT"
npm run build >/dev/null

say "preparing a scratch project"
cp -R "$ROOT/samples/hello-node" "$PROJECT"
cd "$PROJECT"

say "starting the mock provider on port $PORT"
node "$ROOT/samples/mock-server.mjs" --port "$PORT" --script "$ROOT/samples/demo-script.json" &
MOCK_PID=$!
sleep 1

say "writing the local config (mode 0600)"
mkdir -p "$WORKDIR"
cat > "$CONFIG" <<JSON
{
  "version": 1,
  "defaultModel": "demo/demo-assistant",
  "providers": {
    "demo": {
      "id": "demo",
      "kind": "openai-compatible",
      "name": "Demo (offline mock)",
      "baseURL": "http://127.0.0.1:$PORT/v1",
      "env": "DEMO_API_KEY",
      "defaultContextWindow": 32768
    }
  },
  "apiKeys": {
    "demo": "demo-local-key-not-a-real-secret"
  },
  "models": {},
  "permissions": {
    "read": [{ "pattern": "*", "effect": "allow" }],
    "search": [{ "pattern": "*", "effect": "allow" }],
    "write": [{ "pattern": "*", "effect": "ask" }],
    "edit": [{ "pattern": "*", "effect": "ask" }],
    "bash": [{ "pattern": "*", "effect": "ask" }]
  },
  "headers": {}
}
JSON
chmod 600 "$CONFIG"

export PUNANI_CONFIG="$CONFIG"
export XDG_DATA_HOME="$DATA"

say "provider list"
node "$ROOT/dist/main.js" --providers

say "model list"
node "$ROOT/dist/main.js" --models

say "driving the agent (edit and bash are asked for, answer 'y' to allow)"
printf '%s\n' \
  'Add a --loud flag to the greeter, then run the tests.' \
  'y' \
  'y' \
  '/session' \
  '/exit' \
  | node "$ROOT/dist/main.js" -C "$PROJECT" || true

say "session history on disk"
find "$DATA" -name '*.jsonl' -exec echo {} \; -exec tail -n 3 {} \; 2>/dev/null || true

say "the file the agent changed"
cat "$PROJECT/src/greet.js"

say "demo done. scratch dir was $WORKDIR"
