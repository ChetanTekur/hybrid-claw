export function normalizeMessageProvider(raw) {
    const normalized = raw?.trim().toLowerCase();
    if (!normalized)
        return undefined;
    return normalized === "imsg" ? "imessage" : normalized;
}
export function resolveMessageProvider(primary, fallback) {
    return (normalizeMessageProvider(primary) ?? normalizeMessageProvider(fallback));
}
