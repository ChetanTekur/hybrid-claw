# Hybrid Claw — Local/Cloud Model Routing for OpenClaw

<p align="center">
  <strong>Free local models for simple tasks. Cloud models when you actually need them.</strong>
</p>

> **Prototype. Mostly vibe-coded. Use at your own risk.** This is a proof-of-concept built on a Mac Mini M1 with 8 GB of RAM. It works, passes 67/67 routing tests, and saves real money — but it's scrappy. The entire project was built rapidly with heavy AI assistance (Claude wrote most of the code while I steered), the models are tiny (270M parameters), the classifier is keyword-based, and some prompts will land in the wrong bucket. Testing is limited to routing logic only — there are no integration tests, no security audits, and no guarantees. Consider this a starting point, not a finished product.

## What is this?

**Hybrid Claw** patches [OpenClaw](https://github.com/nichochar/openclaw) (by [Peter Steinberger](https://github.com/steipete) and [Nicholas Charriere](https://github.com/nichochar)) with a routing layer that automatically switches between **free local models** (via [Ollama](https://ollama.com/)) and **cloud models** (Claude Sonnet) based on what you're asking.

The core idea: most interactions with an AI assistant are simple — "read this file", "what's 2+2", "yes". You don't need a $20/month API call for those. A 270M-parameter model running on your machine handles them in 1-2 seconds for free. When you ask something genuinely complex — "explain the event loop in detail", "find me the best ski socks", "refactor this component" — the router escalates to Claude.

**All OpenClaw features remain enabled**: web search, browser control, skills, channels (Telegram, WhatsApp, etc.), hooks, memory, and the full tool suite.

## How it works

```
User message → OpenClaw agent loop → streamFn(model, context, opts)
                                          ↓
                                 hybrid-router wrapper
                                          ↓
                                  classifyComplexity()
                                          ↓
                       ┌──────────────────┼──────────────────┐
                       ▼                  ▼                  ▼
                FunctionGemma       Gemma 3 270M        Claude Sonnet
                (tool calls)        (text answers)      (complex tasks)
                  free, ~1-2s         free, ~1-3s         ~15-20s
```

The router wraps `agent.streamFn` — the function called on every LLM invocation. It inspects the conversation context, scores the prompt's complexity (0.0 to 1.0), and picks the right model before forwarding to the real `streamFn`. This follows the same wrapper pattern used by OpenClaw's `cache-trace.js` and `anthropic-payload-log.js`.

## Three models, three jobs

| Model | Provider | Parameters | Role | Speed | Cost |
|---|---|---|---|---|---|
| **FunctionGemma** | Ollama | 270M | Tool calls (file reads, shell commands, edits) | ~1-2s | Free |
| **Gemma 3 270M** | Ollama | 270M | Text answers (questions, greetings, simple explanations) | ~1-3s | Free |
| **Claude Sonnet 4.5** | Anthropic | Cloud | Complex tasks (architecture, refactoring, web search, recommendations) | ~15-20s | API cost |

You can swap these for any models your hardware supports. The defaults are chosen for 8 GB RAM — larger machines should try bigger models (see [Hardware notes](#hardware-notes)).

## Routing decision logic

Every turn of the agent loop:

1. **Preference override** — `local-only` or `cloud-only` short-circuits everything
2. **Force-cloud patterns** — regex matches like `explain.*in detail`, `implement.*feature`, `refactor` → cloud
3. **Force-local patterns** — regex matches like `read.*file`, `^(yes|no|ok|sure)$` → local
4. **Post-tool turn** — last message is a `toolResult` → local (just needs to summarize)
5. **Cloud-capability tags** — prompt needs web search, real-time data, shopping, or recommendations → cloud (local models literally can't do these)
6. **Heuristic scoring** — weighted keyword matching with multi-signal boost:
   - Score ≥ 0.7 → cloud (genuinely complex)
   - Score 0.5-0.7 under `prefer-local` → local-text (moderate, save money)
   - Score < 0.5 → local or local-text based on whether tools are needed

The classifier is **keyword-based, not ML**. It uses ~20 weighted regex patterns plus word-count heuristics. It's surprisingly effective (67/67 tests pass) but will misroute some edge cases. See [Known limitations](#known-limitations).

## Install

### Prerequisites

- **Node.js ≥ 22**
- **[Ollama](https://ollama.com/)** installed and running
- **[OpenClaw](https://github.com/nichochar/openclaw)** — Hybrid Claw includes a patched copy in `openclaw-local/`

### Setup

```bash
git clone https://github.com/YOUR_USERNAME/hybrid-claw.git
cd hybrid-claw

# Install dependencies
cd openclaw-local && npm install && cd ..

# Pull the local models (~300 MB each)
ollama pull functiongemma
ollama pull gemma3:270m

# Copy the example config and add your API key
cp openclaw.example.json ~/.openclaw-local/openclaw.json
# Edit ~/.openclaw-local/openclaw.json — add your Anthropic API key in auth.profiles

# Run the onboarding wizard (configures identity, models, gateway)
bash openclaw-local.sh onboard
```

### Quick start

```bash
# Interactive chat (recommended)
bash hybrid-claw.sh

# Single message
bash openclaw-local.sh agent --local --message "Read /tmp/test.txt" --json --timeout 60
```

## Usage — The Hybrid Claw REPL

```bash
bash hybrid-claw.sh
```

This launches an interactive chat with routing info displayed after each response:

```
  ╔═════════════════════════════════════════╗
  ║       🦞 Hybrid Claw v0.2               ║
  ║   Full OpenClaw + Smart Routing          ║
  ╚═════════════════════════════════════════╝

  Models: FunctionGemma (tools) • Gemma 3 270M (text) • Claude Sonnet (cloud)
  Type /help for commands, /quit to exit

you › read /etc/hosts
thinking...
claw › Here are the contents of /etc/hosts: ...
       ── → local model=ollama/functiongemma 1.2s

you › What is a closure?
claw › A closure is a function that captures variables from its enclosing scope...
       ── → local-text model=ollama/gemma3:270m 2.1s

you › Find me the highest rated ski socks
claw › I found several highly-rated ski socks. Here are the top picks: ...
       ── → cloud model=anthropic/claude-sonnet-4-5 18.3s
```

### Chat commands

| Command | Description |
|---|---|
| `/help` | Show all available commands |
| `/quit` or `/exit` | Exit the chat |
| `/mode <mode>` | Switch routing: `prefer-local`, `prefer-cloud`, `local-only`, `cloud-only` |
| `/status` | Show current routing config and enabled features |
| `/session <id>` | Switch to a named session (preserves history) |
| `/new` | Start a fresh session |

### OpenClaw commands (pass through)

| Command | Description |
|---|---|
| `/configure` | Run the full OpenClaw configure wizard |
| `/identity` | Configure agent name, personality, and your info |
| `/local-models` | Configure which Ollama models to use |
| `/doctor` | Run health checks on gateway and channels |
| `/onboard` | Run the full onboarding wizard |

## Configuration

All config lives in `~/.openclaw-local/openclaw.json` under `agents.defaults.hybridRouter`:

```json
{
  "hybridRouter": {
    "enabled": true,
    "preference": "prefer-local",
    "localModel": { "provider": "ollama", "id": "functiongemma:latest" },
    "localTextModel": { "provider": "ollama", "id": "gemma3:270m" },
    "cloudModel": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
    "routing": {
      "complexityThreshold": 0.5,
      "toolCallsPreferLocal": true,
      "forceCloudPatterns": ["explain.*in detail", "implement.*feature", "refactor", "write.*comprehensive"],
      "forceLocalPatterns": ["read.*file", "list.*dir", "run.*command", "^(yes|no|ok|sure)$"]
    },
    "fallback": {
      "onCloudUnavailable": "local-text",
      "onLocalError": "cloud"
    }
  }
}
```

### Tuning

- **`preference`**: `prefer-local` (default, saves money), `prefer-cloud` (better answers), `local-only` (never use cloud), `cloud-only` (always use cloud)
- **`complexityThreshold`**: Lower = more tasks go to cloud. Higher = more stay local. Default 0.5 is a good balance.
- **`forceCloudPatterns`** / **`forceLocalPatterns`**: Add regex patterns to override the heuristic scorer for specific prompt types.
- **Model IDs**: Swap to any Ollama model. Bigger models = better routing quality.

### Identity

Hybrid Claw reads workspace identity files to give local models a consistent personality:

- `~/.openclaw-local/workspace/IDENTITY.md` — Agent name, full name, vibe
- `~/.openclaw-local/workspace/SOUL.md` — Personality directives
- `~/.openclaw-local/workspace/USER.md` — Your name, how to address you

Configure these with `/identity` in the REPL or `bash openclaw-local.sh configure --sections identity`.

## Testing

> **Honest caveat:** Testing here is limited. The test suite only validates the **routing classifier** — it checks that prompts get scored correctly and routed to the right model. There are **no integration tests** (actual Ollama API calls), **no end-to-end tests** (full agent loop), **no security tests**, and **no load/stress tests**. The 67 tests cover the happy path well, but edge cases in the real OpenClaw agent loop, tool dispatch, or Ollama API are not tested. If you're building on this, add more tests.

```bash
node test-suite.mjs
```

The test suite validates 67 routing scenarios across 10 categories:

| Category | Tests | What it checks |
|---|---|---|
| Config Resolution | 8 | Config parsing, defaults, patterns |
| Cloud API Key Detection | 2 | Auth profile and env var detection |
| Force-Local Patterns | 9 | File reads, commands, confirmations → local |
| Local-Text Routing | 6 | Simple questions → local text model |
| Force-Cloud Patterns | 4 | "Explain in detail", "implement feature" → cloud |
| Cloud Capabilities | 12 | Search, recommendations, real-time, shopping → cloud |
| High Complexity | 4+4 | Multi-signal prompts + known borderline cases |
| Edge Cases | 8 | Empty strings, emoji, long prompts, mixed signals |
| Preference Overrides | 6 | local-only, cloud-only, prefer-cloud, prefer-local |
| Score Boundaries | 4 | Threshold behavior, clamping to [0, 1] |

### Debug mode

```bash
OPENCLAW_HYBRID_DEBUG=1 bash openclaw-local.sh agent --local --message "your prompt" --json --timeout 60
```

This logs detailed routing decisions including scores, tags, and model selection.

## Architecture — What was modified

Hybrid Claw is a **parallel installation** that runs alongside your regular OpenClaw. It uses its own state directory (`~/.openclaw-local/`) so nothing interferes with your main install.

### Files created

| File | Purpose |
|---|---|
| `dist/agents/hybrid-router.js` | Core router: classifier, model resolution, streamFn wrapper (~715 lines) |
| `dist/commands/configure.identity.js` | Interactive identity wizard for agent personality |
| `dist/commands/configure.local-models.js` | Interactive wizard for Ollama model selection |
| `hybrid-claw.sh` | REPL with chat commands and routing display |
| `openclaw-local.sh` | Launcher with Ollama auto-start and state isolation |
| `test-suite.mjs` | 67-test validation suite |
| `openclaw.example.json` | Template config with placeholder values |

### Files modified

| File | Change |
|---|---|
| `dist/agents/pi-embedded-runner/run/attempt.js` | Added hybrid router wrapper after `streamFn` setup |
| `dist/commands/configure.shared.js` | Added "identity" and "local-models" wizard sections |
| `dist/commands/configure.wizard.js` | Added handlers for identity and local-models config |
| `dist/wizard/onboarding.js` | Added identity and local-models steps to onboarding flow |

### Key design decisions

- **270M models need simplified tool schemas.** OpenClaw's 23 tools have complex schemas (the `exec` tool alone is 1037 chars with 12 parameters). FunctionGemma can't parse that. The router replaces them with 4 simplified core tools (read, exec, write, edit) with 1-3 parameters each.
- **Identity injection prevents model self-identification.** Without it, Gemma 3 responds "I am a Gemma model" instead of maintaining the agent personality. The router reads workspace identity files at startup and injects a compact preamble.
- **Cloud-capability tags bypass the complexity score.** Prompts needing web search, real-time data, or recommendations must go to cloud regardless of complexity — local models literally cannot fulfill these.
- **Per-call API key resolution.** When switching from Ollama to Anthropic, the router resolves the API key dynamically so the correct auth is used.

## Known limitations

This is a prototype. Here's what to expect:

1. **Keyword classifier, not ML.** The heuristic scorer uses ~20 regex patterns. It handles common cases well but will misroute some edge cases. A 13-word prompt with one complexity signal might stay local when it should go to cloud.

2. **270M models are tiny.** FunctionGemma sometimes picks the wrong tool (e.g., calling `read` on a directory instead of `exec ls`). Gemma 3 gives shallow answers to nuanced questions. This is a hardware constraint, not a design flaw.

3. **No streaming for local models.** The Ollama completions API supports streaming, but the current integration waits for the full response. This is fine at 1-3s but would matter with larger models.

4. **Borderline prompts default to local under `prefer-local`.** Moderate-complexity prompts (score 0.5-0.7) go to local-text to save money. Switch to `prefer-cloud` or `/mode cloud-only` for better answers.

5. **First-turn latency.** Ollama loads models into RAM on first use (~2-5s). Subsequent calls are fast. Keep Ollama running to avoid cold starts.

## Security warning

**This project was mostly vibe-coded.** That means:

- The code was written rapidly with heavy AI assistance, not carefully hand-audited line by line
- The routing layer intercepts every LLM call in the agent loop — if there's a bug, it could affect all interactions
- API keys are resolved dynamically at runtime and passed between providers — handle your credentials carefully
- The shell scripts execute `node -e` with inline JavaScript that reads your config file — standard injection caveats apply
- The simplified tool schemas give FunctionGemma access to `exec` (arbitrary shell commands) — this is intentional for the use case but means the local model can run anything on your machine
- No security audit has been performed on any of this code

**Please take precautions:**

- Review the code yourself before running it, especially `hybrid-router.js` and the shell scripts
- Don't expose the gateway to the public internet without authentication
- Keep your API keys in `~/.openclaw-local/openclaw.json`, not in the repo
- Run in `local-only` mode first to test without touching cloud APIs
- Back up your data — this is prototype software

If you find a security issue, please open an issue on GitHub.

## Hardware notes

This prototype was built and tested on a **Mac Mini M1 with 8 GB RAM**. The 270M models were chosen because they're the largest that run comfortably alongside macOS, Ollama, and OpenClaw in 8 GB.

**If you have better hardware, use bigger models.** The router doesn't care what models you plug in — just change the IDs in config:

| RAM | Suggested local models | Expected quality |
|---|---|---|
| 8 GB | FunctionGemma 270M + Gemma 3 270M (default) | Basic — handles simple tasks, shallow on nuance |
| 16 GB | Qwen 3 4B + Gemma 3 4B | Good — handles moderate questions, reliable tool calls |
| 32 GB | Qwen 3 8B + Llama 3.1 8B | Very good — could handle most tasks without cloud |
| 64+ GB | Qwen 3 30B+ / Llama 3.1 70B | Excellent — cloud becomes a luxury, not a necessity |

## What's next

This was a weekend prototype to prove that hybrid local/cloud routing is viable for a personal AI assistant. It works — 67/67 routing tests pass, and real-world usage shows meaningful cost savings for daily tasks. But there's a lot more to do.

### Immediate next step: Cloud VM with larger models

The biggest limitation right now is hardware. A Mac Mini M1 with 8 GB RAM can only run 270M-parameter models, which are... let's say "enthusiastic but not very bright." The routing architecture itself is model-agnostic — it doesn't care what's behind the Ollama API.

The plan is to test Hybrid Claw on a **cloud VM with a real GPU** (e.g., Lambda Labs A10, RunPod 3090, or a Paperspace instance) running **30B+ parameter models** via Ollama. If a Qwen 3 30B or Llama 3.1 70B can handle most tasks locally, the cloud fallback becomes a rare luxury instead of a frequent necessity — and the API cost savings become dramatic.

This would prove whether the hybrid routing concept scales beyond toy models, or whether you actually need cloud-grade intelligence for most tasks. Stay tuned.

### Other next steps (contributions welcome)

- **Better hardware validation.** Test with 16+ GB local machines and larger models. The router architecture scales — only the model quality improves.
- **More tests.** Integration tests with actual Ollama calls, end-to-end agent loop tests, security review. The current test suite only covers the classifier.
- **ML-based classifier.** Replace the keyword heuristic with a tiny fine-tuned classifier (~50M params) that scores complexity from embeddings. Would eliminate edge case misroutes.
- **Streaming support for local models.** Pipe Ollama's token stream through to the user for perceived-instant responses.

### The hardware fund

Or, if any generous readers want to fund an NVIDIA GB10 or a Mac Studio — or convince my wife that $4,000 on a computer is a reasonable investment in "the future of personal AI" — I'm all ears. DMs open. I promise to write a very detailed blog post about the results. And name a variable after you.

## Credits

**[OpenClaw](https://github.com/nichochar/openclaw)** is created by [Peter Steinberger](https://github.com/steipete) and [Nicholas Charriere](https://github.com/nichochar), and the amazing OpenClaw community. Hybrid Claw is a fork/patch built on top of their work. All original OpenClaw code is MIT-licensed. Huge thanks to the OpenClaw team for building something worth extending.

The hybrid routing layer was built by [Chetan Tekur](https://github.com/chetantekur) with significant help from Claude (yes, the irony of using a cloud AI to build a system that avoids using cloud AI is not lost on me).

## Disclaimer

**THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.** The author(s) are not liable for any damages, data loss, security breaches, unexpected API charges, or any other issues arising from the use of this software. You use Hybrid Claw entirely at your own risk.

This is a prototype that was mostly vibe-coded in a weekend. It has not been professionally audited, penetration-tested, or reviewed for production use. It executes shell commands, manages API keys, and routes between model providers — all things that can go wrong in interesting ways if there are bugs.

**By using this software, you acknowledge that:**
- You are responsible for reviewing the code before running it
- You are responsible for securing your own API keys and credentials
- You are responsible for any costs incurred from cloud API usage
- The author(s) make no guarantees about the correctness, security, or reliability of the routing decisions
- The author(s) are not responsible for anything the local or cloud models say or do

## License

MIT License. This is an **open project** — anyone can use, modify, fork, distribute, sell, or build upon this code for any reason, with no restrictions beyond the MIT license terms. Commercial use, personal use, educational use, whatever — go for it.

See [LICENSE](LICENSE) for the full text.
