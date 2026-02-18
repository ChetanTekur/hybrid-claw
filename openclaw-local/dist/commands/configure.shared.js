import { confirm as clackConfirm, intro as clackIntro, outro as clackOutro, select as clackSelect, text as clackText, } from "@clack/prompts";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
export const CONFIGURE_WIZARD_SECTIONS = [
    "workspace",
    "identity",
    "model",
    "local-models",
    "web",
    "gateway",
    "daemon",
    "channels",
    "skills",
    "health",
];
export const CONFIGURE_SECTION_OPTIONS = [
    { value: "workspace", label: "Workspace", hint: "Set workspace + sessions" },
    { value: "identity", label: "Identity", hint: "Agent name, personality, and your info" },
    { value: "model", label: "Model", hint: "Pick provider + credentials" },
    { value: "local-models", label: "Local models", hint: "Configure Ollama models for hybrid routing" },
    { value: "web", label: "Web tools", hint: "Configure Brave search + fetch" },
    { value: "gateway", label: "Gateway", hint: "Port, bind, auth, tailscale" },
    {
        value: "daemon",
        label: "Daemon",
        hint: "Install/manage the background service",
    },
    {
        value: "channels",
        label: "Channels",
        hint: "Link WhatsApp/Telegram/etc and defaults",
    },
    { value: "skills", label: "Skills", hint: "Install/enable workspace skills" },
    {
        value: "health",
        label: "Health check",
        hint: "Run gateway + channel checks",
    },
];
export const intro = (message) => clackIntro(stylePromptTitle(message) ?? message);
export const outro = (message) => clackOutro(stylePromptTitle(message) ?? message);
export const text = (params) => clackText({
    ...params,
    message: stylePromptMessage(params.message),
});
export const confirm = (params) => clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
});
export const select = (params) => clackSelect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) => opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) }),
});
