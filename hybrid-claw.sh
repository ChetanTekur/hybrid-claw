#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════╗
# ║  Hybrid Claw — Full OpenClaw with Smart Local/Cloud Routing          ║
# ║                                                                       ║
# ║  Usage:                                                               ║
# ║    ./hybrid-claw.sh              — start gateway + TUI (interactive)  ║
# ║    ./hybrid-claw.sh tui          — start gateway + TUI (interactive)  ║
# ║    ./hybrid-claw.sh agent <args> — run a single agent command         ║
# ║    ./hybrid-claw.sh gateway      — start just the gateway             ║
# ║    ./hybrid-claw.sh stop         — stop the background gateway        ║
# ║    ./hybrid-claw.sh <any>        — pass through to openclaw-local.sh  ║
# ╚═══════════════════════════════════════════════════════════════════════╝

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="${SCRIPT_DIR}/openclaw-local.sh"
CONFIG="$HOME/.openclaw-local/openclaw.json"
GATEWAY_PID_FILE="/tmp/hybrid-claw-gateway.pid"
GATEWAY_LOG="/tmp/hybrid-claw-gateway.log"

# Resolve node binary
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo "/opt/homebrew/bin/node")}"
if [[ ! -x "$NODE_BIN" ]]; then
    echo "ERROR: node not found. Install Node.js or set NODE_BIN."
    exit 1
fi

