import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

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
