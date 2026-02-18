/**
 * Local Models Configuration Wizard
 *
 * Lets users configure which Ollama models to use for local function-calling
 * and local text generation in the hybrid router.
 *
 * Queries the Ollama API at http://127.0.0.1:11434/api/tags to discover
 * available models, then presents a selection UI.
 */

import { note } from "../terminal/note.js";
import { confirm, select, text } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

const OLLAMA_BASE = "http://127.0.0.1:11434";

/**
 * Fetch the list of locally available Ollama models.
 * Returns an array of { name, size, modifiedAt } or null on failure.
 */
async function fetchOllamaModels() {
    try {
        const resp = await fetch(`${OLLAMA_BASE}/api/tags`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return (data.models ?? []).map((m) => ({
            name: m.name,
            size: m.size,
            modifiedAt: m.modified_at,
            paramSize: m.details?.parameter_size ?? "",
            family: m.details?.family ?? "",
        }));
    } catch {
        return null;
    }
}

function formatSize(bytes) {
    if (!bytes) return "";
    const mb = bytes / (1024 * 1024);
    if (mb > 1024) return `${(mb / 1024).toFixed(1)}GB`;
    return `${mb.toFixed(0)}MB`;
}

/**
 * Prompt the user to configure local models for hybrid routing.
 *
 * @param {object} nextConfig - Current OpenClaw config (will be mutated and returned)
 * @param {object} runtime    - OpenClaw runtime
 * @returns {object} Updated config
 */
export async function promptLocalModelsConfig(nextConfig, runtime) {
    const hr = nextConfig.agents?.defaults?.hybridRouter ?? {};
    const currentFn = hr.localModel?.id ?? "functiongemma";
    const currentText = hr.localTextModel?.id ?? "none";

    note(
        [
            "Hybrid routing uses local Ollama models for fast, free responses",
            "and falls back to the cloud model for complex tasks.",
            "",
            `Current function-calling model: ${currentFn}`,
            `Current text model: ${currentText}`,
            "",
            "Requirements:",
            "  - Ollama must be running at http://127.0.0.1:11434",
            "  - Models must be pulled first (e.g. ollama pull functiongemma)",
        ].join("\n"),
        "Local models (hybrid routing)"
    );

    // Try to fetch available models from Ollama
    const models = await fetchOllamaModels();

    if (!models) {
        note(
            [
                "Could not reach Ollama at http://127.0.0.1:11434.",
                "Make sure Ollama is running: ollama serve",
                "",
                "You can still configure models manually by entering model names.",
            ].join("\n"),
            "Ollama not detected"
        );
    }

    // --- Enable/disable hybrid routing ---
    const enableHybrid = guardCancel(
        await confirm({
            message: "Enable hybrid local/cloud routing?",
            initialValue: hr.enabled ?? true,
        }),
        runtime
    );

    if (!enableHybrid) {
        return {
            ...nextConfig,
            agents: {
                ...nextConfig.agents,
                defaults: {
                    ...nextConfig.agents?.defaults,
                    hybridRouter: {
                        ...hr,
                        enabled: false,
                    },
                },
            },
        };
    }

    // --- Function-calling model ---
    let fnModelId;
    if (models && models.length > 0) {
        const fnOptions = models.map((m) => ({
            value: m.name,
            label: m.name,
            hint: [m.paramSize, formatSize(m.size), m.family].filter(Boolean).join(" · "),
        }));
        // Add "custom" option
        fnOptions.push({
            value: "__custom",
            label: "Enter manually",
            hint: "Type a model name not in the list",
        });

        // Set initial value to current model if it exists in list
        const initialFn = fnOptions.find((o) => o.value === currentFn)
            ? currentFn
            : fnOptions[0]?.value;

        fnModelId = guardCancel(
            await select({
                message: "Local function-calling model (for tool calls, file reads, commands)",
                options: fnOptions,
                initialValue: initialFn,
            }),
            runtime
        );

        if (fnModelId === "__custom") {
            fnModelId = String(
                guardCancel(
                    await text({
                        message: "Function-calling model name (as shown in ollama list)",
                        initialValue: currentFn,
                    }),
                    runtime
                ) ?? currentFn
            ).trim();
        }
    } else {
        fnModelId = String(
            guardCancel(
                await text({
                    message: "Function-calling model name (as shown in ollama list)",
                    initialValue: currentFn,
                }),
                runtime
            ) ?? currentFn
        ).trim();
    }

    // --- Text model ---
    const enableTextModel = guardCancel(
        await confirm({
            message: "Configure a separate local text model? (for non-tool text answers)",
            initialValue: Boolean(hr.localTextModel),
        }),
        runtime
    );

    let textModelId = null;
    if (enableTextModel) {
        if (models && models.length > 0) {
            const textOptions = models.map((m) => ({
                value: m.name,
                label: m.name,
                hint: [m.paramSize, formatSize(m.size), m.family].filter(Boolean).join(" · "),
            }));
            textOptions.push({
                value: "__custom",
                label: "Enter manually",
                hint: "Type a model name not in the list",
            });

            const initialText = textOptions.find((o) => o.value === currentText)
                ? currentText
                : textOptions[0]?.value;

            textModelId = guardCancel(
                await select({
                    message: "Local text model (for general text answers — no tool calling)",
                    options: textOptions,
                    initialValue: initialText,
                }),
                runtime
            );

            if (textModelId === "__custom") {
                textModelId = String(
                    guardCancel(
                        await text({
                            message: "Text model name (as shown in ollama list)",
                            initialValue: currentText !== "none" ? currentText : "",
                        }),
                        runtime
                    ) ?? ""
                ).trim();
            }
        } else {
            textModelId = String(
                guardCancel(
                    await text({
                        message: "Text model name (as shown in ollama list)",
                        initialValue: currentText !== "none" ? currentText : "",
                    }),
                    runtime
                ) ?? ""
            ).trim();
        }
    }

    // --- Routing preference ---
    const preference = guardCancel(
        await select({
            message: "Routing preference",
            options: [
                {
                    value: "prefer-local",
                    label: "Prefer local",
                    hint: "Use local models when possible, cloud for complex tasks (recommended)",
                },
                {
                    value: "prefer-cloud",
                    label: "Prefer cloud",
                    hint: "Use cloud when possible, local as fallback",
                },
                {
                    value: "local-only",
                    label: "Local only",
                    hint: "Never use cloud (fully offline)",
                },
                {
                    value: "cloud-only",
                    label: "Cloud only",
                    hint: "Always use cloud model",
                },
            ],
            initialValue: hr.preference ?? "prefer-local",
        }),
        runtime
    );

    // --- Ensure the models exist in the providers config ---
    const ollamaProvider = nextConfig.models?.providers?.ollama ?? {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama-local",
        api: "openai-completions",
        models: [],
    };

    const existingModelIds = new Set(
        (ollamaProvider.models ?? []).map((m) => m.id)
    );

    const ensureModelDef = (id) => {
        if (!existingModelIds.has(id)) {
            ollamaProvider.models = [
                ...(ollamaProvider.models ?? []),
                {
                    id,
                    name: id,
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32768,
                    maxTokens: 2048,
                    compat: {
                        supportsStore: false,
                        supportsDeveloperRole: false,
                        supportsReasoningEffort: false,
                        maxTokensField: "max_tokens",
                    },
                },
            ];
            existingModelIds.add(id);
        }
    };

    ensureModelDef(fnModelId);
    if (textModelId) ensureModelDef(textModelId);

    // --- Build updated config ---
    const updatedHr = {
        ...hr,
        enabled: true,
        preference,
        localModel: { provider: "ollama", id: fnModelId },
        localTextModel: textModelId ? { provider: "ollama", id: textModelId } : null,
    };

    const result = {
        ...nextConfig,
        models: {
            ...nextConfig.models,
            providers: {
                ...nextConfig.models?.providers,
                ollama: ollamaProvider,
            },
        },
        agents: {
            ...nextConfig.agents,
            defaults: {
                ...nextConfig.agents?.defaults,
                hybridRouter: updatedHr,
            },
        },
    };

    note(
        [
            "Local model configuration updated:",
            `  Function-calling: ollama/${fnModelId}`,
            `  Text model: ${textModelId ? `ollama/${textModelId}` : "disabled"}`,
            `  Routing: ${preference}`,
        ].join("\n"),
        "Local models configured"
    );

    return result;
}
