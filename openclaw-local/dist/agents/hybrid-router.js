/**
 * Hybrid Model Router for OpenClaw
 *
 * Routes LLM calls between local models (FunctionGemma, Qwen 3 4B) and cloud
 * models based on task complexity. Wraps the agent's streamFn following the
 * same pattern as cache-trace.js and anthropic-payload-log.js.
 *
 * Configuration lives in openclaw.json under agents.defaults.hybridRouter.
 */

import { resolveModel, buildInlineProviderModels } from "./pi-embedded-runner/model.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { normalizeModelCompat } from "./model-compat.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// LOGGING (lightweight — no dependency on subsystem logger)
// ============================================================================

const PREFIX = "[hybrid-router]";
const logInfo  = (...args) => console.log(PREFIX, ...args);
const logWarn  = (...args) => console.warn(PREFIX, ...args);
const logDebug = (...args) => {
    if (process.env.OPENCLAW_HYBRID_DEBUG) console.log(PREFIX, "(debug)", ...args);
};

// ============================================================================
// LOCAL MODEL SYSTEM PROMPTS (compact — the full prompt is 14K+ chars and
// overwhelms 270M-parameter models)
// ============================================================================

// Base prompts (no personality — overridden at wrapper creation time
// once we know the workspace directory and can read identity files)
const BASE_TOOL_PROMPT = [
    "You MUST use tools for every request.",
    "Available: read (read files), exec (run ANY shell command like ls, date, echo, git, etc.),",
    "write (create files), edit (modify files).",
    "ALWAYS call a tool. Never refuse. Be concise.",
].join(" ");

const BASE_TEXT_PROMPT = "Answer clearly and concisely.";

/**
 * Read workspace identity files and build a compact personality preamble.
 * Returns a short string like:
 *   "You are MyBot (My Bot Full Name), a helpful AI assistant
 *    for Alice. Be genuine. Be concise."
 *
 * Falls back to a generic preamble if files are missing.
 */
function buildIdentityPreamble(workspaceDir) {
    if (!workspaceDir) return "You are a helpful assistant.";

    let name = null;
    let fullName = null;
    let vibe = null;
    let userName = null;
    let soulBits = [];

    // Read IDENTITY.md
    try {
        const identity = readFileSync(join(workspaceDir, "IDENTITY.md"), "utf-8");
        const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/);
        const fullNameMatch = identity.match(/\*\*Full Name:\*\*\s*(.+)/);
        const vibeMatch = identity.match(/\*\*Vibe:\*\*\s*(.+)/);
        if (nameMatch) name = nameMatch[1].trim();
        if (fullNameMatch) fullName = fullNameMatch[1].trim();
        if (vibeMatch) vibe = vibeMatch[1].trim();
    } catch {
        // IDENTITY.md not found — that's fine
    }

    // Read SOUL.md — extract key directives
    try {
        const soul = readFileSync(join(workspaceDir, "SOUL.md"), "utf-8");
        // Pull out the bold directives (the ** ... ** lines)
        const directives = soul.match(/\*\*([^*]+)\*\*/g);
        if (directives) {
            soulBits = directives
                .map(d => d.replace(/\*\*/g, "").trim().replace(/\.+$/, ""))  // strip trailing dots
                .filter(d => d.length < 80)   // skip overly long ones
                .slice(0, 4);                  // keep it compact
        }
    } catch {
        // SOUL.md not found
    }

    // Read USER.md — get the user's name
    try {
        const user = readFileSync(join(workspaceDir, "USER.md"), "utf-8");
        const callMatch = user.match(/\*\*What to call them:\*\*\s*(.+)/);
        const nameMatch = user.match(/\*\*Name:\*\*\s*(.+)/);
        if (callMatch) userName = callMatch[1].trim();
        else if (nameMatch) userName = nameMatch[1].trim();
    } catch {
        // USER.md not found
    }

    // Build the preamble
    const parts = [];

    if (name && fullName) {
        parts.push(`You are ${name} (${fullName}), a helpful AI assistant.`);
    } else if (name) {
        parts.push(`You are ${name}, a helpful AI assistant.`);
    } else {
        parts.push("You are a helpful AI assistant.");
    }

    if (userName) {
        parts.push(`You are assisting ${userName}.`);
    }

    if (vibe) {
        parts.push(`Your vibe: ${vibe}`);
    }

    if (soulBits.length > 0) {
        parts.push(soulBits.join(". ") + ".");
    }

    // Never identify as the underlying model
    parts.push("Never say you are Gemma, LLaMA, or any other model. You are only " + (name || "this assistant") + ".");

    return parts.join(" ");
}

