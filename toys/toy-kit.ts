/**
 * toy-kit — opt-in stateless helpers shared across pi-powertoys toys.
 *
 * Sibling of toys-config.ts (the persistence module). This module holds only
 * pure, stateless helpers that were duplicated verbatim across two or more toys.
 * It imports nothing and registers nothing — toys opt in by importing what they
 * need. A helper belongs here ONLY when ≥2 toys contain a structurally identical
 * copy today; speculative helpers stay out.
 *
 * Like toys-config.ts, this file is imported, not loaded as an extension, so it
 * needs no entry in package.json `pi.extensions` or settings.json.
 */

// ── Tool-result content helpers ────────────────────────────────
// Duplicated in json-guard.ts, session-guard.ts (and inline in context-enforcer.ts).

/** Flatten Pi tool-result content (string | content-block[]) to plain text. */
export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => String(part.text ?? ""))
		.join("\n");
}

/** Wrap a string as a single text content block. */
export function contentWithText(text: string): { type: "text"; text: string }[] {
	return [{ type: "text", text }];
}

// ── Session-entry helpers ──────────────────────────────────────
// Duplicated backward-scan loop in color.ts and sys-prompt.ts (loadFromSession).

/**
 * Return the `.data` of the most-recent custom session entry of the given
 * `customType`, or `undefined` if none exists. Replaces the hand-rolled
 * `getEntries()` backward scan used by color.ts and sys-prompt.ts.
 */
export function findLastCustomEntry<T = unknown>(
	entries: readonly unknown[],
	customType: string,
): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
		if (entry?.type === "custom" && entry.customType === customType) {
			return entry.data as T | undefined;
		}
	}
	return undefined;
}

// ── Status-chip lifecycle ──────────────────────────────────────
// Duplicated set→work→clear cleanup in speedtest.ts and lint.ts. speedtest
// additionally leaked the chip when an awaited call threw (no try/finally).

/**
 * Run `fn` while a status chip is active, guaranteeing the chip is cleared
 * afterwards — even if `fn` throws or returns early. The caller sets/updates
 * the chip text inside `fn`; this wrapper owns only the cleanup.
 */
export async function withStatusChip<T>(
	ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } },
	key: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	try {
		return await fn();
	} finally {
		ctx.ui.setStatus(key, undefined);
	}
}