#!/usr/bin/env node
// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  Hybrid Claw — Routing Benchmark (15 scenarios)                      ║
// ║                                                                       ║
// ║  Tests a mix of local-eligible and cloud-required prompts through     ║
// ║  the router's classifyComplexity + makeRoutingDecision pipeline       ║
// ║  using the REAL config from ~/.openclaw-local/openclaw.json.          ║
// ╚═══════════════════════════════════════════════════════════════════════╝

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    classifyComplexity,
    makeRoutingDecision,
    resolveHybridRouterConfig,
    wasLastAssistantCloud,
} from "./openclaw-local/dist/agents/hybrid-router.js";

// ── Load REAL config ─────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".openclaw-local", "openclaw.json");
let realCfg;
try {
    realCfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch (err) {
    console.error(`ERROR: cannot read ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
}

const routerCfg = resolveHybridRouterConfig(realCfg);
if (!routerCfg) {
    console.error("ERROR: hybridRouter is not enabled in config");
    process.exit(1);
}

// ── Print actual config being used ───────────────────────────────────────

const COL = {
    reset: "\x1b[0m",
    dim:   "\x1b[2m",
    bold:  "\x1b[1m",
    green: "\x1b[32m",
    red:   "\x1b[31m",
    cyan:  "\x1b[36m",
    yellow:"\x1b[33m",
    magenta:"\x1b[35m",
};

console.log("");
console.log("╔═══════════════════════════════════════════════════════════════════════╗");
console.log("║         Hybrid Claw — Routing Benchmark (15 Scenarios)               ║");
console.log("╚═══════════════════════════════════════════════════════════════════════╝");
console.log("");
console.log(`${COL.bold}CONFIGURATION (from ~/.openclaw-local/openclaw.json)${COL.reset}`);
console.log(`  Preference:          ${COL.magenta}${routerCfg.preference}${COL.reset}`);
console.log(`  Complexity threshold: ${routerCfg.routing.complexityThreshold}`);
console.log(`  Local model:         ${COL.yellow}${routerCfg.localModel.provider}/${routerCfg.localModel.id}${COL.reset} (tool-calling)`);
console.log(`  Local text model:    ${COL.yellow}${routerCfg.localTextModel?.provider ?? "none"}/${routerCfg.localTextModel?.id ?? "none"}${COL.reset} (text generation)`);
console.log(`  Cloud model:         ${COL.cyan}${routerCfg.cloudModel?.provider ?? "none"}/${routerCfg.cloudModel?.id ?? "none"}${COL.reset}`);
console.log(`  Force-cloud patterns: ${routerCfg.routing.forceCloudPatterns.map(r => r?.source).filter(Boolean).join(", ") || "(none)"}`);
console.log(`  Force-local patterns: ${routerCfg.routing.forceLocalPatterns.map(r => r?.source).filter(Boolean).join(", ") || "(none)"}`);
console.log("");

// ── Build model objects (matching what createHybridRouterWrapper resolves) ──

// We use minimal model stubs — makeRoutingDecision only needs provider/id
const MODELS = {
    local:     { provider: routerCfg.localModel.provider,     id: routerCfg.localModel.id },
    localText: routerCfg.localTextModel
        ? { provider: routerCfg.localTextModel.provider, id: routerCfg.localTextModel.id }
        : null,
    cloud: routerCfg.cloudModel
        ? { provider: routerCfg.cloudModel.provider, id: routerCfg.cloudModel.id }
        : null,
};

// Fake auth so hasCloudApiKey returns true (we want to test routing logic, not auth)
const AUTH_CFG = {
    ...realCfg,
    auth: {
        ...(realCfg.auth || {}),
        profiles: {
            ...(realCfg.auth?.profiles || {}),
            [`${routerCfg.cloudModel?.provider ?? "anthropic"}-benchmark`]: {
                apiKey: "sk-fake-for-routing-benchmark",
                mode: "token",
            },
        },
    },
};
const FAKE_AGENT_DIR = "/tmp/nonexistent-agent-dir";

// ── Helpers ──────────────────────────────────────────────────────────────

function buildContext(userText, priorMessages = []) {
    return {
        messages: [
            ...priorMessages,
            { role: "user", content: userText },
        ],
    };
}

function makeDecision(context) {
    return makeRoutingDecision(context, routerCfg, MODELS, AUTH_CFG, FAKE_AGENT_DIR);
}

// ── 15 Test Scenarios ────────────────────────────────────────────────────

// Note on post-tool scenarios: OpenClaw calls streamFn multiple times per
// user query. In a post-tool turn, the context.messages array ends with a
// toolResult — the next user message hasn't been sent yet. The router's
// isPostToolTurn() checks messages[last].role === "toolResult".

const localModel = `${MODELS.local.provider}/${MODELS.local.id}`;
const cloudModel = `${MODELS.cloud.provider}/${MODELS.cloud.id}`;

const scenarios = [
    // ══════════════════════════════════════════════════════════════════════
    // LOCAL-ELIGIBLE — simple tasks a 270M model can handle
    // ══════════════════════════════════════════════════════════════════════
    {
        id: 1,
        name: "List directory contents",
        category: "local",
        prompt: "ls the src folder",
        prior: [],
        expectedTarget: "local",
    },
    {
        id: 2,
        name: "Read a source file",
        category: "local",
        prompt: "read the file src/index.ts",
        prior: [],
        expectedTarget: "local",
    },
    {
        id: 3,
        name: "Confirm previous action",
        category: "local",
        prompt: "yes",
        prior: [],
        expectedTarget: "local",
    },
    {
        id: 4,
        name: "Run test suite",
        category: "local",
        prompt: "run npm test",
        prior: [],
        expectedTarget: "local",
    },
    {
        id: 5,
        name: "Execute a build command",
        category: "local",
        prompt: "exec npm run build",
        prior: [],
        expectedTarget: "local",
    },
    {
        id: 6,
        name: "Display file content",
        category: "local",
        prompt: "print the file .env.example",
        prior: [],
        expectedTarget: "local",
    },
    {
        id: 7,
        name: "Local post-tool: file read result",
        category: "local",
        prompt: "",   // unused — context is built from prior
        prior: [
            { role: "user", content: "read package.json" },
            { role: "assistant", content: "I'll read package.json for you.", provider: "ollama", model: "functiongemma:latest" },
            { role: "toolResult", content: JSON.stringify({ content: '{ "name": "my-app" }' }) },
        ],
        expectedTarget: "local",
        postTool: true,
    },
    {
        id: 8,
        name: "Acknowledge completion",
        category: "local",
        prompt: "ok",
        prior: [],
        expectedTarget: "local",
    },

    // ══════════════════════════════════════════════════════════════════════
    // CLOUD-REQUIRED — complex tasks needing full model capabilities
    // ══════════════════════════════════════════════════════════════════════
    {
        id: 9,
        name: "Web search for news",
        category: "cloud",
        prompt: "what are the latest headlines from Google News today?",
        prior: [],
        expectedTarget: "cloud",
    },
    {
        id: 10,
        name: "Product recommendation",
        category: "cloud",
        prompt: "recommend the best noise-cancelling headphones under $300",
        prior: [],
        expectedTarget: "cloud",
    },
    {
        id: 11,
        name: "Detailed code refactoring",
        category: "cloud",
        prompt: "refactor this function to use async/await and optimize the error handling step by step",
        prior: [],
        expectedTarget: "cloud",
    },
    {
        id: 12,
        name: "Framework comparison (in detail)",
        category: "cloud",
        prompt: "explain in detail how React, Vue, and Svelte compare for building a dashboard application",
        prior: [],
        expectedTarget: "cloud",
    },
    {
        id: 13,
        name: "Real-time price lookup",
        category: "cloud",
        prompt: "what is the current price of Bitcoin?",
        prior: [],
        expectedTarget: "cloud",
    },
    {
        id: 14,
        name: "Shopping research",
        category: "cloud",
        prompt: "find me the best deals on a 4K monitor for programming",
        prior: [],
        expectedTarget: "cloud",
    },
    {
        id: 15,
        name: "Cloud post-tool: synthesize search results",
        category: "cloud",
        prompt: "",   // unused for post-tool
        prior: [
            { role: "user", content: "what are the latest tech news?" },
            { role: "assistant", content: "I'll search for the latest tech news.", provider: "anthropic", model: "claude-sonnet-4-5" },
            { role: "toolResult", content: JSON.stringify({ results: ["Apple announces new M4 chip", "OpenAI releases GPT-5"] }) },
        ],
        expectedTarget: "cloud",
        postTool: true,
    },
];

// ── Run all scenarios ────────────────────────────────────────────────────

// Suppress router console output during benchmark
const origLog = console.log;
const origWarn = console.warn;

const results = [];

for (const scenario of scenarios) {
    // Suppress [hybrid-router] logs
    console.log = (...args) => {
        if (args[0] === "[hybrid-router]") return;
        origLog(...args);
    };
    console.warn = (...args) => {
        if (args[0] === "[hybrid-router]") return;
        origWarn(...args);
    };

    // Post-tool scenarios: context is just the prior messages (last = toolResult)
    // Normal scenarios: prior messages + user message at end
    const context = scenario.postTool
        ? { messages: [...scenario.prior] }
        : buildContext(scenario.prompt, scenario.prior);
    const decision = makeDecision(context);

    // Restore logging
    console.log = origLog;
    console.warn = origWarn;

    const routed = decision.target;
    const match = (routed === scenario.expectedTarget) ||
        (scenario.expectedTarget === "local" && (routed === "local" || routed === "local-text"));

    results.push({
        ...scenario,
        actualTarget: routed,
        model: `${decision.model.provider}/${decision.model.id}`,
        score: decision.score,
        reason: decision.reason,
        tags: decision.tags,
        match,
    });
}

// ── Print results table ──────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

console.log(`${COL.bold}${"#".padStart(2)}  ${pad("Scenario", 42)} ${pad("Expected", 10)} ${pad("Actual", 12)} ${rpad("Score", 5)}  ${pad("Reason", 28)} Tags${COL.reset}`);
console.log("─".repeat(130));

for (const r of results) {
    const icon = r.match ? `${COL.green}✓${COL.reset}` : `${COL.red}✗${COL.reset}`;
    const targetColor = r.actualTarget.startsWith("cloud") ? COL.cyan : COL.yellow;
    console.log(
        `${icon} ${rpad(r.id, 2)}  ${pad(r.name, 42)} ${pad(r.expectedTarget, 10)} ${targetColor}${pad(r.actualTarget, 12)}${COL.reset} ${rpad(r.score.toFixed(2), 5)}  ${pad(r.reason, 28)} ${COL.dim}${r.tags.join(", ")}${COL.reset}`
    );
}

// ── Summary statistics ───────────────────────────────────────────────────

console.log("");
console.log("═".repeat(130));
console.log("");

const localRouted = results.filter(r => r.actualTarget === "local" || r.actualTarget === "local-text");
const cloudRouted = results.filter(r => r.actualTarget === "cloud");
const correct = results.filter(r => r.match);

const totalInferences = results.length;
const localCount = localRouted.length;
const cloudCount = cloudRouted.length;
const savingsPercent = ((localCount / totalInferences) * 100).toFixed(1);

console.log(`${COL.bold}ROUTING SUMMARY${COL.reset}`);
console.log(`  Total scenarios:     ${totalInferences}`);
console.log(`  Routed to local:     ${COL.yellow}${localCount}${COL.reset}  (${savingsPercent}% of inferences served locally)`);
console.log(`  Routed to cloud:     ${COL.cyan}${cloudCount}${COL.reset}  (${(100 - parseFloat(savingsPercent)).toFixed(1)}% cloud)`);
console.log(`  Routing accuracy:    ${correct.length}/${totalInferences} matched expected target`);
console.log("");

console.log(`${COL.bold}CLOUD SAVINGS${COL.reset}`);
console.log(`  If all 15 queries went to cloud: 15 cloud API calls`);
console.log(`  With Hybrid Claw routing:        ${cloudCount} cloud API calls`);
console.log(`  ${COL.green}${COL.bold}Cloud inferences avoided: ${localCount}${COL.reset} (${savingsPercent}% savings)`);
console.log("");

// ── Per-category breakdown ───────────────────────────────────────────────

const localCategoryLocal = results.filter(r => r.category === "local" && (r.actualTarget === "local" || r.actualTarget === "local-text"));
const localCategoryCloud = results.filter(r => r.category === "local" && r.actualTarget === "cloud");
const cloudCategoryCloud = results.filter(r => r.category === "cloud" && r.actualTarget === "cloud");
const cloudCategoryLocal = results.filter(r => r.category === "cloud" && (r.actualTarget === "local" || r.actualTarget === "local-text"));

const localTotal = results.filter(r => r.category === "local").length;
const cloudTotal = results.filter(r => r.category === "cloud").length;

console.log(`${COL.bold}CATEGORY BREAKDOWN${COL.reset}`);
console.log(`  Simple/local tasks (${localTotal} scenarios):`);
console.log(`    → Correctly served locally: ${localCategoryLocal.length}/${localTotal}`);
if (localCategoryCloud.length > 0) {
    console.log(`    → Unnecessarily sent to cloud: ${localCategoryCloud.length}/${localTotal}`);
}
console.log(`  Complex/cloud tasks (${cloudTotal} scenarios):`);
console.log(`    → Correctly sent to cloud:  ${cloudCategoryCloud.length}/${cloudTotal}`);
if (cloudCategoryLocal.length > 0) {
    console.log(`    → Incorrectly kept local:  ${cloudCategoryLocal.length}/${cloudTotal}`);
}
console.log("");

// ── Models used ──────────────────────────────────────────────────────────

console.log(`${COL.bold}MODELS USED${COL.reset}`);
const modelCounts = {};
for (const r of results) {
    modelCounts[r.model] = (modelCounts[r.model] || 0) + 1;
}
for (const [model, count] of Object.entries(modelCounts)) {
    const isCloud = model.startsWith("anthropic") || model.startsWith("openai") || model.startsWith("google");
    const color = isCloud ? COL.cyan : COL.yellow;
    console.log(`  ${color}${model}${COL.reset}: ${count} inference${count > 1 ? "s" : ""}`);
}
console.log("");

// ── Cost estimate ────────────────────────────────────────────────────────

// Rough estimates: Claude Sonnet ~$3/M input + $15/M output tokens
// Average agent turn: ~2K input, ~500 output tokens
const AVG_INPUT_TOKENS = 2000;
const AVG_OUTPUT_TOKENS = 500;
const SONNET_INPUT_COST = 3.0 / 1_000_000;   // $/token
const SONNET_OUTPUT_COST = 15.0 / 1_000_000;  // $/token
const costPerCall = (AVG_INPUT_TOKENS * SONNET_INPUT_COST) + (AVG_OUTPUT_TOKENS * SONNET_OUTPUT_COST);
const savedCost = localCount * costPerCall;
const totalCloudCost = totalInferences * costPerCall;

console.log(`${COL.bold}ESTIMATED COST IMPACT (per batch of 15 queries)${COL.reset}`);
console.log(`  All-cloud cost:    $${totalCloudCost.toFixed(4)}`);
console.log(`  Hybrid Claw cost:  $${(cloudCount * costPerCall).toFixed(4)}  (local inferences: ~$0)`);
console.log(`  ${COL.green}Saved per batch:     $${savedCost.toFixed(4)}${COL.reset}`);
console.log("");
console.log(`${COL.dim}  Note: At scale (1000 queries/day), with ~${savingsPercent}% local routing,`);
console.log(`  estimated daily savings: ~$${(1000 * (localCount / totalInferences) * costPerCall).toFixed(2)}${COL.reset}`);
console.log("");

// ── Detailed routing log (for blog) ──────────────────────────────────────

console.log(`${COL.bold}DETAILED ROUTING LOG${COL.reset}`);
console.log("");

for (const r of results) {
    const targetColor = r.actualTarget.startsWith("cloud") ? COL.cyan : COL.yellow;
    const icon = r.actualTarget.startsWith("cloud") ? "☁️ " : "🏠";
    console.log(`  ${icon} Scenario ${r.id}: "${r.name}"`);
    const promptDisplay = r.postTool ? "(post-tool turn — no user prompt)" : `"${r.prompt.length > 70 ? r.prompt.slice(0, 70) + "..." : r.prompt}"`;
    console.log(`     Prompt:  ${promptDisplay}`);
    console.log(`     Route:   ${targetColor}${r.actualTarget}${COL.reset} → ${r.model}`);
    console.log(`     Score:   ${r.score.toFixed(2)} | Reason: ${r.reason} | Tags: [${r.tags.join(", ")}]`);
    if (r.prior.length > 0) {
        console.log(`     Context: ${r.prior.length} prior messages (multi-turn)`);
    }
    console.log("");
}

// ── Exit code ────────────────────────────────────────────────────────────
const failures = results.filter(r => !r.match);
if (failures.length > 0) {
    console.log(`${COL.red}${COL.bold}MISMATCHES (${failures.length}):${COL.reset}`);
    for (const f of failures) {
        console.log(`  Scenario ${f.id} "${f.name}": expected ${f.expectedTarget}, got ${f.actualTarget} (reason: ${f.reason})`);
    }
    console.log("");
}

process.exit(failures.length > 0 ? 1 : 0);
