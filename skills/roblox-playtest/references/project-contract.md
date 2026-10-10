# Project contract

What a game repo provides so any agent can test it the same way.

## `.roblox-playtest.json` (repo root)

```json
{
  "schema": "go7-roblox-playtest/config-v1",
  "name": "MyGame",
  "placeId": 123,
  "universeId": 456,
  "studioMatch": "placeId: 123",
  "rojo": { "port": 34872, "projectName": "MyGame" },
  "syncCheck": { "file": "src/ServerScriptService/DevHook.server.luau", "instance": "game.ServerScriptService.DevHook" },
  "devHook": { "path": "game.ServerStorage.DevHook", "status": "status", "smoke": "smoke", "report": "smokeReport" },
  "probe": { "path": "game.ReplicatedStorage.DevProbe" },
  "smoke": { "targets": "", "timeoutSec": 1200, "pollSec": 5, "knownFlaky": [] },
  "reportDir": ".playtest"
}
```

| Key | Meaning |
| --- | --- |
| `studioMatch` | Substring of the Studio name in `list_roblox_studios` (defaults to `placeId: <placeId>`). Picks the right Studio when several are open. |
| `rojo` | Omit if the game doesn't use Rojo. `projectName` must equal the `name` in the Rojo project file. |
| `syncCheck` | One synced script: its file on disk and its instance path in the place. Proves Rojo landed the latest code. Pick a file that changes often. |
| `devHook` | The Studio-only `BindableFunction` and its command names. |
| `probe` | Optional `RemoteFunction` the client answers (`OnClientInvoke`) so tests can read and press UI. |
| `smoke.targets` | Default targets (levels, arenas, modes), space-separated. Empty = harness decides (usually all). |
| `smoke.knownFlaky` | Check-name globs whose FAILs don't fail the run. `*` matches anything; a pattern matches the whole name or any dotted suffix (`bots.*` matches `HexHive.bots.chase`). Each entry needs a reason in the PR that added it. |
| `reportDir` | Where reports go. Add it to `.gitignore`. |

## Dev hook (server, Studio only)

A `BindableFunction` created at runtime when `RunService:IsStudio()`. Must answer:

| Command | Returns |
| --- | --- |
| `status` | Multi-line text: game phase, players, positions, anything a tester needs at a glance |
| `smoke`, targets | Starts the smoke run in the background (`task.spawn`) and returns at once |
| `smokeReport` | The report so far, in the line format below |

Useful extras (name them in the project's own docs): `call <Service> <Method> args...` with `"@1"` = first
player, `pin true|false` (anchor players so solo tests don't die), hold/skip phases, force a level, grant
items. Template: `templates/DevHook.server.luau`.

## Report line format

```
PASS <name> <detail>
FAIL <name> <detail>
SKIP <name> <reason>
DONE pass=<n> fail=<n> skip=<n> running=<true|false>
```

`<name>` has no spaces; use dots for grouping (`Arena1.rewards.coins`). `running=true` while the run is going.
The runner treats the run as finished when `DONE` shows at least one result and `running` isn't `true`.
The harness should also `print("[SMOKE] " .. line)` each line so a log-tailing runner can follow along.

## Report JSON (`.playtest/report.json`)

```json
{
  "schema": "go7-roblox-playtest/report-v1",
  "project": "MyGame",
  "placeId": 123,
  "agent": "grok",
  "command": "smoke",
  "targets": "Arena1",
  "startedAt": "2026-10-10T18:00:00.000Z",
  "finishedAt": "2026-10-10T18:06:12.000Z",
  "durationSec": 372,
  "verdict": "pass | flaky | fail | blocked | timeout",
  "totals": { "pass": 320, "fail": 1, "skip": 4 },
  "newFailures": 0,
  "failures": [{ "status": "FAIL", "name": "Arena1.parkour.gap", "detail": "...", "knownFlaky": true }],
  "gates": [{ "id": "sync.source", "status": "PASS", "detail": "..." }],
  "studio": { "id": "…", "name": "…" }
}
```

`history.jsonl` gets one line per run (the report without `failures`/`gates`, plus `failedNames`). It is
the feed for dashboards such as a Workhorse Workshop pack.

`agent` comes from `RBX_AGENT` (or `WORKHORSE_AGENT`).
