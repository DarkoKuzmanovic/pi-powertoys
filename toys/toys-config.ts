/**
 * toys-config — Shared persistence for pi-powertoys.
 *
 * All toy settings live in a single file: ~/.pi/agent/cache/pi-powertoys/toys.json
 * Each toy owns a top-level key (e.g. "compactModel", "contextualWorking").
 *
 * On first load, legacy root/per-toy JSON files are migrated into toys.json
 * and the old files are removed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "cache", "pi-powertoys", "toys.json");

// ── Legacy paths (for one-time migration) ──────────────────────

const LEGACY: Record<string, string> = {
	compactModel: join(homedir(), ".pi", "agent", "compact-model.json"),
	circuitBreaker: join(homedir(), ".pi", "agent", "circuit-breaker.json"),
};
const LEGACY_TOYS_PATH = join(homedir(), ".pi", "agent", "toys.json");

// ── Read / write ────────────────────────────────────────────────

interface ToysConfig {
	[key: string]: unknown;
}

function loadAll(): ToysConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
			if (raw && typeof raw === "object") return raw as ToysConfig;
		}
	} catch { /* corrupt or missing — start fresh */ }
	return {};
}

function saveAll(config: ToysConfig): void {
	const dir = dirname(CONFIG_PATH);
	mkdirSync(dir, { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ── Per-toy API ────────────────────────────────────────────────

/** Load a toy's config section. Returns `undefined` if not set. */
export function loadToyConfig<T>(key: string): T | undefined {
	migrateLegacy();
	const config = loadAll();
	const value = config[key];
	if (value === undefined || value === null) return undefined;
	return value as T;
}

/** Save a toy's config section (merges into existing file). */
export function saveToyConfig(key: string, value: unknown): void {
	migrateLegacy();
	const config = loadAll();
	config[key] = value;
	saveAll(config);
}

/** Remove a toy's config section. */
export function removeToyConfig(key: string): void {
	const config = loadAll();
	delete config[key];
	saveAll(config);
}

// ── Legacy migration (runs once per key) ────────────────────────

let migrated = false;

function migrateLegacy(): void {
	if (migrated) return;
	migrated = true;

	const config = loadAll();
	let changed = false;

	if (existsSync(LEGACY_TOYS_PATH)) {
		try {
			const raw = JSON.parse(readFileSync(LEGACY_TOYS_PATH, "utf-8"));
			if (raw && typeof raw === "object") {
				for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
					if (config[key] === undefined) {
						config[key] = value;
						changed = true;
					}
				}
			}
		} catch { /* corrupt legacy root config — skip */ }

		try {
			unlinkSync(LEGACY_TOYS_PATH);
		} catch { /* can't delete — not critical */ }
	}

	for (const [key, legacyPath] of Object.entries(LEGACY)) {
		// Skip if already migrated (key exists in cache/pi-powertoys/toys.json)
		if (config[key] !== undefined) continue;
		// Skip if legacy file doesn't exist
		if (!existsSync(legacyPath)) continue;

		try {
			const raw = JSON.parse(readFileSync(legacyPath, "utf-8"));
			if (raw && typeof raw === "object") {
				config[key] = raw;
				changed = true;
			}
		} catch { /* corrupt legacy file — skip */ }

		// Remove the legacy file
		try {
			unlinkSync(legacyPath);
		} catch { /* can't delete — not critical */ }
	}

	if (changed) saveAll(config);
}
