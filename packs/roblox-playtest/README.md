# Roblox playtest pack

A read-only Workshop module for Go7 Workhorse. It paints the latest `rbx-playtest smoke` verdict for each
game: pass/fail counts, new failures, known flakes, blocked gates, and the run history.

| Card | Shows |
| --- | --- |
| Strip | Verdict word, game, how long ago |
| Last run | Pass / fail, % of checks passing, new failures (chips), known flakes, blocked gates, targets, who ran it, minutes |
| Games | One line per game: verdict, pass/fail/skip, when |
| History | Last 40 runs across games, recent pass count, passing streak |

## 1. Run the collector (on the machine with Roblox Studio)

```sh
node packs/roblox-playtest/collector/playtest-feed.mjs --project D:/GitHub/MyGame --project D:/GitHub/OtherGame
```

- Serves `http://127.0.0.1:8794/workshop/roblox-playtest/feed` (bearer required) and `/healthz`.
- Creates `~/.go7/roblox-playtest-feed.token` on first run.
- Reads each game's `.playtest/report.json` and `.playtest/history.jsonl` (written by `rbx-playtest smoke`).
  It never writes to a game or touches Studio.
- Projects can live in `~/.go7/roblox-playtest-feed.json` instead: `{ "projects": ["D:/GitHub/MyGame"] }`.
- Check it: `node playtest-feed.mjs --print --project D:/GitHub/MyGame`.

To keep it running on Windows, add a Task Scheduler task "At log on" running
`node <path>\playtest-feed.mjs` (projects from the JSON file).

## 2. Add the host and the pack (Workhorse)

1. Settings > Local Compute > **Add host**: base URL `http://127.0.0.1:8794`, token file
   `~/.go7/roblox-playtest-feed.token`.
2. Settings > Skills > Workshop > **Add pack** > paste `https://github.com/go7studio/roblox-playtest`.
   Confirm the URL shown is `http://127.0.0.1:8794/workshop/roblox-playtest/feed` and pick the host above.

The feed's `asOf` is the collector's clock, so the module goes stale (paints `—`) only when the collector
stops, not when no test has run for a while. Run age is shown separately.

## Feed (`go7-roblox-playtest/feed-v1`)

`latest { project, verdict, verdictWord, ok, finishedAt, durationMin, targets, agent, pass, fail, skip,
total, newFailures, newFailureNames[], flakyNames[], blockedGates[] }`, `projectLines[]`,
`recent { runs, passing, streak }`, `historyLog[]`, `projects`, `asOf`, `schema`.