// The actual prompts are built dynamically in createHybridRouterWrapper
// using buildIdentityPreamble(). These are just fallback constants.
let LOCAL_TOOL_SYSTEM_PROMPT = "You are a helpful coding assistant with access to tools. " + BASE_TOOL_PROMPT;
let LOCAL_TEXT_SYSTEM_PROMPT = "You are a helpful assistant. " + BASE_TEXT_PROMPT;

// ============================================================================
// CONFIG RESOLUTION
// ============================================================================

/**
 * Read hybridRouter config from the OpenClaw config object.
 * Returns null when the router is disabled or not configured.
 */
export function resolveHybridRouterConfig(cfg) {
    const rc = cfg?.agents?.defaults?.hybridRouter;
    if (!rc?.enabled) return null;

    return {
        enabled: true,
        preference: rc.preference ?? "prefer-local",

        localModel:     rc.localModel     ?? { provider: "ollama", id: "functiongemma" },
        localTextModel: rc.localTextModel ?? null,
        cloudModel:     rc.cloudModel     ?? null,

        routing: {
            complexityThreshold:  rc.routing?.complexityThreshold  ?? 0.5,
            toolCallsPreferLocal: rc.routing?.toolCallsPreferLocal ?? true,
            maxLocalResponseTokens: rc.routing?.maxLocalResponseTokens ?? 500,
            forceCloudPatterns: (rc.routing?.forceCloudPatterns ?? []).map(safeRegex),
            forceLocalPatterns: (rc.routing?.forceLocalPatterns ?? []).map(safeRegex),
        },

        fallback: {
            onCloudUnavailable: rc.fallback?.onCloudUnavailable ?? "local-text",
            onLocalError:       rc.fallback?.onLocalError       ?? "cloud",
        },
    };
}

/** Compile a regex pattern string, returning null on invalid patterns. */
function safeRegex(pattern) {
    try {
        return new RegExp(pattern, "i");
    } catch {
        logWarn(`invalid regex pattern ignored: ${pattern}`);
        return null;
    }
}

// ============================================================================
// MESSAGE HELPERS
// ============================================================================

/** Extract the text of the last user message from the LLM context messages. */
function lastUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === "user") {
            if (typeof m.content === "string") return m.content;
            if (Array.isArray(m.content)) {
                return m.content
                    .filter(c => c.type === "text")
                    .map(c => c.text)
                    .join(" ");
            }
        }
    }
    return "";
}

/** Check whether the most recent non-user message is a toolResult. */
function isPostToolTurn(messages) {
    if (messages.length === 0) return false;
    const last = messages[messages.length - 1];
    return last?.role === "toolResult";
}

/** Count recent tool calls in the conversation. */
function recentToolCallCount(messages, lookback = 10) {
    let count = 0;
    const window = messages.slice(-lookback);
    for (const m of window) {
        if (m.role === "assistant" && Array.isArray(m.content)) {
            count += m.content.filter(c => c.type === "toolCall").length;
        }
    }
    return count;
}

// ============================================================================
// COMPLEXITY CLASSIFICATION
// ============================================================================

