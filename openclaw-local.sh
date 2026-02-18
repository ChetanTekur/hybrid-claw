#!/usr/bin/env bash
# Hybrid Claw — Full OpenClaw with intelligent local/cloud model routing
# Runs a parallel OpenClaw instance with its own state directory
# All OpenClaw features (skills, tools, channels, hooks) are enabled

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_BIN="${SCRIPT_DIR}/openclaw-local/openclaw.mjs"

# Ensure Ollama is running (needed for local model inference)
if ! curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "Starting Ollama..."
    open -a Ollama
    for i in {1..30}; do
        if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
            echo "Ollama is ready."
            break
        fi
        sleep 1
    done
    if ! curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        echo "ERROR: Ollama failed to start after 30 seconds."
        exit 1
    fi
fi

# Resolve node binary (prefer homebrew on macOS, fall back to PATH)
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo "/opt/homebrew/bin/node")}"
if [[ ! -x "$NODE_BIN" ]]; then
    echo "ERROR: node not found. Install Node.js or set NODE_BIN."
    exit 1
fi

# Run OpenClaw with the hybrid-claw state directory (port 18790)
export OPENCLAW_STATE_DIR="$HOME/.openclaw-local"
exec "$NODE_BIN" "${OPENCLAW_BIN}" "$@"