# Read gateway port from config
GATEWAY_PORT=$("$NODE_BIN" -e "
    try {
        const cfg = JSON.parse(require('fs').readFileSync('${CONFIG}', 'utf-8'));
        console.log(cfg.gateway?.port || 18790);
    } catch { console.log(18790); }
" 2>/dev/null)

# Read gateway token from config
GATEWAY_TOKEN=$("$NODE_BIN" -e "
    try {
        const cfg = JSON.parse(require('fs').readFileSync('${CONFIG}', 'utf-8'));
        console.log(cfg.gateway?.auth?.token || '');
    } catch { console.log(''); }
" 2>/dev/null)

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

# ── Gateway management ─────────────────────────────────────────────────

is_gateway_running() {
    # Check if something is listening on the gateway port
    lsof -i -P -n 2>/dev/null | grep -q ":${GATEWAY_PORT}.*LISTEN"
}

start_gateway() {
    if is_gateway_running; then
        echo -e "${DIM}  Gateway already running on port ${GATEWAY_PORT}${NC}"
        return 0
    fi

    echo -e "${DIM}  Starting Hybrid Claw gateway on port ${GATEWAY_PORT}...${NC}"

    # Start gateway as a background process from OUR fork (not system OpenClaw)
    export OPENCLAW_STATE_DIR="$HOME/.openclaw-local"
    export OPENCLAW_GATEWAY_TOKEN="${GATEWAY_TOKEN}"
    "$NODE_BIN" "${SCRIPT_DIR}/openclaw-local/openclaw.mjs" gateway \
        --port "${GATEWAY_PORT}" \
        > "${GATEWAY_LOG}" 2>&1 &
    local gw_pid=$!
    echo "$gw_pid" > "${GATEWAY_PID_FILE}"

    # Wait for gateway to be ready (up to 15 seconds)
    local waited=0
    while ! is_gateway_running; do
        sleep 1
        waited=$((waited + 1))
        if [[ $waited -ge 15 ]]; then
            echo -e "${RED}  ERROR: Gateway failed to start after 15 seconds.${NC}"
            echo -e "${DIM}  Check ${GATEWAY_LOG} for details.${NC}"
            kill "$gw_pid" 2>/dev/null || true
            return 1
        fi
    done

    echo -e "${GREEN}  Gateway running (PID ${gw_pid}, port ${GATEWAY_PORT})${NC}"
}

stop_gateway() {
    if [[ -f "${GATEWAY_PID_FILE}" ]]; then
        local pid
        pid=$(cat "${GATEWAY_PID_FILE}")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid"
            echo -e "${DIM}  Stopped gateway (PID ${pid})${NC}"
        fi
        rm -f "${GATEWAY_PID_FILE}"
    fi

    # Also kill any node process listening on our port
    local pids
    pids=$(lsof -t -i ":${GATEWAY_PORT}" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        echo "$pids" | xargs kill 2>/dev/null || true
        echo -e "${DIM}  Killed process(es) on port ${GATEWAY_PORT}${NC}"
    fi
}

# ── Ollama check ───────────────────────────────────────────────────────

ensure_ollama() {
    if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        return 0
    fi
    echo -e "${DIM}  Starting Ollama...${NC}"
    open -a Ollama 2>/dev/null || true
    for i in {1..30}; do
        if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
            echo -e "${GREEN}  Ollama ready${NC}"
            return 0
        fi
        sleep 1
    done
    echo -e "${YELLOW}  WARNING: Ollama not detected — local models won't work${NC}"
}

# ── Banner ─────────────────────────────────────────────────────────────

show_banner() {
    echo -e "${CYAN}${BOLD}"
    echo "  ╔═════════════════════════════════════════╗"
    echo "  ║       🦞 Hybrid Claw v0.3               ║"
    echo "  ║   Full OpenClaw + Smart Routing          ║"
    echo "  ╚═════════════════════════════════════════╝"
    echo -e "${NC}"
    echo -e "${DIM}  Models: FunctionGemma (tools) • Gemma 3 270M (text) • Claude Sonnet (cloud)"
    echo -e "  Features: web search, browser, skills, channels, cron, hooks — all enabled"
    echo -e "  Gateway: ws://127.0.0.1:${GATEWAY_PORT}${NC}"
    echo ""
}

# ── Cleanup on exit ────────────────────────────────────────────────────

cleanup() {
    # Only stop the gateway if WE started it (check PID file)
    if [[ -f "${GATEWAY_PID_FILE}" ]]; then
        local pid
        pid=$(cat "${GATEWAY_PID_FILE}")
        if kill -0 "$pid" 2>/dev/null; then
            echo ""
            echo -e "${DIM}  Stopping gateway (PID ${pid})...${NC}"
            kill "$pid" 2>/dev/null || true
        fi
        rm -f "${GATEWAY_PID_FILE}"
    fi
}

# ── Main ───────────────────────────────────────────────────────────────

cmd="${1:-tui}"

case "$cmd" in
    tui|"")
        # Default: start gateway + TUI
        show_banner
        ensure_ollama
        start_gateway || exit 1
        echo ""

        # Trap to stop gateway when TUI exits
        trap cleanup EXIT

        # Launch the TUI connected to OUR gateway
        echo -e "${DIM}  Launching TUI...${NC}"
        echo ""
        export OPENCLAW_STATE_DIR="$HOME/.openclaw-local"
        exec "$NODE_BIN" "${SCRIPT_DIR}/openclaw-local/openclaw.mjs" tui \
            --url "ws://127.0.0.1:${GATEWAY_PORT}" \
            --token "${GATEWAY_TOKEN}"
        ;;

    gateway)
        # Start just the gateway (foreground)
        show_banner
        ensure_ollama
        echo -e "${DIM}  Starting gateway in foreground (Ctrl+C to stop)...${NC}"
        echo ""
        export OPENCLAW_STATE_DIR="$HOME/.openclaw-local"
        export OPENCLAW_GATEWAY_TOKEN="${GATEWAY_TOKEN}"
        exec "$NODE_BIN" "${SCRIPT_DIR}/openclaw-local/openclaw.mjs" gateway \
            --port "${GATEWAY_PORT}"
        ;;

    stop)
        stop_gateway
        ;;

    agent)
        # Pass through to openclaw-local.sh for single-turn agent commands
        shift
        export OPENCLAW_STATE_DIR="$HOME/.openclaw-local"
        exec bash "${LAUNCHER}" agent --local "$@"
        ;;

    *)
        # Pass through any other command to openclaw-local.sh
        export OPENCLAW_STATE_DIR="$HOME/.openclaw-local"
        exec bash "${LAUNCHER}" "$@"
        ;;
esac
