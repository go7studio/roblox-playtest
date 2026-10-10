#!/usr/bin/env node
// Read-only feed for the "Roblox playtest" Workshop pack. Runs on the machine with Roblox Studio.
// Serves GET /workshop/roblox-playtest/feed (bearer required) from each project's .playtest/ folder,
// plus GET /healthz. Binds 127.0.0.1 only. Never starts, stops or writes anything in a project.
//
//   node playtest-feed.mjs --project D:\GitHub\MyGame [--project ...] [--port 8794] [--token-file <path>]
//   node playtest-feed.mjs --print --project D:\GitHub\MyGame        print the feed once and exit
//
// Projects can also be listed in ~/.go7/roblox-playtest-feed.json: { "projects": ["D:/GitHub/MyGame"] }.
// The token file is created with a random token if missing; give the same file to the Workhorse
// Local Compute host (base URL http://127.0.0.1:<port>).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "go7-roblox-playtest/feed-v1";
const FEED_PATH = "/workshop/roblox-playtest/feed";
const HISTORY_LINES = 40;
const VERDICT_WORDS = { pass: "pass", flaky: "pass (flaky)", fail: "FAIL", blocked: "blocked", timeout: "timed out" };

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function readHistory(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function projectDir(root) {
  const config = readJson(path.join(root, ".roblox-playtest.json")) || {};
  return { name: config.name || path.basename(root), dir: path.join(root, config.reportDir || ".playtest") };
}

function stamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "?" : d.toISOString().slice(0, 16).replace("T", " ");
}

export function buildFeed(projects, now = new Date()) {
  const runs = [];
  const latestByProject = [];
  for (const root of projects) {
    const { name, dir } = projectDir(root);
    const report = readJson(path.join(dir, "report.json"));
    for (const row of readHistory(path.join(dir, "history.jsonl"))) runs.push({ ...row, project: row.project || name });
    if (report) latestByProject.push({ ...report, project: report.project || name });
  }
  runs.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
  latestByProject.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  const latest = latestByProject[0] || null;

  const recent = runs.slice(-20);
  const passing = recent.filter((r) => r.verdict === "pass" || r.verdict === "flaky").length;
  let streak = 0;
  for (let i = runs.length - 1; i >= 0 && (runs[i].verdict === "pass" || runs[i].verdict === "flaky"); i--) streak++;

  const failures = latest?.failures || [];
  return {
    schema: SCHEMA,
    asOf: now.toISOString(),
    projects: projects.length,
    latest: latest && {
      project: latest.project,
      verdict: latest.verdict,
      verdictWord: VERDICT_WORDS[latest.verdict] || latest.verdict,
      ok: latest.verdict === "pass" || latest.verdict === "flaky",
      finishedAt: latest.finishedAt,
      durationMin: Math.round((latest.durationSec || 0) / 6) / 10,
      targets: latest.targets,
      agent: latest.agent,
      pass: latest.totals?.pass ?? 0,
      fail: latest.totals?.fail ?? 0,
      skip: latest.totals?.skip ?? 0,
      total: (latest.totals?.pass ?? 0) + (latest.totals?.fail ?? 0) + (latest.totals?.skip ?? 0),
      newFailures: latest.newFailures ?? 0,
      newFailureNames: failures.filter((f) => !f.knownFlaky).map((f) => f.name),
      flakyNames: failures.filter((f) => f.knownFlaky).map((f) => f.name),
      blockedGates: (latest.gates || []).filter((g) => g.status === "FAIL").map((g) => `${g.id}: ${g.detail}`.slice(0, 160)),
    },
    projectLines: latestByProject.map((r) => `${r.project}  ${VERDICT_WORDS[r.verdict] || r.verdict}  ${r.totals?.pass ?? 0}/${r.totals?.fail ?? 0}/${r.totals?.skip ?? 0}  ${stamp(r.finishedAt)}`),
    recent: { runs: recent.length, passing, streak },
    historyLog: runs.slice(-HISTORY_LINES).reverse().map((r) =>
      `${stamp(r.finishedAt)}  ${r.project}  ${VERDICT_WORDS[r.verdict] || r.verdict}  pass ${r.totals?.pass ?? 0} fail ${r.totals?.fail ?? 0}  ${r.targets || ""}  (${r.agent || "?"})`),
  };
}

function args() {
  const argv = process.argv.slice(2);
  const out = { projects: [], port: 8794, tokenFile: path.join(os.homedir(), ".go7", "roblox-playtest-feed.token"), print: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") out.projects.push(path.resolve(argv[++i]));
    else if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--token-file") out.tokenFile = path.resolve(argv[++i]);
    else if (argv[i] === "--print") out.print = true;
  }
  const listed = readJson(path.join(os.homedir(), ".go7", "roblox-playtest-feed.json"));
  for (const p of listed?.projects || []) out.projects.push(path.resolve(p));
  out.projects = [...new Set(out.projects)];
  return out;
}

function loadToken(file) {
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
    console.log(`created token file ${file}`);
  }
  return readFileSync(file, "utf8").trim();
}

function authorized(header, token) {
  const given = Buffer.from(String(header || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function main() {
  const opts = args();
  if (opts.projects.length === 0) {
    console.error("no projects: pass --project <game repo> or list them in ~/.go7/roblox-playtest-feed.json");
    process.exit(2);
  }
  if (opts.print) {
    console.log(JSON.stringify(buildFeed(opts.projects), null, 2));
    return;
  }
  const token = loadToken(opts.tokenFile);
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: "GET only" });
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/healthz") return send(200, { ok: true });
    if (!authorized(req.headers.authorization, token)) return send(401, { error: "unauthorized" });
    if (url.pathname === FEED_PATH) return send(200, buildFeed(opts.projects));
    return send(404, { error: "not found" });
  });
  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`roblox-playtest feed on http://127.0.0.1:${opts.port}${FEED_PATH} for ${opts.projects.length} project(s)`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
