#!/bin/sh
# Entrypoint for Railway — runs A2MCP server + optional OKX heartbeat
# On first deploy, user must `railway shell` and run:
#   onchainos wallet login
#   onchainos wallet verify <OTP>
# Session persists via Railway volume mount at /root

# NOTE: No set -e — Alpine/BusyBox date format differs from GNU

LOG="/tmp/startup.log"
DATE_CMD="date -u +%Y-%m-%dT%H:%M:%SZ"

log() {
  echo "[$($DATE_CMD)] $1" | tee -a "$LOG"
}

log "Entrypoint: starting..."

# ---- Check onchainos auth ----
if command -v onchainos >/dev/null 2>&1; then
  ONCHAINOS="onchainos"
else
  ONCHAINOS="/usr/local/bin/onchainos"
fi

WALLET_FILE="$HOME/.onchainos/wallets.json"
SESSION_FILE="$HOME/.onchainos/session.json"

if [ -f "$WALLET_FILE" ] && [ -f "$SESSION_FILE" ]; then
  log "onchainos wallet found — checking auth"
  $ONCHAINOS wallet status > /tmp/wallet-status.log 2>&1
  if [ $? -eq 0 ]; then
    log "onchainos wallet: AUTHENTICATED"
    AUTHENTICATED=true
  else
    log "onchainos wallet: session expired or invalid"
    AUTHENTICATED=false
  fi
else
  log "onchainos wallet NOT SET UP — to fix: railway shell → onchainos wallet login"
  AUTHENTICATED=false
fi

# ---- Start heartbeat if authenticated ----
if [ "$AUTHENTICATED" = "true" ]; then
  log "Starting heartbeat cron..."
  sh /app/heartbeat.sh >> "$LOG" 2>&1 &
  HBPID=$!
  log "Heartbeat cron started (PID $HBPID)"
else
  log "Heartbeat: SKIPPED (no auth)"
fi

# ---- Start A2MCP server ----
log "Starting A2MCP server..."
exec npx tsx src/a2mcp-server-express.ts
