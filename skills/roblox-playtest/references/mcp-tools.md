# Roblox Studio MCP tools

Roblox Studio ships an MCP server (`StudioMCP.exe`, launched by `%LOCALAPPDATA%\Roblox\mcp.bat` on
Windows, `RobloxStudio.app/Contents/MacOS/StudioMCP` on macOS). It speaks stdio MCP. Each client process
gets its own proxy, so an editor's MCP connection and `rbx-playtest` can run at the same time.

Every tool takes `studio_id` (from `list_roblox_studios`; it changes when Studio restarts). The shell
runner fills it in from `studioMatch` in the project config.

## Tools the protocol uses

| Tool | Arguments | Use | Shell equivalent |
| --- | --- | --- | --- |
| `list_roblox_studios` | none | Find the Studio id; `name` includes the place name and `placeId` | `rbx-mcp studios` |
| `get_studio_state` | `studio_id` | Mode and data models: `Edit` alone means Edit mode; `Server, Client` means playing | `rbx-mcp state` |
| `start_stop_play` | `studio_id`, `is_start` | Start/stop play. Can time out while play does start: poll `get_studio_state` instead of retrying | `rbx-playtest play` / `stop` |
| `execute_luau` | `studio_id`, `datamodel_type` (`Edit`/`Server`/`Client`), `code` | Run Luau; `return` a string to read results. Errors come back as tool errors | `rbx-mcp luau Server '<code>'` |
| `get_console_output` | `studio_id` | The Output window text | `rbx-playtest console --grep X --tail N` |
| `character_navigation` | `studio_id`, `datamodel_type: Client`, `x,y,z` or `instance_path`, `speed_multiplier` | Walk the player's character (pathfinding) | `rbx-playtest nav x y z` |
| `user_keyboard_input` | `studio_id`, `datamodel_type: Client`, `actions[]` (`keyDown`/`keyUp`/`keyPress`/`textInput`/`wait`, `key_code` = Enum.KeyCode name) | Game input without touching the desktop | `rbx-playtest keys W:800 Space` |
| `user_mouse_input` | `studio_id`, `datamodel_type: Client`, `actions[]` (`moveTo` with `x,y` or `instance_path`, `mouseButtonClick`, `scrollUp`...) | Click GUI buttons by path, e.g. `LocalPlayer.PlayerGui.Menu.Play` | `rbx-playtest click <path>` |
| `screen_capture` | `studio_id`, `capture_id`, optional `camera_position`/`look_at_position` | Image of the game view. In play it includes ScreenGuis; in Edit it is the 3D viewport | `rbx-playtest shot out.png` |

Also available, not needed for testing: `script_read`, `script_grep`, `script_search`, `search_game_tree`,
`inspect_instance`, `multi_edit`, `insert_asset`, `search_asset`, `generate_*`, `upload_image`, `store_image`,
`http_get`, `subagent`, `skill`, `wait_job_finished`.

## Gotchas

- `execute_luau` requires `datamodel_type`. Game services, the dev hook and players live in `Server`;
  `Edit` is the saved place (what Rojo syncs into); `Client` is the local player's view.
- Requiring the game's framework (Knit, etc.) from `execute_luau` often fails. Go through the dev hook.
  Requiring a plain ModuleScript in the `Client` model does work (handy for showing a sample UI).
- After play starts the server needs a few seconds; "Target is not reachable" means retry shortly.
- `get_studio_state` can lag behind reality for up to ~30 s on heavy places. Check twice before
  pressing Play again; a second start during play is ignored or toggles it off.
- With StreamingEnabled the client may not have far-away instances yet. Poll, don't assume.
- Long-running Luau blocks the tool call. Start long work with `task.spawn` and poll for results.

## Registering the server per agent

| Agent | Where | Entry |
| --- | --- | --- |
| Grok CLI | `~/.grok/config.toml` | `grok mcp add -s user Roblox_Studio cmd.exe -- /c %LOCALAPPDATA%\Roblox\mcp.bat` |
| Cursor | `~/.cursor/mcp.json` | `"Roblox_Studio": {"command": "cmd.exe", "args": ["/c", "...\\Roblox\\mcp.bat"]}` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.Roblox_Studio]` with `command = 'cmd.exe'`, `args = ['/c', '...\Roblox\mcp.bat']` |
| Claude Code | `~/.claude.json` | `claude mcp add -s user Roblox_Studio -- cmd.exe /c ...\Roblox\mcp.bat` |
| Workhorse / CI / anything with a shell | none | Use `rbx-mcp.mjs` / `rbx-playtest.mjs`; no registration needed |

`rbx-playtest register` writes these for you (`--dry-run` shows what it would do). On macOS the command is
the StudioMCP path with no args.
