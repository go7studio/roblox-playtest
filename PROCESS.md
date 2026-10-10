# Process

Rules for changing this repo.

## The skill stays agent-agnostic

- No agent-specific tool names in the protocol steps. Each step has a shell command and, where useful,
  the MCP tool it maps to. Agent differences live in `references/mcp-tools.md` and `install.mjs`.
- The CLI has no npm dependencies and runs on Node 18+. Windows first; keep macOS paths working.
- Never add OS keystrokes or window focus tricks. Studio input goes through the MCP only.

## Contract changes

- `go7-roblox-playtest/config-v1` and `report-v1` are read by other tools (Workhorse packs, CI). Adding
  optional fields is fine. Renaming or removing a field needs a new schema version and a note in the README.
- The report line format (`PASS|FAIL|SKIP name detail`, `DONE pass= fail= skip= running=`) is shared with
  every game's harness. Don't change it.

## Before a release

1. `node --test` passes (offline; tests must not read the machine's agent homes or need Studio).
2. On a machine with Studio open on a real game: `rbx-playtest doctor` all PASS, then `rbx-playtest smoke`
   reaches a verdict, and `play`, `status`, `stop` work.
3. Bump `version` in `package.json`, check the tag doesn't already exist (`git tag -l vX.Y.Z`), tag, push.
