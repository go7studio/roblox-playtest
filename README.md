# roblox-playtest

An agent-agnostic skill for testing and walking Roblox experiences in Roblox Studio. One protocol and one
CLI that work the same from the Grok terminal, Go7 Workhorse, Cursor, Codex, Claude Code, or CI.

- **Doctor**: proves the stack is ready (Studio MCP, the right place open, Rojo, synced code, agent setup).
- **Play / stop** with no keystrokes or window focus: everything goes through Roblox's Studio MCP.
- **Drive** the game through a Studio-only dev hook.
- **Smoke**: runs the game's in-game checks and writes a verdict (`pass`, `flaky`, `fail`, `blocked`,
  `timeout`) to `.playtest/report.json`.
- **Walk** like a player: move, press keys, click GUI, read the client, take screenshots.

Nothing to install beyond Node 18+ and Roblox Studio. No npm dependencies.

## Quick start

```sh
git clone https://github.com/go7studio/roblox-playtest
node roblox-playtest/install.mjs            # copy the skill into ~/.grok, ~/.codex, ~/.claude, ~/.cursor, ~/.agents
cd path/to/your-game                        # has .roblox-playtest.json (see templates/)
node ~/.grok/skills/roblox-playtest/scripts/rbx-playtest.mjs doctor
node ~/.grok/skills/roblox-playtest/scripts/rbx-playtest.mjs smoke --targets "Level1"
```

Register the Studio MCP for agents that can call MCP tools directly (optional; the CLI doesn't need it):

```sh
node .../rbx-playtest.mjs register --dry-run
node .../rbx-playtest.mjs register --agents grok
```

## Using it from each agent

| Agent | How |
| --- | --- |
| Grok CLI | The skill shows up in `/skills` after `install.mjs`. Grok runs the CLI from its shell; with `register --agents grok` it can also call the Studio tools itself. |
| Go7 Workhorse | Settings > Skills > **Import** `skills/roblox-playtest` from this repo. Workers use the CLI; reports land in the game repo's `.playtest/`. |
| Cursor / Codex / Claude Code | `install.mjs` puts the skill in their skill folders; `register` adds the MCP server. |
| CI or scripts | Call the CLI and use its exit code: 0 pass, 1 fail, 2 blocked, 3 timeout. Studio must be open on that machine. |

## Adding a game

1. Copy `skills/roblox-playtest/templates/roblox-playtest.example.json` to the game repo root as
   `.roblox-playtest.json`.
2. Add the dev hook, smoke harness and (optionally) client probe from `templates/`.
3. Add `.playtest/` to the game's `.gitignore`.
4. `rbx-playtest doctor` until every gate passes.

The contract is in [skills/roblox-playtest/references/project-contract.md](skills/roblox-playtest/references/project-contract.md).

## Layout

```
install.mjs                         copy/link the skill into agent homes
skills/roblox-playtest/
  SKILL.md                          the protocol agents follow
  references/                       MCP tools, walking checklist, project contract
  scripts/rbx-playtest.mjs          the CLI (doctor, sync, play, smoke, walk, register)
  scripts/rbx-mcp.mjs               raw Studio MCP calls from a shell
  scripts/lib/mcp.mjs               the MCP stdio client
  templates/                        config, DevHook, SmokeHarness, DevProbe
test/                               offline tests (node --test)
```

## License

MIT
