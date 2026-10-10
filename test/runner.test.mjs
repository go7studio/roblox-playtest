// Offline tests: no Studio, no network, nothing read from this machine's agent homes.
//   node --test test/

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { globToRegex, parseReport } from "../skills/roblox-playtest/scripts/rbx-playtest.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = path.join(repo, "skills", "roblox-playtest");

test("parseReport reads entries and the DONE line", () => {
  const { entries, done } = parseReport([
    "PASS Arena1.selected id=Arena1",
    "FAIL Arena1.parkour.gap fell short",
    "SKIP friends.callout no friend",
    "DONE pass=1 fail=1 skip=1 running=false",
  ].join("\n"));
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[1], { status: "FAIL", name: "Arena1.parkour.gap", detail: "fell short" });
  assert.deepEqual(done, { pass: 1, fail: 1, skip: 1, running: false });
});

test("parseReport handles a harness without running= and CRLF", () => {
  const { done } = parseReport("PASS a\r\nDONE pass=1 fail=0 skip=0\r\n");
  assert.deepEqual(done, { pass: 1, fail: 0, skip: 0, running: null });
});

test("knownFlaky globs match whole names or dotted suffixes only", () => {
  const re = globToRegex("bots.*");
  assert.ok(re.test("bots.chase"));
  assert.ok(re.test("HexHive.bots.chase"));
  assert.ok(!re.test("robots.chase"));
  assert.ok(globToRegex("HexHive.bots.*").test("HexHive.bots.alive"));
  assert.ok(!globToRegex("HexHive.bots.*").test("Arena1.bots.alive"));
  assert.ok(globToRegex("sfx.matchCues").test("Arena1.sfx.matchCues"));
  assert.ok(!globToRegex("sfx.matchCues").test("sfx.matchCuesExtra"));
});

test("SKILL.md has name and description frontmatter", () => {
  const text = readFileSync(path.join(skill, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  const front = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(front, "frontmatter block");
  assert.match(front[1], /^name: roblox-playtest$/m);
  assert.match(front[1], /^description: /m);
});

test("every relative link in the skill resolves", () => {
  const docs = [path.join(skill, "SKILL.md"), ...readdirSync(path.join(skill, "references")).map((f) => path.join(skill, "references", f))];
  for (const doc of docs) {
    const text = readFileSync(doc, "utf8");
    for (const [, target] of text.matchAll(/\]\(((?!https?:)[^)#]+)\)/g)) {
      const resolved = path.resolve(path.dirname(doc), target);
      assert.doesNotThrow(() => readFileSync(resolved), `${path.basename(doc)} -> ${target}`);
    }
  }
});

test("example config is valid JSON with the contract keys", () => {
  const config = JSON.parse(readFileSync(path.join(skill, "templates", "roblox-playtest.example.json"), "utf8"));
  assert.equal(config.schema, "go7-roblox-playtest/config-v1");
  for (const key of ["devHook", "smoke", "syncCheck", "rojo"]) assert.ok(config[key], key);
  for (const key of ["path", "status", "smoke", "report"]) assert.ok(config.devHook[key], `devHook.${key}`);
});

test("templates speak the report line format", () => {
  const harness = readFileSync(path.join(skill, "templates", "SmokeHarness.luau"), "utf8");
  assert.match(harness, /DONE pass=%d fail=%d skip=%d running=%s/);
  const hook = readFileSync(path.join(skill, "templates", "DevHook.server.luau"), "utf8");
  for (const command of ["status", "smoke", "smokeReport"]) assert.match(hook, new RegExp(`function commands\\.${command}\\(`));
});
