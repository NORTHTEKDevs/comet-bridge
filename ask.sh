#!/usr/bin/env bash
# Claude's call path: dispatch a query to the Comet Bridge relay and poll for the result.
# Usage: ./ask.sh "your question" [search|research|agent]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RELAY="${BRIDGE_RELAY:-http://127.0.0.1:8787}"
TOKEN="$(cat "$HERE/relay/bridge.token")"
QUERY="${1:?usage: ask.sh \"query\" [mode]}"
MODE="${2:-search}"

BODY=$(QUERY="$QUERY" MODE="$MODE" node -e 'process.stdout.write(JSON.stringify({query:process.env.QUERY,mode:process.env.MODE}))')
ID=$(curl -s -X POST "$RELAY/jobs" -H "content-type: application/json" -H "x-bridge-token: $TOKEN" -d "$BODY" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).id||""))')
[ -n "$ID" ] || { echo "failed to create job (relay up? token ok?)" >&2; exit 1; }

for _ in $(seq 1 90); do
  OUT=$(curl -s "$RELAY/jobs/$ID" -H "x-bridge-token: $TOKEN")
  ST=$(printf '%s' "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).status||""))')
  if [ "$ST" = "done" ]; then
    printf '%s' "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(JSON.parse(d),null,2)))'
    exit 0
  fi
  if [ "$ST" = "error" ]; then printf '%s\n' "$OUT" >&2; exit 1; fi
  sleep 2
done
echo "timeout waiting for job $ID" >&2; exit 1