const COMPLEX_KEYWORDS = [
    { re: /\b(explain|describe|elaborate)\b/i,             w:  0.15, tag: "explanation" },
    { re: /\b(implement|create|build|develop)\b/i,         w:  0.20, tag: "implementation" },
    { re: /\b(refactor|optimize|improve|restructure)\b/i,  w:  0.20, tag: "refactoring" },
    { re: /\b(debug|fix|solve|troubleshoot)\b/i,           w:  0.15, tag: "debugging" },
    { re: /\b(analyze|compare|evaluate|review)\b/i,        w:  0.15, tag: "analysis" },
    { re: /\b(why|how does|what causes)\b/i,               w:  0.10, tag: "reasoning" },
    { re: /\b(step by step|in detail|thoroughly)\b/i,      w:  0.15, tag: "detail-request" },
    { re: /\b(write|generate|compose)\s+\w+/i,             w:  0.15, tag: "generation" },
    // Web search / research / real-world knowledge — local models can't do this
    { re: /\b(find|search|look\s*up|google|browse)\b/i,    w:  0.35, tag: "search" },
    { re: /\b(recommend|suggest|best|top|highest.rated)\b/i, w: 0.30, tag: "recommendation" },
    { re: /\b(latest|recent|current|today|news|price)\b/i, w:  0.30, tag: "real-time" },
    { re: /\b(buy|purchase|order|shop|deal|discount)\b/i,  w:  0.25, tag: "shopping" },
    // Summarize / plan / multi-step reasoning
    { re: /\b(summarize|plan|design|architect)\b/i,        w:  0.20, tag: "planning" },
    { re: /\b(help me|assist|guide)\b/i,                   w:  0.10, tag: "assistance" },
];

const SIMPLE_KEYWORDS = [
    { re: /\b(read|cat|show|display|print)\s+(the\s+)?(file|content)/i, w: -0.25, tag: "file-read" },
    { re: /\b(list|ls|dir)\b/i,                                         w: -0.20, tag: "directory" },
    { re: /\b(run|execute|exec)\b/i,                                    w: -0.10, tag: "command" },
    { re: /^(yes|no|ok|okay|sure|confirm|yep|nah)\s*[.!?]?\s*$/i,      w: -0.35, tag: "confirmation" },
    { re: /^(hello|hi|hey|thanks|thank you)\s*[.!?]?\s*$/i,            w: -0.30, tag: "greeting" },
];

/**
 * Score a context from 0 (trivial / local) to 1 (complex / cloud).
 * @returns {{ score: number, reason: string, tags: string[] }}
 */
export function classifyComplexity(context, routingCfg) {
    const messages = context.messages ?? [];
    const text = lastUserText(messages);
    const tags = [];

    // ---- Force-match patterns (instant decision) ----
    for (const rx of routingCfg.forceCloudPatterns) {
        if (rx && rx.test(text)) return { score: 1.0, reason: "force-cloud", tags: [rx.source] };
    }
    for (const rx of routingCfg.forceLocalPatterns) {
        if (rx && rx.test(text)) return { score: 0.0, reason: "force-local", tags: [rx.source] };
    }

    // ---- Post-tool turn — local model is fine for summarising results ----
    if (isPostToolTurn(messages)) {
        return { score: 0.0, reason: "post-tool-turn", tags: ["post-tool"] };
    }

    let score = 0;

    // Word-count boost
    const words = text.split(/\s+/).length;
    if (words > 100) { score += 0.15; tags.push("long-prompt"); }
    if (words > 300) { score += 0.15; tags.push("very-long-prompt"); }

    // Keyword matching
    for (const { re, w, tag } of COMPLEX_KEYWORDS) {
        if (re.test(text)) { score += w; tags.push(tag); }
    }
    for (const { re, w, tag } of SIMPLE_KEYWORDS) {
        if (re.test(text)) { score += w; tags.push(tag); }
    }

    // Multi-signal boost: if 2+ complexity tags fired, the prompt is
    // clearly beyond what a 270M model can handle. Boost to ensure
    // it clears the threshold.
    const complexTagCount = tags.filter(t =>
        t !== "long-prompt" && t !== "very-long-prompt" &&
        t !== "file-read" && t !== "directory" && t !== "command" &&
        t !== "confirmation" && t !== "greeting" && t !== "tool-heavy-ctx"
    ).length;
    if (complexTagCount >= 2) {
        score += 0.15;
        tags.push("multi-signal");
    }

    // Word-count boost for medium-length prompts (>12 words often
    // indicates a nuanced question beyond a 270M model)
    if (words > 12 && complexTagCount >= 1) {
        score += 0.10;
        tags.push("detailed-query");
    }

    // Tool-heavy conversation → local is fine
    if (recentToolCallCount(messages) > 3) {
        score -= 0.10;
        tags.push("tool-heavy-ctx");
    }

    return { score: Math.max(0, Math.min(1, score)), reason: "heuristic", tags };
}

