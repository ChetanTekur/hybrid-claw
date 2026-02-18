/**
 * Agent Identity Configuration Wizard
 *
 * Lets users set up their agent's name, personality, and user profile
 * during onboarding or configure. Writes IDENTITY.md, SOUL.md, and USER.md
 * in the workspace directory.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../terminal/note.js";
import { confirm, select, text } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

/**
 * Read an existing markdown field value like **Name:** value
 */
function readField(content, field) {
    const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "m");
    const m = content.match(re);
    if (!m) return null;
    const val = m[1].trim();
    // Skip placeholder values
    if (val.startsWith("*(") || val === "") return null;
    return val;
}

/**
 * Replace a markdown field value like **Name:** old → **Name:** new
 * If the field doesn't exist, returns content unchanged.
 */
function replaceField(content, field, newValue) {
    const re = new RegExp(`(\\*\\*${field}:\\*\\*)\\s*.*`, "m");
    if (!re.test(content)) return content;
    return content.replace(re, `$1 ${newValue}`);
}

/**
 * Prompt the user to configure their agent's identity.
 * Reads existing workspace files, prompts for changes, writes updates.
 *
 * @param {string} workspaceDir - Absolute path to workspace directory
 * @param {object} runtime      - OpenClaw runtime
 * @returns {Promise<void>}
 */
