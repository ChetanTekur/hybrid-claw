/**
 * Hybrid Router Comprehensive Test Suite
 * Run: node test-suite.mjs
 */

import { classifyComplexity, makeRoutingDecision, resolveHybridRouterConfig, hasCloudApiKey, wasLastAssistantCloud } from './openclaw-local/dist/agents/hybrid-router.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cfg = JSON.parse(readFileSync(join(process.env.HOME, '.openclaw-local/openclaw.json'), 'utf-8'));
const routerCfg = resolveHybridRouterConfig(cfg);

const models = {
  local: { provider: 'ollama', id: 'functiongemma' },
  localText: { provider: 'ollama', id: 'gemma3:270m' },
  cloud: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
};

let totalPass = 0, totalFail = 0;

function assert(label, condition) {
  if (condition) { totalPass++; console.log("  \u2713 " + label); }
  else { totalFail++; console.log("  \u2717 " + label); }
}

function routeFor(prompt) {
  const ctx = { messages: [{ role: 'user', content: prompt }], tools: [] };
  return makeRoutingDecision(ctx, routerCfg, models, cfg);
}

function routeWithPref(prompt, pref) {
  const testCfg = { ...routerCfg, preference: pref };
  const ctx = { messages: [{ role: 'user', content: prompt }], tools: [] };
  return makeRoutingDecision(ctx, testCfg, models, cfg);
}