// ============================================================================
// CLOUD API KEY DETECTION
// ============================================================================

const ENV_KEY_MAP = {
    anthropic:     "ANTHROPIC_API_KEY",
    openai:        "OPENAI_API_KEY",
    google:        "GOOGLE_API_KEY",
    openrouter:    "OPENROUTER_API_KEY",
    groq:          "GROQ_API_KEY",
    xai:           "XAI_API_KEY",
    mistral:       "MISTRAL_API_KEY",
};

export function hasCloudApiKey(cloudModelRef, cfg, agentDir) {
    if (!cloudModelRef) return false;
    const p = cloudModelRef.provider;

    // Check auth profiles stored in the config (top-level auth section)
    const profiles = cfg?.auth?.profiles ?? {};
    for (const [key, profile] of Object.entries(profiles)) {
        if (key.startsWith(p) && (profile.apiKey || profile.mode === "token")) return true;
    }

    // Check the agent-level auth-profiles.json (OAuth tokens live here)
    try {
        const dir = agentDir ?? resolveOpenClawAgentDir();
        const authPath = join(dir, "auth-profiles.json");
        const raw = JSON.parse(readFileSync(authPath, "utf-8"));
        const agentProfiles = raw?.profiles ?? {};
        for (const [key, profile] of Object.entries(agentProfiles)) {
            if (key.startsWith(p) && (profile.token || profile.apiKey || profile.type === "oauth")) {
                logDebug(`found auth profile for ${p}: ${key} (type=${profile.type})`);
                return true;
            }
        }
    } catch {
        // auth-profiles.json may not exist — that's fine
    }

    // Check environment variables
    const envVar = ENV_KEY_MAP[p];
    if (envVar && process.env[envVar]) return true;

    // Check OAuth-specific env vars
    if (p === "anthropic" && process.env.ANTHROPIC_OAUTH_TOKEN) return true;

    return false;
}

// ============================================================================
// MODEL RESOLUTION
// ============================================================================

/**
 * Resolve a model object from a { provider, id } reference using the
 * same codepath OpenClaw uses for its primary model.
 */
function resolveModelRef(ref, cfg, agentDir) {
    if (!ref) return null;
    try {
        const { model, error } = resolveModel(ref.provider, ref.id, agentDir, cfg);
        if (error) {
            logWarn(`cannot resolve ${ref.provider}/${ref.id}: ${error}`);
            return null;
        }
        return model;
    } catch (err) {
        logWarn(`resolveModel threw for ${ref.provider}/${ref.id}: ${err?.message}`);
        return null;
    }
}

// ============================================================================
// ROUTING DECISION
// ============================================================================

/**
 * Decide which model to use for the current LLM call.
 *
 * @param {object} context     - LLM Context { systemPrompt, messages, tools }
 * @param {object} routerCfg   - Resolved HybridRouterConfig
 * @param {object} models      - { local, localText, cloud } resolved Model objects
 * @param {object} cfg         - Full OpenClaw config
 * @returns {{ target: string, model: object|null, reason: string, score: number, tags: string[] }}
 */
