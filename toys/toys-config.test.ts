import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

test("concurrent saves wait for lock and retain both keys", async () => {
	const home = mkdtempSync(join(tmpdir(), "toys-config-"));
	const dir = join(home, ".pi/agent/cache/pi-powertoys");
	mkdirSync(dir, { recursive: true });
	const lock = join(dir, "toys.json.lock");
	writeFileSync(lock, "held");
	const script = `import { saveToyConfig } from ${JSON.stringify(new URL("./toys-config.ts", import.meta.url).href)}; saveToyConfig(process.argv[1], process.argv[1]);`;
	const children = ["first", "second"].map((key) => spawn(process.execPath, ["--input-type=module", "-e", script, key], { env: { ...process.env, HOME: home }, stdio: "pipe" }));
	const exited = children.map((child) => new Promise<number | null>((resolve) => child.on("exit", resolve)));
	try {
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.equal(existsSync(join(dir, "toys.json")), false, "save did not wait for lock");
		unlinkSync(lock);
		assert.deepEqual(await Promise.all(exited), [0, 0]);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "toys.json"), "utf8")), { first: "first", second: "second" });
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill();
		await Promise.all(exited);
		rmSync(home, { recursive: true, force: true });
	}
});


test("migration retains malformed files and verifies imported settings before deleting", () => {
	const home = mkdtempSync(join(tmpdir(), "toys-migrate-"));
	const agent = join(home, ".pi/agent");
	mkdirSync(agent, { recursive: true });
	const legacy = join(agent, "toys.json");
	const malformed = join(agent, "compact-model.json");
	writeFileSync(legacy, JSON.stringify({ example: { enabled: true }, afk: { active: true } }));
	writeFileSync(malformed, "{");
	const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", `import { loadToyConfig } from ${JSON.stringify(new URL("./toys-config.ts", import.meta.url).href)}; try { loadToyConfig("example"); } catch { process.exitCode = 2; }`], { env: { ...process.env, HOME: home }, encoding: "utf8" });
	try {
		const config = join(agent, "cache/pi-powertoys/toys.json");
		mkdirSync(config, { recursive: true });
		assert.equal(run().status, 2);
		assert.equal(existsSync(legacy), true, "valid legacy file lost after failed save");
		assert.equal(existsSync(malformed), true, "malformed legacy file was deleted");
		rmSync(config, { recursive: true });
		assert.equal(run().status, 0);
		assert.equal(existsSync(legacy), false);
		assert.equal(existsSync(malformed), true);
		assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { example: { enabled: true }, afk: { active: true } });
	} finally { rmSync(home, { recursive: true, force: true }); }
});
