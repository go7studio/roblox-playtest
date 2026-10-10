#!/usr/bin/env node
// roblox-playtest runner: one CLI for every agent (Grok terminal, Workhorse, Cursor, Codex, Claude, CI).
// Drives Roblox Studio through the Studio MCP, so it never sends OS keystrokes or steals window focus.
//
//   node rbx-playtest.mjs doctor [--json]              preflight every gate; exit 1 if any FAIL
//   node rbx-playtest.mjs sync                         Rojo up + Studio in Edit + synced source matches disk
//   node rbx-playtest.mjs play | stop                  start/stop a play session and wait until it settles
//   node rbx-playtest.mjs status                       the dev hook's status (play mode)
//   node rbx-playtest.mjs hook <command> [args...]     any dev hook command; args are JSON when they parse
//   node rbx-playtest.mjs smoke [--targets "A B"] [--keep-playing] [--timeout 1200] [--no-sync]
//   node rbx-playtest.mjs report                       print the last report summary
//   node rbx-playtest.mjs nav <x y z | instancePath>   walk the player's character there (Client)
//   node rbx-playtest.mjs keys <Key[:ms]>...           press keys in the game, e.g. keys W:800 Space
//   node rbx-playtest.mjs click <instancePath>         click a GUI object, e.g. LocalPlayer.PlayerGui.Menu.Play
//   node rbx-playtest.mjs probe <command> [args...]    the project's client probe (RemoteFunction:InvokeClient)
//   node rbx-playtest.mjs shot <file.png>              game view screenshot (with GUI while playing)
//   node rbx-playtest.mjs console [--grep text] [--tail N]
//   node rbx-playtest.mjs register [--agents grok,cursor,codex,claude] [--dry-run]
//
// Global: --project <dir> (default: nearest folder with .roblox-playtest.json), --json.
// Exit codes: 0 pass, 1 fail (new smoke failures / doctor FAIL), 2 blocked (a gate failed before the
// test could run), 3 timeout.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, launcherExists, mcpLauncher } from "./lib/mcp.mjs";

const REPORT_SCHEMA = "go7-roblox-playtest/report-v1";
const CONFIG_FILE = ".roblox-playtest.json";
const REQUIRED_TOOLS = ["list_roblox_studios", "get_studio_state", "start_stop_play", "execute_luau", "get_console_output"];
const WALK_TOOLS = ["character_navigation", "user_keyboard_input", "user_mouse_input", "screen_capture"];
const MCP_NAME = "Roblox_Studio";

// ---------- args / config ----------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadConfig(flags) {
  const root = flags.project ? path.resolve(flags.project) : findProjectRoot(process.cwd());
  const base = {
    name: "",
    studioMatch: "",
    rojo: null,
    syncCheck: null,
    devHook: { path: "game.ServerStorage.DevHook", status: "status", smoke: "smoke", report: "smokeReport" },
    probe: null,
    smoke: { targets: "", timeoutSec: 1200, pollSec: 5, knownFlaky: [] },
    reportDir: ".playtest",
  };
  if (!root || !existsSync(path.join(root, CONFIG_FILE))) {
    return { root: root || process.cwd(), file: null, config: base };
  }
  const file = path.join(root, CONFIG_FILE);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const config = {
    ...base,
    ...raw,
    devHook: { ...base.devHook, ...(raw.devHook || {}) },
    smoke: { ...base.smoke, ...(raw.smoke || {}) },
  };
  if (!config.studioMatch && raw.placeId) config.studioMatch = `placeId: ${raw.placeId}`;
  return { root, file, config };
}

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const luauString = (s) => {
  let level = "=";
  while (String(s).includes("]" + level + "]")) level += "=";
  return `[${level}[${s}]${level}]`;
};

const RESOLVE_LUAU = `
local function resolve(p)
	local inst = game
	for seg in string.gmatch(p, "[^%.]+") do
		if not (seg == "game" and inst == game) then
			inst = inst and inst:FindFirstChild(seg)
		end
	end
	return inst
end`;

