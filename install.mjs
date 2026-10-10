#!/usr/bin/env node
// Installs skills/roblox-playtest into every agent skill home on this machine.
//
//   node install.mjs                 copy into each home whose agent is installed
//   node install.mjs --link          junction/symlink instead of copy (updates follow this checkout)
//   node install.mjs --only grok,codex
//   node install.mjs --dry-run
//   node install.mjs --uninstall
//
// Homes: ~/.grok/skills, ~/.codex/skills, ~/.claude/skills, ~/.cursor/skills, ~/.agents/skills
// (the same folders Go7 Workhorse lists in Settings > Skills).

import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = "roblox-playtest";
const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills", SKILL);
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1].split(",").map((s) => s.trim()) : null;
const dry = flag("dry-run");

const home = os.homedir();
const homes = [
  { agent: "grok", root: path.join(home, ".grok") },
  { agent: "codex", root: path.join(home, ".codex") },
  { agent: "claude", root: path.join(home, ".claude") },
  { agent: "cursor", root: path.join(home, ".cursor") },
  { agent: "agents", root: path.join(home, ".agents") },
];

if (!existsSync(path.join(source, "SKILL.md"))) {
  console.error(`missing ${source}/SKILL.md`);
  process.exit(2);
}

let changed = 0;
for (const { agent, root } of homes) {
  if (only && !only.includes(agent)) continue;
  if (!existsSync(root)) {
    console.log(`${agent.padEnd(7)} skip (${root} not found)`);
    continue;
  }
  const target = path.join(root, "skills", SKILL);
  const exists = existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })();
  if (flag("uninstall")) {
    if (exists) {
      console.log(`${agent.padEnd(7)} ${dry ? "[dry-run] " : ""}remove ${target}`);
      if (!dry) rmSync(target, { recursive: true, force: true });
      changed++;
    }
    continue;
  }
  console.log(`${agent.padEnd(7)} ${dry ? "[dry-run] " : ""}${flag("link") ? "link" : "copy"} -> ${target}`);
  if (dry) continue;
  mkdirSync(path.dirname(target), { recursive: true });
  if (exists) rmSync(target, { recursive: true, force: true });
  if (flag("link")) symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  else cpSync(source, target, { recursive: true });
  changed++;
}
console.log(`${changed} home(s) ${flag("uninstall") ? "cleaned" : "updated"}. Next: node ${path.join(source, "scripts", "rbx-playtest.mjs")} doctor`);
