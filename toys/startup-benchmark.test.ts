import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, summarize, buildRow } from "./startup-benchmark.ts";

test("parseArgs: defaults to delta mode with default runs", () => {
	const p = parseArgs("");
	assert.equal(p.mode, "delta");
	assert.equal(p.runs, 3);
	assert.deepEqual(p.entries, []);
});

test("parseArgs: a bare integer sets the run count", () => {
	assert.equal(parseArgs("5").runs, 5);
	assert.equal(parseArgs("delta 7").runs, 7);
});

test("parseArgs: run count is clamped to [1, maxRuns]", () => {
	assert.equal(parseArgs("0").runs, 1);
	assert.equal(parseArgs("999").runs, 20);
});

test("parseArgs: 'isolate' (and aliases) selects isolate mode", () => {
	assert.equal(parseArgs("isolate").mode, "isolate");
	assert.equal(parseArgs("iso 2").mode, "isolate");
	assert.equal(parseArgs("per-ext").mode, "isolate");
});

test("parseArgs: explicit entry paths imply isolate and are collected in order", () => {
	const p = parseArgs("2 ./toys/a.ts ./toys/b.ts");
	assert.equal(p.mode, "isolate");
	assert.equal(p.runs, 2);
	assert.deepEqual(p.entries, ["./toys/a.ts", "./toys/b.ts"]);
});

test("summarize: computes min/median/mean/max over an odd-length sample", () => {
	const s = summarize([30, 10, 20]);
	assert.equal(s.runs, 3);
	assert.equal(s.minMs, 10);
	assert.equal(s.maxMs, 30);
	assert.equal(s.medianMs, 20);
	assert.equal(s.meanMs, 20);
	assert.equal(s.stdevMs, Math.sqrt(200 / 3));
});

test("summarize: median averages the two middle values for even-length samples", () => {
	assert.equal(summarize([10, 20, 30, 40]).medianMs, 25);
});

test("summarize: throws on empty input rather than emitting NaN", () => {
	assert.throws(() => summarize([]), /no samples/);
});

test("buildRow: deltaVsFloorMs is median minus floor median, rounded", () => {
	const stats = summarize([1200.4, 1200.4, 1200.4]);
	const row = buildRow({
		mode: "isolate",
		label: "speedtest.ts",
		configArgs: ["-ne", "-e", "/x/speedtest.ts"],
		entry: "/x/speedtest.ts",
		stats,
		floorMedianMs: 1000,
		host: "darko-laptop",
		piVersion: "0.80.3",
		cwd: "/home/darko/proj",
	});
	assert.equal(row.deltaVsFloorMs, 200); // round(1200.4 - 1000)
	assert.equal(row.host, "darko-laptop");
	assert.equal(row.entry, "/x/speedtest.ts");
	assert.equal(row.medianMs, 1200); // rounded
});

test("buildRow: floor row (floorMedianMs === its own median) yields delta 0, not null", () => {
	const stats = summarize([1000, 1000, 1000]);
	const row = buildRow({
		mode: "delta",
		label: "floor (-ne)",
		configArgs: ["-ne"],
		entry: null,
		stats,
		floorMedianMs: stats.medianMs,
		host: "h",
		piVersion: "v",
		cwd: "/",
	});
	assert.equal(row.deltaVsFloorMs, 0);
	assert.equal(row.entry, null);
});