function normalizeSource(text) {
  return String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

export function globToRegex(glob) {
  const body = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`(^|\\.)${body}$`);
}

export function parseReport(text) {
  const entries = [];
  let done = null;
  for (const line of String(text).split(/\r?\n/)) {
    const entry = line.match(/^(PASS|FAIL|SKIP)\s+(\S+)\s?(.*)$/);
    if (entry) {
      entries.push({ status: entry[1], name: entry[2], detail: entry[3] || "" });
      continue;
    }
    const d = line.match(/^DONE pass=(\d+) fail=(\d+) skip=(\d+)(?: running=(\w+))?/);
    if (d) done = { pass: +d[1], fail: +d[2], skip: +d[3], running: d[4] === undefined ? null : d[4] === "true" };
  }
  return { entries, done };
}

function gate(list, id, status, detail = "") {
  list.push({ id, status, detail });
  return status !== "FAIL";
}

function printGates(gates) {
  for (const g of gates) console.log(`${g.status.padEnd(4)} ${g.id}${g.detail ? "  " + g.detail : ""}`);
}

function which(cmd) {
  const probe = process.platform === "win32" ? spawnSync("where", [cmd], { encoding: "utf8" }) : spawnSync("which", [cmd], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.split(/\r?\n/)[0].trim() : null;
}

function grokExe() {
  const local = path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  return existsSync(local) ? local : which("grok");
}

function readText(file) {
  try { return readFileSync(file, "utf8"); } catch { return null; }
}

function launcherSpec() {
  const l = mcpLauncher();
  return process.platform === "win32" && !process.env.RBX_MCP_CMD
    ? { command: "cmd.exe", args: ["/c", l.path] }
    : { command: l.path, args: [] };
}

// ---------- Studio steps ----------

async function openStudio(config, gates) {
  if (!launcherExists()) {
    gate(gates, "mcp.launcher", "FAIL", `${mcpLauncher().path} missing. Install/update Roblox Studio and turn on its MCP server (Assistant > MCP).`);
    return null;
  }
  gate(gates, "mcp.launcher", "PASS", mcpLauncher().path);
  let client;
  try {
    client = await connect();
  } catch (err) {
    gate(gates, "mcp.connect", "FAIL", err.message);
    return null;
  }
  const studio = await client.pickStudio(config.studioMatch);
  if (!studio) {
    const names = (client.studios || []).map((s) => s.name).join(" | ") || "none open";
    gate(gates, "studio.connected", "FAIL", `no Studio matching "${config.studioMatch || "*"}" (open: ${names})`);
    client.close();
    return null;
  }
  gate(gates, "studio.connected", "PASS", `${studio.name} [${studio.id}]`);
  return client;
}

async function checkRojo(config, gates) {
  if (!config.rojo) return gate(gates, "rojo.serving", "SKIP", "no rojo in config");
  const url = `http://127.0.0.1:${config.rojo.port || 34872}/api/rojo`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const info = await response.json();
    if (config.rojo.projectName && info.projectName !== config.rojo.projectName) {
      return gate(gates, "rojo.serving", "FAIL", `${url} serves "${info.projectName}", expected "${config.rojo.projectName}"`);
    }
    return gate(gates, "rojo.serving", "PASS", `${info.projectName} on ${url}`);
  } catch (err) {
    return gate(gates, "rojo.serving", "FAIL", `${url} not answering (${err.message}). Start: rojo serve`);
  }
}