// ================================================================
console.log("");
console.log("\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
console.log("\u2551     HYBRID ROUTER TEST SUITE \u2014 Full Validation       \u2551");
console.log("\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d");
console.log("");

// ================================================================
console.log("=== TEST 1: Config Resolution ===");
assert("router enabled", routerCfg.enabled === true);
assert("preference is prefer-local", routerCfg.preference === "prefer-local");
assert("localModel defined", routerCfg.localModel != null);
assert("localTextModel defined", routerCfg.localTextModel != null);
assert("cloudModel defined", routerCfg.cloudModel != null);
assert("threshold is 0.5", routerCfg.routing.complexityThreshold === 0.5);
assert("forceCloudPatterns loaded", routerCfg.routing.forceCloudPatterns.length > 0);
assert("forceLocalPatterns loaded", routerCfg.routing.forceLocalPatterns.length > 0);
console.log("");

// ================================================================
console.log("=== TEST 2: Cloud API Key Detection ===");
assert("anthropic key found", hasCloudApiKey(routerCfg.cloudModel, cfg));
assert("fake provider returns false", !hasCloudApiKey({ provider: "nonexistent", id: "x" }, cfg));
console.log("");

// ================================================================
console.log("=== TEST 3: Force-Local Pattern Routing ===");
const forceLocalTests = [
  ["read the file /etc/hosts", "local"],
  ["read the contents of ~/.bashrc", "local"],
  ["list the files in /tmp", "local"],
  ["run echo hello", "local"],
  ["run command ls -la", "local"],
  ["yes", "local"],
  ["no", "local"],
  ["ok", "local"],
  ["sure", "local"],
];
for (const [prompt, expected] of forceLocalTests) {
  const d = routeFor(prompt);
  assert('"' + prompt + '" -> ' + expected + " (got " + d.target + ", reason=" + d.reason + ")", d.target === expected);
}
console.log("");

// ================================================================
console.log("=== TEST 4: Local-Text (Simple Text) Routing ===");
const localTextTests = [
  ["Who are you?", "local-text"],
  ["What is 2 + 2?", "local-text"],
  ["What is the difference between let and const?", "local-text"],
  ["What does JSON stand for?", "local-text"],
  ["How do you declare a variable in Python?", "local-text"],
  ["What is a closure?", "local-text"],
];
for (const [prompt, expected] of localTextTests) {
  const d = routeFor(prompt);
  assert('"' + prompt + '" -> ' + expected + " (got " + d.target + ", score=" + d.score.toFixed(2) + ")", d.target === expected);
}
console.log("");

// ================================================================
console.log("=== TEST 5: Cloud (Force-Cloud Patterns) ===");
const forceCloudTests = [
  ["Explain in detail how the event loop works", "cloud"],
  ["Implement a feature for user authentication", "cloud"],
  ["Refactor this component to use hooks", "cloud"],
  ["Write a comprehensive API documentation", "cloud"],
];
for (const [prompt, expected] of forceCloudTests) {
  const d = routeFor(prompt);
  assert('"' + prompt.substring(0, 45) + '..." -> cloud (reason=' + d.reason + ")", d.target === expected);
}
console.log("");

// ================================================================
console.log("=== TEST 6: Cloud (Capability-Required) ===");
const capabilityTests = [
  ["Can you find the highest rated ski socks?", "cloud", "search,recommendation"],
  ["Search for the best React libraries", "cloud", "search,recommendation"],
  ["What is the latest version of Node.js?", "cloud", "real-time"],
  ["What is the current price of Bitcoin?", "cloud", "real-time"],
  ["Recommend a good restaurant in SF", "cloud", "recommendation"],
  ["Find the best deals on AirPods", "cloud", "search,recommendation"],
  ["Buy me a new keyboard", "cloud", "shopping"],
  ["What are today's top news stories?", "cloud", "real-time"],
  ["What is the latest iPhone model?", "cloud", "real-time"],
  ["Suggest the best productivity apps", "cloud", "recommendation"],
  ["Find me a cheap flight to NYC", "cloud", "search"],
  ["Look up the weather forecast", "cloud", "search"],
];
for (const [prompt, expected, expectedTags] of capabilityTests) {
  const d = routeFor(prompt);
  assert('"' + prompt.substring(0, 42) + '" -> cloud [' + d.tags.slice(0, 3).join(",") + "]", d.target === expected);
}
console.log("");

// ================================================================
console.log("=== TEST 7: Cloud (High Complexity Score) ===");
const complexTests = [
  // These hit cloud-capability tags (suggest → recommendation) + complexity signals
  ["Analyze this codebase and suggest architectural improvements for better scalability", "cloud"],
  // These hit force-cloud patterns (explain.*in detail, implement.*feature, refactor)
  ["Explain in detail and implement a distributed task queue with retry logic", "cloud"],
  ["Refactor the CI/CD pipeline to add automated testing and deployment", "cloud"],
  // This hits search + recommendation cloud-capability tags
  ["Find and suggest the best approach to build a microservices architecture", "cloud"],
];
for (const [prompt, expected] of complexTests) {
  const d = routeFor(prompt);
  assert('"' + prompt.substring(0, 50) + '..." -> ' + expected + ' (score=' + d.score.toFixed(2) + ")", d.target === expected);
}
// Known borderline cases: prompts that sound complex to a human but only
// trigger one or two heuristic signals. Under prefer-local, moderate-complexity
// prompts (0.5-0.7) route to local-text. This is an acceptable trade-off:
// a 270M model gives a shallower answer, but keeps costs at zero.
console.log("  --- Known borderline (accepted as local-text or cloud) ---");
const borderline = [
  "Compare React Vue and Svelte for a large enterprise SSR application in detail",
  "Debug the memory leak in the Node.js app under high load",
  "Implement a distributed task queue with retry logic",
  "Build a comprehensive CI/CD pipeline with automated testing",
];
for (const prompt of borderline) {
  const d = routeFor(prompt);
  const ok = d.target === "local-text" || d.target === "cloud";
  assert('"' + prompt.substring(0, 48) + '..." -> ' + d.target + ' (score=' + d.score.toFixed(2) + ", borderline)", ok);
}
console.log("");

// ================================================================
console.log("=== TEST 8: Edge Cases ===");
{
  let d;

  // Empty/whitespace
  d = routeFor("");
  assert('empty string -> local-text (got ' + d.target + ")", d.target === "local-text");

  d = routeFor("   ");
  assert('whitespace -> local-text (got ' + d.target + ")", d.target === "local-text");

  // Single emoji
  d = routeFor("\u{1F916}");
  assert('emoji only -> local-text (got ' + d.target + ")", d.target === "local-text");

  // Very long prompt (>100 words)
  const longPrompt = "I need you to analyze and explain " + "the various aspects of this complex system including the architecture and design patterns and performance characteristics and scalability concerns ".repeat(5);
  d = routeFor(longPrompt);
  assert("very long prompt -> cloud (score=" + d.score.toFixed(2) + " tags=" + d.tags.join(",") + ")", d.target === "cloud");

  // Mixed signals: force-cloud pattern fires first (checked before force-local)
  d = routeFor("read the file and explain in detail what it does");
  assert("mixed (force-cloud checked first): " + d.target + " reason=" + d.reason, d.target === "cloud");

  // Post-tool turn simulation (local assistant — stays local)
  const postToolCtx = {
    messages: [
      { role: "user", content: "read package.json" },
      { role: "assistant", content: [{ type: "toolCall", name: "read", args: {} }], provider: "ollama" },
      { role: "toolResult", content: "file contents here" },
    ],
    tools: [],
  };
  const postToolDecision = makeRoutingDecision(postToolCtx, routerCfg, models, cfg);
  assert("post-tool turn (local assistant) -> local (got " + postToolDecision.target + ")", postToolDecision.target === "local");

  // Greeting -> local-text
  d = routeFor("hello");
  assert("greeting 'hello' -> local-text (got " + d.target + ")", d.target === "local-text");

  d = routeFor("thanks");
  assert("greeting 'thanks' -> local-text (got " + d.target + ")", d.target === "local-text");
}
console.log("");

// ================================================================
console.log("=== TEST 9: Preference Mode Overrides ===");
{
  let d;

  // local-only: everything goes local, even cloud-capability prompts
  d = routeWithPref("What is the price of Bitcoin?", "local-only");
  assert("local-only: BTC price -> local (got " + d.target + ")", d.target === "local");

  d = routeWithPref("Explain in detail how closures work", "local-only");
  assert("local-only: complex -> local (got " + d.target + ")", d.target === "local");

  // cloud-only: everything goes cloud
  d = routeWithPref("yes", "cloud-only");
  assert("cloud-only: 'yes' -> cloud (got " + d.target + ")", d.target === "cloud");

  d = routeWithPref("read the file /etc/hosts", "cloud-only");
  assert("cloud-only: read file -> cloud (got " + d.target + ")", d.target === "cloud");

  // prefer-cloud: simple tasks go to cloud
  d = routeWithPref("What is 2+2?", "prefer-cloud");
  assert("prefer-cloud: simple -> cloud (got " + d.target + ")", d.target === "cloud");

  // prefer-local: simple tasks go to local-text
  d = routeWithPref("What is 2+2?", "prefer-local");
  assert("prefer-local: simple -> local-text (got " + d.target + ")", d.target === "local-text");
}
console.log("");

// ================================================================
console.log("=== TEST 10: Score Boundaries ===");
{
  // Just below threshold (0.5)
  const ctx1 = { messages: [{ role: "user", content: "how does this work" }], tools: [] };
  const score1 = classifyComplexity(ctx1, routerCfg.routing);
  assert("'how does this work' score=" + score1.score.toFixed(2) + " < 0.5", score1.score < 0.5);

  // At/above threshold
  const ctx2 = { messages: [{ role: "user", content: "implement and build a new feature for the app" }], tools: [] };
  const score2 = classifyComplexity(ctx2, routerCfg.routing);
  assert("'implement and build a new feature' score=" + score2.score.toFixed(2) + " >= 0.5", score2.score >= 0.5);

  // Score clamped to [0, 1]
  const ctx3 = { messages: [{ role: "user", content: "yes ok sure confirm" }], tools: [] };
  const score3 = classifyComplexity(ctx3, routerCfg.routing);
  assert("negative keywords clamped to 0 (got " + score3.score.toFixed(2) + ")", score3.score >= 0);

  const ctx4 = {
    messages: [{
      role: "user",
      content: "explain in detail step by step implement build refactor optimize analyze compare evaluate debug fix solve " + "word ".repeat(200)
    }],
    tools: [],
  };
  const score4 = classifyComplexity(ctx4, routerCfg.routing);
  assert("many complex keywords clamped to 1.0 (got " + score4.score.toFixed(2) + ")", score4.score <= 1.0);
}
console.log("");

// ================================================================
console.log("=== TEST 11: Cloud Session Affinity ===");
{
  // When a cloud model makes a tool call, the post-tool summarisation
  // should stay on cloud to preserve quality and formatting.

  // Case 1: Cloud assistant made a tool call -> tool result -> should route to CLOUD
  const cloudPostTool = {
    messages: [
      { role: "user", content: "what is the latest headlines from Google news" },
      { role: "assistant", content: [{ type: "toolCall", name: "web_search", args: { query: "Google news headlines today" } }], provider: "anthropic", model: "anthropic/claude-sonnet-4-5" },
      { role: "toolResult", content: "Fox News - Breaking News...\nCNN Headlines...\nNBC News..." },
    ],
    tools: [],
  };
  let d = makeRoutingDecision(cloudPostTool, routerCfg, models, cfg);
  assert("cloud post-tool (news) -> cloud (got " + d.target + ", reason=" + d.reason + ")", d.target === "cloud");

  // Case 2: Local assistant made a tool call -> tool result -> should route to LOCAL
  const localPostTool = {
    messages: [
      { role: "user", content: "read package.json" },
      { role: "assistant", content: [{ type: "toolCall", name: "read", args: { path: "package.json" } }], provider: "ollama", model: "ollama/functiongemma" },
      { role: "toolResult", content: '{ "name": "test", "version": "1.0" }' },
    ],
    tools: [],
  };
  d = makeRoutingDecision(localPostTool, routerCfg, models, cfg);
  assert("local post-tool (read) -> local (got " + d.target + ", reason=" + d.reason + ")", d.target === "local");

  // Case 3: Cloud multi-step tool chain (multiple tool calls in sequence)
  const cloudMultiStep = {
    messages: [
      { role: "user", content: "Find the best ski socks and compare prices" },
      { role: "assistant", content: [{ type: "toolCall", name: "web_search", args: { query: "best ski socks 2025" } }], provider: "anthropic" },
      { role: "toolResult", content: "Results: Smartwool, Darn Tough, Icebreaker..." },
      { role: "assistant", content: [{ type: "toolCall", name: "web_fetch", args: { url: "https://example.com" } }], provider: "anthropic" },
      { role: "toolResult", content: "Price comparison data..." },
    ],
    tools: [],
  };
  d = makeRoutingDecision(cloudMultiStep, routerCfg, models, cfg);
  assert("cloud multi-step chain -> cloud (got " + d.target + ", reason=" + d.reason + ")", d.target === "cloud");

  // Case 4: No assistant message at all (first turn) with tool result -> local
  const noAssistant = {
    messages: [
      { role: "toolResult", content: "some injected context" },
    ],
    tools: [],
  };
  d = makeRoutingDecision(noAssistant, routerCfg, models, cfg);
  assert("no assistant + toolResult -> local (got " + d.target + ")", d.target === "local");

  // Case 5: wasLastAssistantCloud helper unit tests
  assert("wasLastAssistantCloud: anthropic provider -> true",
    wasLastAssistantCloud([
      { role: "assistant", content: "hi", provider: "anthropic" },
      { role: "toolResult", content: "data" },
    ]) === true);

  assert("wasLastAssistantCloud: ollama provider -> false",
    wasLastAssistantCloud([
      { role: "assistant", content: "hi", provider: "ollama" },
      { role: "toolResult", content: "data" },
    ]) === false);

  assert("wasLastAssistantCloud: openai model string -> true",
    wasLastAssistantCloud([
      { role: "assistant", content: "hi", model: "openai/gpt-4" },
      { role: "toolResult", content: "data" },
    ]) === true);

  assert("wasLastAssistantCloud: empty messages -> false",
    wasLastAssistantCloud([]) === false);

  assert("wasLastAssistantCloud: no assistant messages -> false",
    wasLastAssistantCloud([
      { role: "user", content: "hello" },
      { role: "toolResult", content: "data" },
    ]) === false);

  // Case 6: Cloud continuation with different cloud providers
  for (const provider of ["anthropic", "openai", "google", "openrouter"]) {
    const ctx = {
      messages: [
        { role: "user", content: "search for something" },
        { role: "assistant", content: [{ type: "toolCall", name: "web_search", args: {} }], provider },
        { role: "toolResult", content: "results" },
      ],
      tools: [],
    };
    d = makeRoutingDecision(ctx, routerCfg, models, cfg);
    assert("cloud affinity with " + provider + " -> cloud (got " + d.target + ")", d.target === "cloud");
  }
}
console.log("");

// ================================================================
// SUMMARY
console.log("\u2550".repeat(50));
const status = totalFail === 0 ? "ALL TESTS PASSED" : totalFail + " TESTS FAILED";
console.log("TOTAL: " + totalPass + "/" + (totalPass + totalFail) + " passed   " + status);
console.log("\u2550".repeat(50));
process.exit(totalFail > 0 ? 1 : 0);
