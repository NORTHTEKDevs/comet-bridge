#!/usr/bin/env bash
# End-to-end smoke of relay + ask.sh with a SIMULATED extension (no browser).
# Proves: ask.sh creates a job -> extension claims it -> posts result -> ask.sh receives it.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=8799

# clean any stray relay on the port
PID=$(netstat -ano 2>/dev/null | grep "127.0.0.1:$PORT" | grep LISTENING | awk '{print $5}' | head -1)
[ -n "${PID:-}" ] && taskkill //PID "$PID" //F >/dev/null 2>&1

node -e "require('fs').writeFileSync('relay/bridge.token', require('crypto').randomBytes(24).toString('hex'))"
TOKEN=$(cat relay/bridge.token)

BRIDGE_PORT=$PORT node relay/server.js >/tmp/relay.log 2>&1 &
RELAY_PID=$!
sleep 1.5

BRIDGE_RELAY="http://127.0.0.1:$PORT" ./ask.sh "smoke: capital of france" search >/tmp/ask_out.json 2>/tmp/ask_err.txt &
ASK_PID=$!

# simulate the extension: poll for a claimable job (ask.sh's node cold-starts can lag)
JID=""
for _ in $(seq 1 20); do
  CLAIM=$(curl -s "http://127.0.0.1:$PORT/jobs/next" -H "x-bridge-token: $TOKEN")
  if [ -n "$CLAIM" ]; then
    JID=$(printf '%s' "$CLAIM" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).id||"")}catch{}})')
    [ -n "$JID" ] && break
  fi
  sleep 0.5
done
echo "claimed job id: ${JID:-<none>}"
curl -s -X POST "http://127.0.0.1:$PORT/jobs/$JID/result" \
  -H "content-type: application/json" -H "x-bridge-token: $TOKEN" \
  -d '{"result":{"answer":"The capital of France is Paris.","sources":[{"title":"adelphi","url":"https://home.adelphi.edu/x"}]}}' >/dev/null

wait $ASK_PID; ASK_RC=$?
echo "=== ask.sh exit: $ASK_RC ==="
echo "=== ask.sh stdout ==="; cat /tmp/ask_out.json
echo "=== ask.sh stderr ==="; cat /tmp/ask_err.txt
kill $RELAY_PID 2>/dev/null
echo "(relay stopped)"