async function checkSync(client, root, config, gates) {
  const check = config.syncCheck;
  if (!check) return gate(gates, "sync.source", "SKIP", "no syncCheck in config");
  const file = path.join(root, check.file);
  const disk = readText(file);
  if (disk === null) return gate(gates, "sync.source", "FAIL", `missing ${check.file}`);
  const result = await client.luau("Edit", `${RESOLVE_LUAU}
local inst = resolve(${luauString(check.instance)})
if not inst then return "__MISSING__" end
return inst.Source`);
  if (result.isError) return gate(gates, "sync.source", "FAIL", result.text.slice(0, 300));
  if (result.text === "__MISSING__") {
    return gate(gates, "sync.source", "FAIL", `${check.instance} not in the place. Is the Rojo plugin connected?`);
  }
  const same = normalizeSource(result.text) === normalizeSource(disk);
  return gate(gates, "sync.source", same ? "PASS" : "FAIL",
    same ? `${check.instance} matches ${check.file}` : `${check.instance} differs from ${check.file}. Reconnect the Rojo plugin (Studio must be in Edit).`);
}

async function waitForMode(client, wantPlaying, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await client.state();
      const playing = last.datamodels.includes("Server");
      if (playing === wantPlaying) return last;
    } catch {}
    await sleep(2000);
  }
  return last;
}

async function setPlay(client, on, gates) {
  const id = on ? "play.started" : "play.stopped";
  const current = await client.state();
  if (current.datamodels.includes("Server") === on) return gate(gates, id, "PASS", `already ${current.mode}`);
  try {
    await client.setPlaying(on, 60000);
  } catch (err) {
    // start_stop_play can time out while play is in fact starting; the state poll below decides
  }
  const after = await waitForMode(client, on, 90000);
  const ok = after && after.datamodels.includes("Server") === on;
  return gate(gates, id, ok ? "PASS" : "FAIL", after ? `mode=${after.mode} models=${after.datamodels.join(",")}` : "no state");
}

async function waitForHook(client, config, gates, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.luau("Server", `${RESOLVE_LUAU}
local hook = resolve(${luauString(config.devHook.path)})
return hook and hook.ClassName or "none"`).catch((err) => ({ text: err.message }));
    if (/BindableFunction/.test(result.text)) return gate(gates, "hook.ready", "PASS", config.devHook.path);
    await sleep(2000);
  }
  return gate(gates, "hook.ready", "FAIL", `${config.devHook.path} never appeared. Add the DevHook template (templates/DevHook.server.luau).`);
}

async function invokeHook(client, config, command, args = [], { spawn = false } = {}) {
  const payload = JSON.stringify([command, ...args]);
  const call = `hook:Invoke(table.unpack(args, 1, #args))`;
  const code = `${RESOLVE_LUAU}
local HttpService = game:GetService("HttpService")
local hook = resolve(${luauString(config.devHook.path)})
if not hook then error("dev hook missing: ${config.devHook.path}") end
local args = HttpService:JSONDecode(${luauString(payload)})
${spawn ? `task.spawn(function() ${call} end) return "started"` : `local result = ${call}
if type(result) == "table" then return HttpService:JSONEncode(result) end
return tostring(result)`}`;
  return client.luau("Server", code);
}

// ---------- commands ----------

