import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lintExtension from "./lint.ts";

test("lint passes the path as one argument without a shell and stays asynchronous", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lint-test-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(dir, "pyproject.toml"), "");
	writeFileSync(join(bin, "ruff"), '#!/bin/sh\nsleep 0.2\nprintf "%s\\n" "$@" > "$LINT_ARGS"\n', { mode: 0o755 });
	const before = { path: process.env.PATH, args: process.env.LINT_ARGS };
	process.env.PATH = `${bin}:${before.path}`;
	process.env.LINT_ARGS = join(dir, "args");
	const marker = join(dir, "injected");
	const target = `file; touch ${marker}`;
	let handler: Function = () => {};
	lintExtension({ registerCommand: (_: string, command: any) => { handler = command.handler; } } as any);
	let ticked = false;
	try {
		setTimeout(() => { ticked = true; }, 20);
		await handler(target, { cwd: dir, ui: { setStatus: () => {}, notify: () => {} } });
		assert.equal(existsSync(marker), false);
		assert.equal(ticked, true);
		assert.equal(readFileSync(join(dir, "args"), "utf8").trim().split("\n").at(-1), target);
	} finally {
		process.env.PATH = before.path;
		if (before.args === undefined) delete process.env.LINT_ARGS; else process.env.LINT_ARGS = before.args;
		rmSync(dir, { recursive: true, force: true });
	}
});