export function makeRoutingDecision(context, routerCfg, models, cfg, agentDir) {
    const { score, reason, tags } = classifyComplexity(context, routerCfg.routing);
    const pref = routerCfg.preference;
    const threshold = routerCfg.routing.complexityThreshold;
    const cloudAvailable = models.cloud && hasCloudApiKey(routerCfg.cloudModel, cfg, agentDir);

    // --- Absolute preference modes ---
    if (pref === "local-only") {
        return pick("local", models.local, "pref:local-only", score, tags);
    }
    if (pref === "cloud-only") {
        if (cloudAvailable) return pick("cloud", models.cloud, "pref:cloud-only", score, tags);
        logWarn("cloud-only but no API key — falling back to local");
        return pick("local", models.local, "pref:cloud-only-no-key", score, tags);
    }

    // --- Force patterns already decided ---
    if (reason === "force-cloud") {
        if (cloudAvailable) return pick("cloud", models.cloud, reason, score, tags);
        return pick("local-text", models.localText ?? models.local, "force-cloud-no-key", score, tags);
    }
    if (reason === "force-local" || reason === "post-tool-turn") {
        return pick("local", models.local, reason, score, tags);
    }

    // --- Cloud-required capabilities ---
    // Some tags indicate the prompt needs capabilities only a cloud model has
    // (web search, real-time data, shopping, recommendations). Route to cloud
    // even if the overall score is below the complexity threshold.
    const CLOUD_REQUIRED_TAGS = new Set(["search", "recommendation", "real-time", "shopping"]);
    const needsCloud = tags.some(t => CLOUD_REQUIRED_TAGS.has(t));
    if (needsCloud && cloudAvailable && pref !== "local-only") {
        return pick("cloud", models.cloud, "cloud-capability", score, tags);
    }

    // --- Complexity-based routing ---
    if (score >= threshold) {
        // Complex task
        if (pref === "prefer-local") {
            // User leans local — use local-text model for moderate complexity
            if (score < 0.7 && models.localText) {
                return pick("local-text", models.localText, "prefer-local+moderate", score, tags);
            }
            // Very complex — try cloud if available, else local-text
            if (cloudAvailable) return pick("cloud", models.cloud, "prefer-local+high", score, tags);
            return pick("local-text", models.localText ?? models.local, "prefer-local+high-no-key", score, tags);
        }
        // prefer-cloud or default
        if (cloudAvailable) return pick("cloud", models.cloud, "complex+cloud", score, tags);
        return pick("local-text", models.localText ?? models.local, "complex+no-key", score, tags);
    }

    // --- Simple task — decide between local (tool-calling) and local-text ---
    const isToolLike = tags.some(t =>
        t === "file-read" || t === "directory" || t === "command" ||
        t === "tool-heavy-ctx" || t === "post-tool" || t === "confirmation"
    );

    if (isToolLike) {
        return pick("local", models.local, "tool-prefer-local", score, tags);
    }

    if (pref === "prefer-cloud" && cloudAvailable) {
        return pick("cloud", models.cloud, "simple+prefer-cloud", score, tags);
    }

    // For text-only questions, use local-text model if available (since local
    // model is a tool-calling specialist and bad at general text)
    if (models.localText) {
        return pick("local-text", models.localText, "simple+text", score, tags);
    }
    return pick("local", models.local, "simple+local", score, tags);
}

function pick(target, model, reason, score, tags) {
    return { target, model, reason, score, tags };
}

// ============================================================================
// TOOL SIMPLIFICATION (for local 270M models)
// ============================================================================

/**
 * Simplified tool schemas for FunctionGemma and similar tiny models.
 * The real OpenClaw tools have 10-12 parameters with complex descriptions
 * (exec alone is 1037 chars). A 270M model can't parse that — it gets
 * confused and refuses to call tools.
 *
 * These simplified schemas use only the essential parameters. When the
 * model generates a tool call with e.g. { name: "exec", arguments: { command: "ls" } },
 * OpenClaw matches by tool name and passes the args to the real implementation.
 */