export async function promptIdentityConfig(workspaceDir, runtime) {
    if (!workspaceDir) {
        note("No workspace directory configured. Run onboarding first.", "Identity");
        return;
    }

    // Load existing files
    let identityContent = "";
    let soulContent = "";
    let userContent = "";

    try { identityContent = await fs.readFile(path.join(workspaceDir, "IDENTITY.md"), "utf-8"); } catch {}
    try { soulContent = await fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf-8"); } catch {}
    try { userContent = await fs.readFile(path.join(workspaceDir, "USER.md"), "utf-8"); } catch {}

    const existingName = readField(identityContent, "Name");
    const existingFullName = readField(identityContent, "Full Name");
    const existingVibe = readField(identityContent, "Vibe");
    const existingEmoji = readField(identityContent, "Emoji");
    const existingUserName = readField(userContent, "Name");
    const existingUserCall = readField(userContent, "What to call them");
    const existingTimezone = readField(userContent, "Timezone");

    const hasIdentity = Boolean(existingName);

    note(
        [
            "Your agent's identity determines how it introduces itself",
            "and how it behaves across all models (local and cloud).",
            "",
            hasIdentity
                ? `Current agent name: ${existingName}${existingFullName ? ` (${existingFullName})` : ""}`
                : "No agent identity configured yet.",
            existingUserName
                ? `Your name: ${existingUserCall || existingUserName}`
                : "Your name: not set",
        ].join("\n"),
        "Agent identity"
    );

    // --- Agent name ---
    const agentName = String(
        guardCancel(
            await text({
                message: "Agent name (short, like a username)",
                initialValue: existingName ?? "",
                placeholder: "e.g. jarvis, friday, hal, cortana",
            }),
            runtime
        ) ?? ""
    ).trim();

    if (!agentName) {
        note("Skipping identity setup — no name provided.", "Identity");
        return;
    }

    // --- Full name (optional) ---
    const fullName = String(
        guardCancel(
            await text({
                message: "Full name (optional — a fun longer name)",
                initialValue: existingFullName ?? "",
                placeholder: "e.g. Just A Rather Very Intelligent System",
            }),
            runtime
        ) ?? ""
    ).trim();

    // --- Vibe ---
    const vibeChoice = guardCancel(
        await select({
            message: "Agent vibe",
            options: [
                { value: "sharp", label: "Sharp & efficient", hint: "Gets things done without fluff" },
                { value: "warm", label: "Warm & friendly", hint: "Approachable and encouraging" },
                { value: "nerdy", label: "Nerdy & curious", hint: "Loves technical details" },
                { value: "custom", label: "Custom", hint: "Write your own vibe" },
            ],
            initialValue: existingVibe ? "custom" : "sharp",
        }),
        runtime
    );

    let vibe;
    if (vibeChoice === "custom") {
        vibe = String(
            guardCancel(
                await text({
                    message: "Describe the vibe",
                    initialValue: existingVibe ?? "",
                    placeholder: "e.g. Sharp, helpful, a bit nerdy. Gets things done without the fluff.",
                }),
                runtime
            ) ?? ""
        ).trim();
    } else {
        const vibeMap = {
            sharp: "Sharp, efficient, no-nonsense. Gets things done without the fluff.",
            warm: "Warm, friendly, encouraging. Makes tech feel approachable.",
            nerdy: "Nerdy, curious, detail-oriented. Loves diving deep into technical problems.",
        };
        vibe = vibeMap[vibeChoice] ?? "";
    }

    // --- Emoji ---
    const emoji = String(
        guardCancel(
            await text({
                message: "Signature emoji",
                initialValue: existingEmoji ?? "",
                placeholder: "e.g. \u{1F916} \u{1F9E0} \u{1F680} \u{26A1}",
            }),
            runtime
        ) ?? ""
    ).trim();

    // --- User info ---
    note(
        "Tell your agent about yourself so it can personalize responses.",
        "About you"
    );

    const userName = String(
        guardCancel(
            await text({
                message: "Your name",
                initialValue: existingUserCall || existingUserName || "",
                placeholder: "e.g. Alex",
            }),
            runtime
        ) ?? ""
    ).trim();

    const timezone = String(
        guardCancel(
            await text({
                message: "Your timezone",
                initialValue: existingTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
                placeholder: "e.g. America/Los_Angeles",
            }),
            runtime
        ) ?? ""
    ).trim();

    // --- Write IDENTITY.md ---
    let newIdentity = identityContent;
    if (!newIdentity || newIdentity.includes("*(pick something you like)*") || !readField(newIdentity, "Name")) {
        // Write from scratch
        const lines = [
            "# IDENTITY.md - Who Am I?",
            "",
            `- **Name:** ${agentName}`,
        ];
        if (fullName) {
            lines.push(`- **Full Name:** ${fullName}`);
        }
        lines.push(
            `- **Creature:** Transformer-based AI`,
            `- **Vibe:** ${vibe || "Helpful and sharp"}`,
            `- **Emoji:** ${emoji || "\u{1F916}"}`,
            `- **Avatar:** *(not set yet)*`,
            "",
            "---",
            "",
            `Born: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`,
            "",
            "Notes:",
            "- Save this file at the workspace root as `IDENTITY.md`.",
            '- For avatars, use a workspace-relative path like `avatars/openclaw.png`.',
            "",
        );
        newIdentity = lines.join("\n");
    } else {
        // Update existing fields
        newIdentity = replaceField(newIdentity, "Name", agentName);
        if (fullName) {
            if (readField(newIdentity, "Full Name") !== null) {
                newIdentity = replaceField(newIdentity, "Full Name", fullName);
            } else {
                // Insert Full Name after Name
                newIdentity = newIdentity.replace(
                    /(\*\*Name:\*\*\s*.+)/m,
                    `$1\n- **Full Name:** ${fullName}`
                );
            }
        }
        if (vibe) newIdentity = replaceField(newIdentity, "Vibe", vibe);
        if (emoji) newIdentity = replaceField(newIdentity, "Emoji", emoji);
    }

    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), newIdentity, "utf-8");

    // --- Write USER.md ---
    let newUser = userContent;
    if (userName || timezone) {
        if (!newUser || newUser.includes("*(What do they care about?") && !readField(newUser, "Name")) {
            // Write from scratch
            const lines = [
                "# USER.md - About Your Human",
                "",
                `- **Name:** ${userName}`,
                `- **What to call them:** ${userName}`,
                `- **Pronouns:** *(fill in)*`,
                `- **Timezone:** ${timezone || "*(fill in)*"}`,
                "",
                "## Context",
                "",
                `*(What do they care about? What projects are they working on?)*`,
                "",
                `- Just set up OpenClaw (${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })})`,
                "",
                "## Preferences",
                "",
                "*(how do you like to communicate? formal/casual? concise or detailed?)*",
                "",
                "---",
                "",
                "The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.",
                "",
            ];
            newUser = lines.join("\n");
        } else {
            if (userName) {
                newUser = replaceField(newUser, "Name", userName);
                newUser = replaceField(newUser, "What to call them", userName);
            }
            if (timezone) {
                newUser = replaceField(newUser, "Timezone", timezone);
            }
        }
        await fs.writeFile(path.join(workspaceDir, "USER.md"), newUser, "utf-8");
    }

    // --- Summary ---
    note(
        [
            "Identity configured:",
            `  Agent: ${agentName}${fullName ? ` (${fullName})` : ""}`,
            `  Vibe: ${vibe || "(default)"}`,
            `  Emoji: ${emoji || "(none)"}`,
            userName ? `  User: ${userName}` : null,
            timezone ? `  Timezone: ${timezone}` : null,
            "",
            "These are saved in your workspace files (IDENTITY.md, USER.md).",
            "Your agent will use this identity across all models.",
        ].filter(Boolean).join("\n"),
        "Identity set"
    );
}