async function cmdDoctor(ctx) {
  const { config, root, file } = ctx;
  const gates = [];
  const major = Number(process.versions.node.split(".")[0]);
  gate(gates, "node.version", major >= 18 ? "PASS" : "FAIL", `node ${process.versions.node}${major >= 18 ? "" : " (need 18+)"}`);
  gate(gates, "project.config", file ? "PASS" : "WARN", file || `no ${CONFIG_FILE}; using defaults (copy templates/roblox-playtest.example.json)`);

  const client = await openStudio(config, gates);
  if (client) {
    try {
      const tools = await client.tools();
      const missing = REQUIRED_TOOLS.filter((t) => !tools.includes(t));
      gate(gates, "mcp.tools", missing.length ? "FAIL" : "PASS", missing.length ? `missing: ${missing.join(", ")}` : `${tools.length} tools`);
      const walkMissing = WALK_TOOLS.filter((t) => !tools.includes(t));
      gate(gates, "mcp.walkTools", walkMissing.length ? "WARN" : "PASS", walkMissing.length ? `missing: ${walkMissing.join(", ")}` : WALK_TOOLS.join(", "));
      const state = await client.state();
      const playing = state.datamodels.includes("Server");
      gate(gates, "studio.mode", "PASS", `${state.mode} (${state.datamodels.join(",")})`);
      await checkRojo(config, gates);
      if (playing) {
        gate(gates, "sync.source", "SKIP", "Studio is playing; Rojo only syncs in Edit");
        const hook = await invokeHook(client, config, config.devHook.status).catch((err) => ({ isError: true, text: err.message }));
        gate(gates, "hook.status", hook.isError ? "FAIL" : "PASS", hook.text.split("\n")[0].slice(0, 160));
      } else {
        await checkSync(client, root, config, gates);
        gate(gates, "hook.status", "SKIP", "dev hook exists only in play; run: rbx-playtest play");
      }
    } finally {
      client.close();
    }
  } else {
    await checkRojo(config, gates);
  }

  for (const result of agentRegistrations()) gate(gates, `agent.${result.agent}`, result.status, result.detail);
  for (const result of skillInstalls()) gate(gates, `skill.${result.agent}`, result.status, result.detail);

  if (ctx.flags.json) console.log(JSON.stringify({ schema: "go7-roblox-playtest/doctor-v1", project: config.name, gates }, null, 2));
  else printGates(gates);
  return gates.some((g) => g.status === "FAIL") ? 1 : 0;
}

async function cmdSync(ctx) {
  const gates = [];
  await checkRojo(ctx.config, gates);
  const client = await openStudio(ctx.config, gates);
  if (client) {
    try {
      const state = await client.state();
      if (state.datamodels.includes("Server")) {
        await setPlay(client, false, gates);
        await sleep(4000);
      }
      await checkSync(client, ctx.root, ctx.config, gates);
    } finally {
      client.close();
    }
  }
  printGates(gates);
  return gates.some((g) => g.status === "FAIL") ? 2 : 0;
}

async function cmdPlay(ctx, on) {
  const gates = [];
  const client = await openStudio(ctx.config, gates);
  if (client) {
    try {
      await setPlay(client, on, gates);
      if (on) await waitForHook(client, ctx.config, gates);
    } finally {
      client.close();
    }
  }
  printGates(gates);
  return gates.some((g) => g.status === "FAIL") ? 2 : 0;
}

function hookArgs(list) {
  return list.map((value) => {
    try { return JSON.parse(value); } catch { return value; }
  });
}

async function cmdHook(ctx, command, args) {
  const gates = [];
  const client = await openStudio(ctx.config, gates);
  if (!client) { printGates(gates); return 2; }
  try {
    const result = await invokeHook(client, ctx.config, command, hookArgs(args));
    console.log(result.text);
    return result.isError ? 1 : 0;
  } finally {
    client.close();
  }
}

