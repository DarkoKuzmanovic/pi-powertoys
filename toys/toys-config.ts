/**
 * toys-config — Shared persistence for pi-powertoys.
 *
 * All toy settings live in a single file: ~/.pi/agent/cache/pi-powertoys/toys.json
 * Each toy owns a top-level key (e.g. "compactModel", "contextualWorking").
 *
 * On first load, legacy root/per-toy JSON files are migrated into toys.json
 * and the old files are removed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, renameSync, statSync } from "node:fs";
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
			if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ToysConfig;
		}
	} catch { /* corrupt or missing — start fresh */ }
	return {};
}

const STALE_LOCK_MS = 2000;

function withLock<T>(fn: () => T): T {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const lock = `${CONFIG_PATH}.lock`;
	const deadline = Date.now() + 5000;
	let fd: number;
	while (true) {
		try {
			fd = openSync(lock, "wx");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				// Locks live for milliseconds, so one older than STALE_LOCK_MS was left by a killed process;
				// taking it over well before the wait deadline keeps a crash from freezing the next start.
				// shortcut: two processes that both judge one crashed lock stale can race (one may delete the other's fresh lock); move to per-toy files only if this is ever seen.
				if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			if (Date.now() >= deadline) throw new Error("Timed out waiting for toys config lock");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
	try {
		return fn();
	} finally {
		closeSync(fd);
		unlinkSync(lock);
	}
}

function saveAll(config: ToysConfig): void {
	const temp = `${CONFIG_PATH}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", flag: "wx" });
		renameSync(temp, CONFIG_PATH);
	} finally {
		try { unlinkSync(temp); } catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
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
	withLock(() => {
		const config = loadAll();
		config[key] = value;
		saveAll(config);
	});
}

/** Remove a toy's config section. */
export function removeToyConfig(key: string): void {
	withLock(() => {
		const config = loadAll();
		delete config[key];
		saveAll(config);
	});
}

// ── Legacy migration (runs once per key) ────────────────────────

let migrated = false;

function migrateLegacy(): void {
	if (migrated) return;
	// Readers never take the lock unless there is something to migrate.
	if (![LEGACY_TOYS_PATH, ...Object.values(LEGACY)].some((path) => existsSync(path))) {
		migrated = true;
		return;
	}
	withLock(() => {
		const config = loadAll();
		const imported: string[] = [];

		if (existsSync(LEGACY_TOYS_PATH)) {
			try {
				const raw = JSON.parse(readFileSync(LEGACY_TOYS_PATH, "utf-8"));
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					for (const [key, value] of Object.entries(raw)) {
						if (config[key] === undefined) config[key] = value;
					}
					imported.push(LEGACY_TOYS_PATH);
				}
			} catch { /* corrupt legacy root config — leave it in place */ }
		}

		for (const [key, legacyPath] of Object.entries(LEGACY)) {
			if (config[key] !== undefined || !existsSync(legacyPath)) continue;
			try {
				const raw = JSON.parse(readFileSync(legacyPath, "utf-8"));
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					config[key] = raw;
					imported.push(legacyPath);
				}
			} catch { /* corrupt legacy file — leave it in place */ }
		}

		if (imported.length) {
			saveAll(config); // throws before any original is deleted
			for (const path of imported) {
				try { unlinkSync(path); } catch { /* can't delete — not critical */ }
			}
		}
		migrated = true;
	});
}