const SIMPLIFIED_TOOL_SCHEMAS = {
    read: {
        name: "read",
        description: "Read a file.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path to read" },
            },
            required: ["path"],
        },
    },
    exec: {
        name: "exec",
        description: "Run a shell command (ls, cat, git, date, echo, etc.).",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "Shell command to run" },
            },
            required: ["command"],
        },
    },
    write: {
        name: "write",
        description: "Write content to a file.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path" },
                content: { type: "string", description: "File content" },
            },
            required: ["path", "content"],
        },
    },
    edit: {
        name: "edit",
        description: "Edit a file by replacing text.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path" },
                oldText: { type: "string", description: "Text to find" },
                newText: { type: "string", description: "Replacement text" },
            },
            required: ["path", "oldText", "newText"],
        },
    },
};

/**
 * Replace full OpenClaw tool definitions with simplified schemas.
 * Keeps the same tool names so OpenClaw's tool-call dispatch still works.
 * Only includes tools that a tiny model can realistically use.
 */
function simplifyToolsForLocalModel(tools) {
    const simplified = [];
    const seen = new Set();
    for (const tool of tools) {
        const name = tool?.name ?? tool?.function?.name ?? "";
        if (SIMPLIFIED_TOOL_SCHEMAS[name] && !seen.has(name)) {
            // Clone the real tool object and replace only the schema-related fields
            // so that the tool's execute() function is preserved
            const schema = SIMPLIFIED_TOOL_SCHEMAS[name];
            simplified.push({
                ...tool,
                description: schema.description,
                parameters: schema.parameters,
                inputSchema: schema.parameters,
            });
            seen.add(name);
        }
    }
    return simplified;
}

// ============================================================================
// STREAM-FN WRAPPER (main entry point)
// ============================================================================

/**
 * Create the hybrid router wrapper.
 *
 * @param {object} params
 * @param {object} params.cfg      - Full OpenClaw config
 * @param {string} [params.agentDir]
 * @param {string} [params.provider]  - Primary provider id
 * @param {string} [params.modelId]   - Primary model id
 * @returns {{ wrapStreamFn: (fn) => fn } | null}
 */