async function cmdSmoke(ctx) {
  const { config, root, flags } = ctx;
  const startedAt = new Date();
  const targets = typeof flags.targets === "string" ? flags.targets : config.smoke.targets || "";
  const timeoutSec = Number(flags.timeout || config.smoke.timeoutSec || 1200);
  const pollMs = 1000 * Number(config.smoke.pollSec || 5);
  const gates = [];
  let verdict = "blocked";
  let reportText = "";
  let studio = null;

  const client = await openStudio(config, gates);
  try {
    if (client) {
      studio = client.studio;
      const state = await client.state();
      if (state.datamodels.includes("Server")) {
        await setPlay(client, false, gates);
        await sleep(4000);
      }
      const rojoOk = await checkRojo(config, gates);
      const syncOk = flags["no-sync"] ? gate(gates, "sync.source", "SKIP", "--no-sync") : await checkSync(client, root, config, gates);
      if (rojoOk && syncOk && (await setPlay(client, true, gates)) && (await waitForHook(client, config, gates))) {
        const start = await invokeHook(client, config, config.devHook.smoke, [targets], { spawn: true });
        if (gate(gates, "smoke.started", start.isError ? "FAIL" : "PASS", start.isError ? start.text.slice(0, 300) : `targets="${targets || "all"}"`)) {
          const deadline = Date.now() + timeoutSec * 1000;
          let lastCount = -1;
          verdict = "timeout";
          while (Date.now() < deadline) {
            await sleep(pollMs);
            const report = await invokeHook(client, config, config.devHook.report).catch((err) => ({ isError: true, text: err.message }));
            if (report.isError) continue;
            reportText = report.text;
            const { entries, done } = parseReport(reportText);
            if (entries.length !== lastCount) {
              for (const e of entries.slice(Math.max(lastCount, 0))) {
                if (e.status === "FAIL" || flags.verbose) console.log(`${e.status} ${e.name} ${e.detail}`);
              }
              lastCount = entries.length;
              if (!flags.json) process.stdout.write(`[smoke] ${entries.length} checks so far\n`);
            }
            const total = done ? done.pass + done.fail + done.skip : 0;
            const finished = done && total > 0 && done.running !== true;
            if (finished) {
              verdict = "done";
              break;
            }
          }
          gate(gates, "smoke.finished", verdict === "done" ? "PASS" : "FAIL", verdict === "done" ? "" : `no DONE within ${timeoutSec}s`);
        }
      }
      if (!flags["keep-playing"]) await setPlay(client, false, gates).catch(() => {});
    }
  } finally {
    client?.close();
  }

  const { entries, done } = parseReport(reportText);
  const flaky = (config.smoke.knownFlaky || []).map(globToRegex);
  const failures = entries.filter((e) => e.status === "FAIL").map((e) => ({ ...e, knownFlaky: flaky.some((re) => re.test(e.name)) }));
  const newFailures = failures.filter((f) => !f.knownFlaky);
  if (verdict === "done") verdict = newFailures.length ? "fail" : failures.length ? "flaky" : "pass";

  const finishedAt = new Date();
  const report = {
    schema: REPORT_SCHEMA,
    project: config.name || path.basename(root),
    placeId: config.placeId || null,
    agent: process.env.RBX_AGENT || process.env.WORKHORSE_AGENT || "unknown",
    command: "smoke",
    targets: targets || "all",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec: Math.round((finishedAt - startedAt) / 1000),
    verdict,
    totals: done ? { pass: done.pass, fail: done.fail, skip: done.skip } : { pass: 0, fail: 0, skip: 0 },
    newFailures: newFailures.length,
    failures,
    gates,
    studio,
  };
  const dir = path.join(root, config.reportDir || ".playtest");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(dir, "smoke.txt"), reportText);
  const { failures: _omit, gates: _gates, studio: _studio, ...summary } = report;
  appendFileSync(path.join(dir, "history.jsonl"), JSON.stringify({ ...summary, failedNames: failures.map((f) => f.name) }) + "\n");

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printGates(gates);
    for (const f of failures) console.log(`${f.knownFlaky ? "FLAKY" : "FAIL "} ${f.name} ${f.detail}`);
    console.log(`[smoke] verdict=${verdict} pass=${report.totals.pass} fail=${report.totals.fail} skip=${report.totals.skip} new=${newFailures.length} (${path.join(dir, "report.json")})`);
  }
  return { pass: 0, flaky: 0, fail: 1, blocked: 2, timeout: 3 }[verdict] ?? 2;
}

function cmdReport(ctx) {
  const file = path.join(ctx.root, ctx.config.reportDir || ".playtest", "report.json");
  const text = readText(file);
  if (!text) { console.log(`no report at ${file}`); return 2; }
  const report = JSON.parse(text);
  if (ctx.flags.json) { console.log(text); return 0; }
  console.log(`${report.project} ${report.finishedAt} verdict=${report.verdict} pass=${report.totals.pass} fail=${report.totals.fail} skip=${report.totals.skip} new=${report.newFailures}`);
  for (const f of report.failures) console.log(`${f.knownFlaky ? "FLAKY" : "FAIL "} ${f.name} ${f.detail}`);
  return 0;
}

