#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════╗
# ║  Hybrid Claw — Full OpenClaw with Smart Local/Cloud Routing          ║
# ║                                                                       ║
# ║  All OpenClaw features: web search, browser, skills, channels, hooks  ║
# ║  + Automatic routing between local models (free) and cloud (Claude)   ║
# ║                                                                       ║
# ║  Chat Commands:                                                       ║
# ║    /quit or /exit   — exit the chat                                   ║
# ║    /mode <mode>     — switch routing: prefer-local, prefer-cloud,     ║
# ║                       local-only, cloud-only                          ║
# ║    /status          — show current routing config & features          ║
# ║    /session <id>    — switch to a named session                       ║
# ║    /new             — start a fresh session                           ║
# ║                                                                       ║
# ║  OpenClaw Commands (pass through):                                    ║
# ║    /configure       — run the OpenClaw configure wizard               ║
# ║    /identity        — configure agent name & personality              ║
# ║    /local-models    — configure local Ollama models                   ║
# ║    /doctor          — run health checks                               ║
# ║    /setup           — initialize workspace                            ║
# ╚═══════════════════════════════════════════════════════════════════════╝

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="${SCRIPT_DIR}/openclaw-local.sh"
CONFIG="$HOME/.openclaw-local/openclaw.json"
SESSION_ID="chat-$(date +%s)"

# Resolve node binary (prefer homebrew on macOS, fall back to PATH)
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo "$NODE_BIN")}"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}"
echo "  ╔═════════════════════════════════════════╗"
echo "  ║       🦞 Hybrid Claw v0.2               ║"
echo "  ║   Full OpenClaw + Smart Routing          ║"
echo "  ╚═════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "${DIM}  Models: FunctionGemma (tools) • Gemma 3 270M (text) • Claude Sonnet (cloud)"
echo -e "  Features: web search, browser, skills, channels, hooks — all enabled"
echo -e "  Session: ${SESSION_ID}"
echo -e "  Type /help for commands, /quit to exit${NC}"
echo ""

show_help() {
    echo -e "${YELLOW}Chat Commands:${NC}"
    echo "  /quit, /exit       Exit the chat"
    echo "  /mode <mode>       Switch routing mode:"
    echo "                       prefer-local  — use local when possible (default)"
    echo "                       prefer-cloud  — use cloud when possible"
    echo "                       local-only    — never use cloud"
    echo "                       cloud-only    — always use cloud"
    echo "  /status            Show current routing config & enabled features"
    echo "  /session <id>      Switch to a named session (preserves history)"
    echo "  /new               Start a fresh session"
    echo ""
    echo -e "${YELLOW}OpenClaw Commands:${NC}"
    echo "  /configure         Run the OpenClaw configure wizard"
    echo "  /identity          Configure agent name, personality & your info"
    echo "  /local-models      Configure local Ollama models (function-calling + text)"
    echo "  /doctor            Run health checks on gateway & channels"
    echo "  /setup             Initialize workspace"
    echo "  /onboard           Run the full onboarding wizard"
    echo ""
    echo -e "${YELLOW}Tips:${NC}"
    echo "  • Simple tasks (file reads, commands) → local model (free, ~1-2s)"
    echo "  • Text questions → local text model (free, ~1-3s)"
    echo "  • Complex tasks (explain in detail, implement, refactor) → cloud (~15-20s)"
    echo "  • Use /mode cloud-only to always use Claude Sonnet"
    echo ""
}

show_status() {
    echo -e "${YELLOW}Current Configuration:${NC}"
    echo -e "  Session:     ${SESSION_ID}"
    $NODE_BIN -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('${CONFIG}', 'utf-8'));
        const hr = cfg.agents?.defaults?.hybridRouter || {};
        console.log('  Routing:     ' + (hr.preference || 'prefer-local'));
        console.log('  Local:       ' + (hr.localModel?.id || 'functiongemma') + ' (tool calls)');
        console.log('  Local-Text:  ' + (hr.localTextModel?.id || 'none') + ' (text answers)');
        console.log('  Cloud:       ' + (hr.cloudModel?.provider || 'none') + '/' + (hr.cloudModel?.id || 'none'));
        console.log('');
        console.log('  Web Search:  ' + (cfg.tools?.web?.search?.enabled ? 'enabled' : 'disabled'));
        console.log('  Web Fetch:   ' + (cfg.tools?.web?.fetch?.enabled ? 'enabled' : 'disabled'));
        console.log('  Hooks:       ' + (cfg.hooks?.internal?.enabled ? 'enabled' : 'disabled'));
        console.log('  Channels:    ' + Object.keys(cfg.channels || {}).filter(k => cfg.channels[k].enabled).join(', ') || 'none');
        console.log('  Plugins:     ' + Object.keys(cfg.plugins?.entries || {}).filter(k => cfg.plugins.entries[k].enabled).join(', ') || 'none');
        console.log('  Gateway:     port ' + (cfg.gateway?.port || 18790));
        console.log('  Concurrency: ' + (cfg.agents?.defaults?.maxConcurrent || 1) + ' agents, ' + (cfg.agents?.defaults?.subagents?.maxConcurrent || 1) + ' subagents');
    " 2>/dev/null
    echo ""
}