export function createHybridRouterWrapper(params) {
    const routerCfg = resolveHybridRouterConfig(params.cfg);
    if (!routerCfg) {
        logDebug("disabled or not configured");
        return null;
    }

    const agentDir = params.agentDir ?? resolveOpenClawAgentDir();

    // Build identity-aware system prompts from workspace files
    const workspaceDir = params.cfg?.agents?.defaults?.workspace ?? null;
    const identityPreamble = buildIdentityPreamble(workspaceDir);
    LOCAL_TOOL_SYSTEM_PROMPT = identityPreamble + " " + BASE_TOOL_PROMPT;
    LOCAL_TEXT_SYSTEM_PROMPT = identityPreamble + " " + BASE_TEXT_PROMPT;
    logInfo("identity preamble:", identityPreamble.substring(0, 100) + "...");

    // Resolve all model objects once at creation time
    const models = {
        local:     resolveModelRef(routerCfg.localModel,     params.cfg, agentDir),
        localText: resolveModelRef(routerCfg.localTextModel, params.cfg, agentDir),
        cloud:     resolveModelRef(routerCfg.cloudModel,     params.cfg, agentDir),
    };

    logInfo("enabled", {
        preference: routerCfg.preference,
        local:     models.local     ? `${models.local.provider}/${models.local.id}`     : "MISSING",
        localText: models.localText ? `${models.localText.provider}/${models.localText.id}` : "none",
        cloud:     models.cloud     ? `${models.cloud.provider}/${models.cloud.id}`     : "none",
        cloudKey:  hasCloudApiKey(routerCfg.cloudModel, params.cfg, agentDir) ? "present" : "missing",
    });

    if (!models.local) {
        logWarn("local model could not be resolved — router disabled");
        return null;
    }

    // Cache resolved API keys so we only resolve once per provider per session
    const resolvedProviderKeys = new Map(); // provider → apiKey

    const wrapStreamFn = (streamFn) => {
        const wrapped = async (model, context, options) => {
            const decision = makeRoutingDecision(context, routerCfg, models, params.cfg, agentDir);

            const effectiveModel = decision.model ?? model;

            logInfo(
                `→ ${decision.target}`,
                `model=${effectiveModel.provider}/${effectiveModel.id}`,
                `score=${decision.score.toFixed(2)}`,
                `reason=${decision.reason}`,
                decision.tags.length ? `tags=[${decision.tags.join(",")}]` : "",
            );

            // When switching to a different provider, resolve the API key
            let effectiveOptions = options;
            if (effectiveModel.provider !== model.provider) {
                let apiKey = resolvedProviderKeys.get(effectiveModel.provider);

                if (!apiKey) {
                    try {
                        const apiKeyInfo = await resolveApiKeyForProvider({
                            provider: effectiveModel.provider,
                            cfg: params.cfg,
                            agentDir,
                        });
                        if (apiKeyInfo?.apiKey) {
                            apiKey = apiKeyInfo.apiKey;
                            resolvedProviderKeys.set(effectiveModel.provider, apiKey);
                            // Also set in authStorage so other parts of the system can find it
                            if (params.authStorage) {
                                params.authStorage.setRuntimeApiKey(effectiveModel.provider, apiKey);
                            }
                            logInfo(`auth: resolved API key for ${effectiveModel.provider} (${apiKeyInfo.source})`);
                        } else {
                            logWarn(`auth: no API key resolved for ${effectiveModel.provider}`);
                        }
                    } catch (err) {
                        logWarn(`auth: failed to resolve API key for ${effectiveModel.provider}: ${err?.message}`);
                    }
                }

                // Override the apiKey in options so streamSimple uses the correct key
                if (apiKey) {
                    effectiveOptions = { ...options, apiKey };
                }
            }

            // Adapt context based on target model capabilities:
            //
            // cloud:      Full context — the cloud model handles the full system
            //             prompt, all tools, and workspace files perfectly.
            //
            // local:      Minimal system prompt + filtered tools — FunctionGemma 270M
            //             is a tool-calling specialist but can only handle a few tools.
            //             23 tools with complex schemas overwhelm a 270M model.
            //             We keep only the core tools: read, exec, edit, write, process.
            //
            // local-text: Minimal system prompt + strip tools — Gemma 3 270M is for
            //             text generation; it doesn't support tool calling at all.
            //
            let effectiveContext = context;
            if (decision.target === "local-text") {
                effectiveContext = {
                    ...context,
                    tools: [],
                    systemPrompt: LOCAL_TEXT_SYSTEM_PROMPT,
                };
                logDebug("adapted context for local-text (no tools, identity prompt)");
            } else if (decision.target === "local") {
                // Replace full OpenClaw tools with simplified schemas that a 270M
                // model can handle. The real tools have 10+ params with complex
                // descriptions — FunctionGemma gets confused and refuses to act.
                // We pass simplified wrappers that still call the real tool
                // implementations (OpenClaw matches tool calls by name).
                const simplifiedTools = simplifyToolsForLocalModel(context.tools ?? []);
                effectiveContext = {
                    ...context,
                    tools: simplifiedTools,
                    systemPrompt: LOCAL_TOOL_SYSTEM_PROMPT,
                };
                logDebug(`adapted context for local (minimal prompt, ${simplifiedTools.length}/${(context.tools ?? []).length} tools, simplified schemas)`);
            }
            // cloud: context is passed through unchanged (full system prompt + all tools)

            return streamFn(effectiveModel, effectiveContext, effectiveOptions);
        };
        return wrapped;
    };

    return { wrapStreamFn };
}