async function withClient(ctx, fn) {
  const gates = [];
  const client = await openStudio(ctx.config, gates);
  if (!client) { printGates(gates); return 2; }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function printResult(result) {
  if (result.text) console.log(result.text);
  return result.isError ? 1 : 0;
}

async function cmdNav(ctx, args) {
  return withClient(ctx, async (client) => {
    const params = { studio_id: client.studio.id, datamodel_type: "Client" };
    if (args.length >= 3 && args.slice(0, 3).every((v) => !Number.isNaN(Number(v)))) {
      [params.x, params.y, params.z] = args.slice(0, 3).map(Number);
    } else if (args[0]) {
      params.instance_path = args[0];
    } else {
      throw new Error("usage: nav <x y z | instancePath>");
    }
    if (ctx.flags.speed) params.speed_multiplier = Number(ctx.flags.speed);
    return printResult(await client.call("character_navigation", params, 120000));
  });
}

async function cmdKeys(ctx, args) {
  const actions = [];
  for (const token of args) {
    const [key, ms] = token.split(":");
    if (key.toLowerCase() === "wait") {
      actions.push({ action: "wait", wait_time_ms: Number(ms || 500) });
    } else if (ms) {
      actions.push({ action: "keyDown", key_code: key }, { action: "wait", wait_time_ms: Number(ms) }, { action: "keyUp", key_code: key });
    } else {
      actions.push({ action: "keyPress", key_code: key });
    }
  }
  if (!actions.length) throw new Error("usage: keys <Key[:holdMs] | wait:ms>...");
  return withClient(ctx, async (client) =>
    printResult(await client.call("user_keyboard_input", { studio_id: client.studio.id, datamodel_type: "Client", actions })));
}

async function cmdClick(ctx, args) {
  if (!args[0]) throw new Error("usage: click <instancePath> | click <x> <y>");
  const target = args.length >= 2 && !Number.isNaN(Number(args[0])) ? { x: Number(args[0]), y: Number(args[1]) } : { instance_path: args[0] };
  return withClient(ctx, async (client) =>
    printResult(await client.call("user_mouse_input", {
      studio_id: client.studio.id,
      datamodel_type: "Client",
      actions: [{ action: "moveTo", ...target }, { action: "mouseButtonClick", mouse_button: "left" }],
    })));
}

async function cmdProbe(ctx, command, args) {
  const probe = ctx.config.probe;
  if (!probe?.path) throw new Error(`no probe.path in ${CONFIG_FILE}`);
  const payload = JSON.stringify([command, ...hookArgs(args)]);
  return withClient(ctx, async (client) =>
    printResult(await client.luau("Server", `${RESOLVE_LUAU}
local HttpService = game:GetService("HttpService")
local probe = resolve(${luauString(probe.path)})
if not probe then error("probe missing: ${probe.path}") end
local player = game:GetService("Players"):GetPlayers()[1]
if not player then error("no player in game") end
local args = HttpService:JSONDecode(${luauString(payload)})
local result = probe:InvokeClient(player, table.unpack(args, 1, #args))
if type(result) == "table" then return HttpService:JSONEncode(result) end
return tostring(result)`)));
}

async function cmdShot(ctx, file) {
  if (!file) throw new Error("usage: shot <file.png>");
  return withClient(ctx, async (client) => {
    const result = await client.call("screen_capture", { studio_id: client.studio.id, capture_id: `Playtest_${Date.now()}` }, 60000);
    if (!result.images[0]) { console.log(result.text || "no image returned"); return 1; }
    writeFileSync(file, Buffer.from(result.images[0].data, "base64"));
    console.log(`saved ${path.resolve(file)}`);
    return 0;
  });
}

async function cmdConsole(ctx) {
  return withClient(ctx, async (client) => {
    const result = await client.call("get_console_output", { studio_id: client.studio.id }, 60000);
    let lines = result.text.split(/\r?\n/);
    if (typeof ctx.flags.grep === "string") lines = lines.filter((l) => l.toLowerCase().includes(ctx.flags.grep.toLowerCase()));
    if (ctx.flags.tail) lines = lines.slice(-Number(ctx.flags.tail));
    console.log(lines.join("\n"));
    return result.isError ? 1 : 0;
  });
}

// ---------- agent MCP registration ----------

const MCP_MARKERS = /mcp\.bat|StudioMCP/i;

function agentRegistrations() {
  const home = os.homedir();
  const results = [];
  const grok = grokExe();
  if (grok) {
    const listed = spawnSync(grok, ["mcp", "list"], { encoding: "utf8", timeout: 20000 });
    const out = `${listed.stdout || ""}${listed.stderr || ""}`;
    const ok = MCP_MARKERS.test(out) || out.includes(MCP_NAME);
    results.push({ agent: "grok", status: ok ? "PASS" : "WARN", detail: ok ? "Roblox Studio MCP registered" : "not registered; run: rbx-playtest register --agents grok" });
  } else {
    results.push({ agent: "grok", status: "SKIP", detail: "grok CLI not installed" });
  }
  const cursorFile = path.join(home, ".cursor", "mcp.json");
  if (existsSync(path.join(home, ".cursor"))) {
    const ok = MCP_MARKERS.test(readText(cursorFile) || "");
    results.push({ agent: "cursor", status: ok ? "PASS" : "WARN", detail: ok ? cursorFile : "not in ~/.cursor/mcp.json; run: rbx-playtest register --agents cursor" });
  } else {
    results.push({ agent: "cursor", status: "SKIP", detail: "~/.cursor missing" });
  }
  const codexFile = path.join(home, ".codex", "config.toml");
  if (existsSync(path.join(home, ".codex"))) {
    const ok = MCP_MARKERS.test(readText(codexFile) || "");
    results.push({ agent: "codex", status: ok ? "PASS" : "WARN", detail: ok ? codexFile : "not in ~/.codex/config.toml; run: rbx-playtest register --agents codex" });
  } else {
    results.push({ agent: "codex", status: "SKIP", detail: "~/.codex missing" });
  }
  const claudeFile = path.join(home, ".claude.json");
  if (existsSync(claudeFile) || existsSync(path.join(home, ".claude"))) {
    const ok = MCP_MARKERS.test(readText(claudeFile) || "");
    results.push({ agent: "claude", status: ok ? "PASS" : "WARN", detail: ok ? claudeFile : "not in ~/.claude.json; run: rbx-playtest register --agents claude" });
  } else {
    results.push({ agent: "claude", status: "SKIP", detail: "Claude Code not installed" });
  }
  return results;
}

function skillInstalls() {
  const home = os.homedir();
  const homes = {
    grok: path.join(home, ".grok", "skills"),
    codex: path.join(home, ".codex", "skills"),
    claude: path.join(home, ".claude", "skills"),
    cursor: path.join(home, ".cursor", "skills"),
    agents: path.join(home, ".agents", "skills"),
  };
  return Object.entries(homes)
    .filter(([, dir]) => existsSync(path.dirname(dir)))
    .map(([agent, dir]) => {
      const ok = existsSync(path.join(dir, "roblox-playtest", "SKILL.md"));
      return { agent, status: ok ? "PASS" : "WARN", detail: ok ? path.join(dir, "roblox-playtest") : "skill not installed; run: node install.mjs" };
    });
}

function cmdRegister(ctx) {
  const home = os.homedir();
  const dry = Boolean(ctx.flags["dry-run"]);
  const wanted = typeof ctx.flags.agents === "string" ? ctx.flags.agents.split(",").map((s) => s.trim()) : ["grok", "cursor", "codex", "claude"];
  const spec = launcherSpec();
  const current = Object.fromEntries(agentRegistrations().map((r) => [r.agent, r]));
  let failed = false;
  const say = (agent, text) => console.log(`${agent.padEnd(7)} ${dry ? "[dry-run] " : ""}${text}`);

  for (const agent of wanted) {
    if (current[agent]?.status === "PASS") { say(agent, "already registered"); continue; }
    if (current[agent]?.status === "SKIP") { say(agent, `skipped (${current[agent].detail})`); continue; }
    try {
      if (agent === "grok") {
        const args = ["mcp", "add", "-s", "user", MCP_NAME, spec.command, "--", ...spec.args];
        say(agent, `${grokExe()} ${args.join(" ")}`);
        if (!dry) execFileSync(grokExe(), args, { stdio: "inherit" });
      } else if (agent === "cursor") {
        const file = path.join(home, ".cursor", "mcp.json");
        const json = JSON.parse(readText(file) || "{}");
        json.mcpServers = { ...(json.mcpServers || {}), [MCP_NAME]: { command: spec.command, args: spec.args } };
        say(agent, `write ${file}`);
        if (!dry) writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
      } else if (agent === "codex") {
        const file = path.join(home, ".codex", "config.toml");
        const lit = (s) => `'${s}'`;
        const block = `\n[mcp_servers.${MCP_NAME}]\ncommand = ${lit(spec.command)}\nargs = [${spec.args.map(lit).join(", ")}]\n`;
        say(agent, `append [mcp_servers.${MCP_NAME}] to ${file}`);
        if (!dry) appendFileSync(file, block);
      } else if (agent === "claude") {
        const claude = which("claude");
        if (claude) {
          const args = ["mcp", "add", "-s", "user", MCP_NAME, "--", spec.command, ...spec.args];
          say(agent, `claude ${args.join(" ")}`);
          if (!dry) execFileSync(claude, args, { stdio: "inherit", shell: process.platform === "win32" });
        } else {
          const file = path.join(home, ".claude.json");
          const json = JSON.parse(readText(file) || "{}");
          json.mcpServers = { ...(json.mcpServers || {}), [MCP_NAME]: { type: "stdio", command: spec.command, args: spec.args } };
          say(agent, `write ${file}`);
          if (!dry) writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
        }
      } else {
        say(agent, "unknown agent");
        failed = true;
      }
    } catch (err) {
      say(agent, `FAILED: ${err.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// ---------- main ----------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...args] = positional;
  if (!command || command === "help" || flags.help) {
    const self = readText(new URL(import.meta.url)) || "";
    console.log(self.split("\n").filter((l) => l.startsWith("//")).slice(0, 24).map((l) => l.slice(3)).join("\n"));
    return 0;
  }
  const ctx = { ...loadConfig(flags), flags };
  switch (command) {
    case "doctor": return cmdDoctor(ctx);
    case "sync": return cmdSync(ctx);
    case "play": return cmdPlay(ctx, true);
    case "stop": return cmdPlay(ctx, false);
    case "status": return cmdHook(ctx, ctx.config.devHook.status, []);
    case "hook": return cmdHook(ctx, args[0], args.slice(1));
    case "smoke": return cmdSmoke(ctx);
    case "report": return cmdReport(ctx);
    case "nav": return cmdNav(ctx, args);
    case "keys": return cmdKeys(ctx, args);
    case "click": return cmdClick(ctx, args);
    case "probe": return cmdProbe(ctx, args[0], args.slice(1));
    case "shot": return cmdShot(ctx, args[0]);
    case "console": return cmdConsole(ctx);
    case "register": return cmdRegister(ctx);
    default:
      console.error(`unknown command: ${command}`);
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(`rbx-playtest: ${err.message}`);
      process.exitCode = err.code === "TIMEOUT" ? 3 : 2;
    },
  );
}