set_mode() {
    local new_mode="$1"
    case "$new_mode" in
        prefer-local|prefer-cloud|local-only|cloud-only)
            $NODE_BIN -e "
                const fs = require('fs');
                const cfg = JSON.parse(fs.readFileSync('${CONFIG}', 'utf-8'));
                cfg.agents.defaults.hybridRouter.preference = '${new_mode}';
                fs.writeFileSync('${CONFIG}', JSON.stringify(cfg, null, 2) + '\n');
                console.log('Routing mode set to: ${new_mode}');
            " 2>/dev/null
            ;;
        *)
            echo -e "${YELLOW}Unknown mode: ${new_mode}${NC}"
            echo "  Valid modes: prefer-local, prefer-cloud, local-only, cloud-only"
            ;;
    esac
    echo ""
}

# Main REPL loop
while true; do
    echo -en "${GREEN}${BOLD}you › ${NC}"
    IFS= read -r input || break

    # Skip empty input
    [[ -z "${input// }" ]] && continue

    # Handle commands
    case "$input" in
        /quit|/exit)
            echo -e "${DIM}Goodbye! 👋${NC}"
            break
            ;;
        /help)
            show_help
            continue
            ;;
        /status)
            show_status
            continue
            ;;
        /new)
            SESSION_ID="chat-$(date +%s)"
            echo -e "${DIM}New session: ${SESSION_ID}${NC}"
            echo ""
            continue
            ;;
        /session\ *)
            SESSION_ID="${input#/session }"
            echo -e "${DIM}Switched to session: ${SESSION_ID}${NC}"
            echo ""
            continue
            ;;
        /mode\ *)
            set_mode "${input#/mode }"
            continue
            ;;
        /mode)
            echo -e "${YELLOW}Usage: /mode <prefer-local|prefer-cloud|local-only|cloud-only>${NC}"
            echo ""
            continue
            ;;
        /configure)
            echo -e "${DIM}Launching OpenClaw configure wizard...${NC}"
            bash "${LAUNCHER}" configure
            echo ""
            continue
            ;;
        /identity)
            echo -e "${DIM}Launching identity configuration...${NC}"
            bash "${LAUNCHER}" configure --sections identity
            echo ""
            continue
            ;;
        /local-models)
            echo -e "${DIM}Launching local models configuration...${NC}"
            bash "${LAUNCHER}" configure --sections local-models
            echo ""
            continue
            ;;
        /doctor)
            echo -e "${DIM}Running health checks...${NC}"
            bash "${LAUNCHER}" doctor
            echo ""
            continue
            ;;
        /setup)
            echo -e "${DIM}Running workspace setup...${NC}"
            bash "${LAUNCHER}" setup
            echo ""
            continue
            ;;
        /onboard)
            echo -e "${DIM}Launching onboarding wizard...${NC}"
            bash "${LAUNCHER}" onboard
            echo ""
            continue
            ;;
        /*)
            echo -e "${YELLOW}Unknown command: ${input}. Type /help for available commands.${NC}"
            echo ""
            continue
            ;;
    esac

    # Run the agent and capture output
    echo -e "${DIM}thinking...${NC}"
    result=$(bash "${LAUNCHER}" agent --local \
        --message "${input}" \
        --session-id "${SESSION_ID}" \
        --json \
        --timeout 120 2>&1)

    # Extract routing info from stderr lines
    route_info=$(echo "$result" | grep -o '→ [^ ]* model=[^ ]*' | head -1)

    # Extract the response text from JSON
    response=$($NODE_BIN -e "
        const lines = process.argv[1].split('\n');
        // Find the JSON object (skip [hybrid-router] log lines)
        const jsonStart = lines.findIndex(l => l.trimStart().startsWith('{'));
        if (jsonStart < 0) { console.log(lines.join('\n')); process.exit(0); }
        try {
            const json = JSON.parse(lines.slice(jsonStart).join('\n'));
            const text = json.payloads?.[0]?.text || 'No response';
            const ms = json.meta?.durationMs || 0;
            const model = json.meta?.agentMeta?.model || '?';
            const provider = json.meta?.agentMeta?.provider || '?';
            console.log(text);
            console.error(provider + '/' + model + ' · ' + (ms/1000).toFixed(1) + 's');
        } catch(e) {
            console.log(lines.join('\n'));
        }
    " "$result" 2>/tmp/hybrid-claw-meta.txt)

    meta=$(cat /tmp/hybrid-claw-meta.txt 2>/dev/null || echo "")

    # Print response
    echo -e "\033[1A\033[2K"  # Clear "thinking..." line
    echo -e "${CYAN}${BOLD}claw › ${NC}${response}"
    if [[ -n "$meta" ]]; then
        echo -e "${DIM}       ── ${route_info} ${meta}${NC}"
    fi
    echo ""
done
