---
name: roblox-playtest
description: >
  Test and walk a Roblox experience in Roblox Studio from any agent (Grok terminal, Workhorse,
  Cursor, Codex, Claude Code, CI). Preflights the stack (Studio MCP, Rojo, sync), starts and stops
  play without keystrokes, drives the game through a Studio-only dev hook, runs the in-game smoke
  test, walks the game like a player (move, press keys, click GUI, screenshots), and writes a
  machine-readable verdict (go7-roblox-playtest/report-v1). Use when the user says playtest, smoke
  test, test the Roblox game, walk the game, check the place, verify before publish, Studio MCP,
  or runs /roblox-playtest.
---

# Roblox playtest

One protocol for every agent. Each step has two transports that do the same thing:

- **Shell** (works everywhere, including agents with no MCP): `node <skill>/scripts/rbx-playtest.mjs <command>`.
  It talks to Roblox's StudioMCP itself, so it needs no MCP client and never sends OS keystrokes.
- **MCP** (agents with the `Roblox_Studio` server registered): call the Studio tools directly.
  Tool names and arguments: [references/mcp-tools.md](references/mcp-tools.md).

`<skill>` is this folder. Below, `rbx-playtest` means `node <skill>/scripts/rbx-playtest.mjs`.
Run commands from the game repo; the runner finds `.roblox-playtest.json` by walking up from the
working directory (`--project <dir>` overrides).

## Ground rules

- Never ask the user to press Play or Stop. Use `play` / `stop` (or MCP `start_stop_play`).
- Never send desktop keystrokes or clicks; they land in whatever window is in front. Game input goes
  through `keys` / `click` / `nav`, which the MCP injects into the Studio client only.
- Rojo syncs only in Edit mode. After editing code: `stop`, wait ~4 s, `sync` (proves the source landed), then `play`.
- Test data must not touch live stores. Projects keep a Studio mock-data switch; leave it off unless
  the test is about live data, and turn it back off after.
- Don't start a smoke run while another agent is play-testing the same Studio. One Studio, one driver.
- A claim like "it works" needs a gate that proves it: a PASS line, a report verdict, or a screenshot.
  "I changed the code" is not a verdict.

## The loop

| Step | Shell | Proves |
| --- | --- | --- |
| 1. Doctor | `rbx-playtest doctor` | Node, StudioMCP launcher, Studio connected (right place), MCP tools, Rojo serving the right project, synced source matches disk, agent MCP registrations, skill installs |
| 2. Sync | `rbx-playtest sync` | Studio in Edit, the configured script's Source equals the file on disk |
| 3. Play | `rbx-playtest play` | Server + Client data models are up and the dev hook answers |
| 4. Drive | `rbx-playtest status`, `hook <cmd> [args]` | Game state, and any setup the test needs (queue, force a level, grant an item) |
| 5. Walk | `nav`, `keys`, `click`, `probe`, `shot`, `console` | What a player sees and can do; see [references/walking.md](references/walking.md) |
| 6. Verify | `rbx-playtest smoke [--targets "A B"]` | Every in-game check; verdict + `.playtest/report.json` |
| 7. Report | `rbx-playtest report` | Last verdict, failures marked FLAKY or FAIL |
| 8. Stop | `rbx-playtest stop` | Back in Edit, so Rojo can sync the next change |

Exit codes for every command: `0` pass, `1` fail, `2` blocked (a gate failed before the test ran),
`3` timeout. Add `--json` to `doctor`, `smoke` and `report` for machine output.

## Verdicts

`smoke` ends with one verdict, written to `.playtest/report.json` and appended to `.playtest/history.jsonl`:

- `pass`: no FAIL lines.
- `flaky`: every FAIL matches `smoke.knownFlaky` in the config. Exit 0, but list them in the report.
- `fail`: at least one FAIL that isn't known flaky. Fix it or prove it flaky (rerun once, fresh play
  session; if it passes and the cause is test-made, add it to `knownFlaky` with a reason in the PR).
- `blocked`: Rojo down, source out of sync, play didn't start, or the dev hook never appeared.
  Fix the gate named in `gates[]`; don't report game bugs from a blocked run.
- `timeout`: no `DONE` line in time. Read `console --grep SMOKE --tail 40` for the last check that ran.

A rerun after a code change must start from step 2. A second smoke start while one runs is ignored by
most harnesses and returns a stale report.

## Walking (playing like a player)

Smoke proves the systems; walking proves the experience. After the smoke run passes (or when the user asks
to "walk" or "try" the game), do a first-time-player pass from [references/walking.md](references/walking.md):
title screen, first match, a loss, a win, the shop, the end card, phone layout. Take a `shot` at each
step and look at it. Report what a kid would find confusing, not just what errored.

## Setting up a new game

1. Copy [templates/roblox-playtest.example.json](templates/roblox-playtest.example.json) to the repo
   root as `.roblox-playtest.json` and fill in the ids.
2. Add [templates/DevHook.server.luau](templates/DevHook.server.luau) (Studio-only `BindableFunction`) and
   [templates/SmokeHarness.luau](templates/SmokeHarness.luau) (ModuleScript with `Run` / `GetReport`).
3. Optionally add [templates/DevProbe.client.luau](templates/DevProbe.client.luau) so tests can read and
   press the client's UI.
4. `rbx-playtest doctor` until every gate is PASS, then `smoke`.

The full contract (config keys, hook commands, report line format, report JSON) is in
[references/project-contract.md](references/project-contract.md).

## Agent setup

- Install the skill into every agent home: `node install.mjs` from the repo root of roblox-playtest.
- Register the Studio MCP for agents that support it: `rbx-playtest register` (`--dry-run` first;
  `--agents grok,cursor,codex,claude` to limit). Grok: `grok mcp add -s user Roblox_Studio cmd.exe -- /c %LOCALAPPDATA%\Roblox\mcp.bat`.
- Workhorse: Settings > Skills > Import the `skills/roblox-playtest` folder from the repo. Workhorse
  workers can run the shell transport with no extra setup.
- Set `RBX_AGENT=<name>` so the report records who ran it.

## When it goes wrong

| Symptom | Fix |
| --- | --- |
| `studio.connected` FAIL | Studio closed, or a different place is open. Open the place; the Studio id changes on every restart. |
| `mcp.launcher` FAIL | Studio not installed or too old for MCP. Update Studio and turn on its MCP server. |
| `rojo.serving` FAIL | Start `rojo serve` in the game repo (use 127.0.0.1, not localhost). |
| `sync.source` FAIL | The Rojo plugin is disconnected or Studio was playing. Stop, reconnect the plugin, rerun `sync`. |
| `hook.ready` FAIL | The dev hook script is missing, errored on boot (`console --grep Error`), or waits for a framework that didn't start. |
| `start_stop_play` times out | Normal on heavy places; the runner polls state for 90 s. If still stuck, `stop`, then `play`. |
| Tool says "Target is not reachable" | The server is still booting. Wait 5 s and retry. |
| Screenshot is a 3D view with no GUI | `shot` was taken in Edit mode. Take it while playing. |
