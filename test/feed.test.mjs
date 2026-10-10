// Offline tests for the Workshop collector and pack. Fixtures live in a temp dir.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildFeed } from "../packs/roblox-playtest/collector/playtest-feed.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixtureGame(name, runs) {
  const root = mkdtempSync(path.join(os.tmpdir(), `rp-${name}-`));
  writeFileSync(path.join(root, ".roblox-playtest.json"), JSON.stringify({ name }));
  const dir = path.join(root, ".playtest");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "history.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const last = runs[runs.length - 1];
  writeFileSync(path.join(dir, "report.json"), JSON.stringify({
    ...last,
    failures: [
      { status: "FAIL", name: "Level1.door", detail: "", knownFlaky: false },
      { status: "FAIL", name: "Level1.parkour.jump", detail: "", knownFlaky: true },
    ],
    gates: [{ id: "sync.source", status: "PASS", detail: "" }],
  }));
  return root;
}

const run = (verdict, finishedAt, pass = 10, fail = 0) => ({
  project: "", verdict, finishedAt, durationSec: 120, targets: "Level1", agent: "grok",
  totals: { pass, fail, skip: 1 }, newFailures: verdict === "fail" ? 1 : 0,
});

test("feed picks the newest report across games and counts history", () => {
  const a = fixtureGame("Alpha", [run("pass", "2026-10-01T10:00:00Z"), run("flaky", "2026-10-02T10:00:00Z")]);
  const b = fixtureGame("Beta", [run("fail", "2026-10-03T10:00:00Z", 8, 2)]);
  const feed = buildFeed([a, b], new Date("2026-10-03T12:00:00Z"));
  assert.equal(feed.schema, "go7-roblox-playtest/feed-v1");
  assert.equal(feed.latest.verdict, "fail");
  assert.equal(feed.latest.ok, false);
  assert.equal(feed.latest.total, 11);
  assert.deepEqual(feed.latest.newFailureNames, ["Level1.door"]);
  assert.deepEqual(feed.latest.flakyNames, ["Level1.parkour.jump"]);
  assert.equal(feed.recent.runs, 3);
  assert.equal(feed.recent.passing, 2);
  assert.equal(feed.recent.streak, 0);
  assert.equal(feed.projectLines.length, 2);
  assert.match(feed.historyLog[0], /Beta/);
});

test("feed with no runs paints nothing rather than inventing a verdict", () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), "rp-empty-"));
  const feed = buildFeed([empty]);
  assert.equal(feed.latest, null);
  assert.deepEqual(feed.historyLog, []);
});

test("pack.json binds only fields the feed publishes", () => {
  const pack = JSON.parse(readFileSync(path.join(repo, "packs", "roblox-playtest", "pack.json"), "utf8"));
  assert.equal(pack.id, "roblox-playtest");
  assert.equal(pack.sources[0].schema, "go7-roblox-playtest/feed-v1");
  const a = fixtureGame("Alpha", [run("pass", "2026-10-01T10:00:00Z")]);
  const feed = buildFeed([a]);
  const bindings = [...JSON.stringify(pack).matchAll(/"feed:(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(bindings.length > 5);
  for (const pointer of bindings) {
    let node = feed;
    for (const segment of pointer.slice(1).split("/")) node = node?.[segment];
    assert.notEqual(node, undefined, `feed is missing ${pointer}`);
  }
});
