--[[
	SmokeHarness (template): in-game automated run-through. ModuleScript in ServerScriptService/Dev.
	Started by the DevHook "smoke" command; read with "smokeReport".

	Report lines (also printed with a "[SMOKE] " prefix for log readers):
		PASS <name> <detail>  /  FAIL <name> <detail>  /  SKIP <name> <reason>
		DONE pass=N fail=M skip=K running=<true|false>

	Fill in the TODO hooks with the game's own checks. Add a check for every new feature.
]]

local Players = game:GetService("Players")

local SmokeHarness = {}

local results = {}
local totals = { pass = 0, fail = 0, skip = 0 }
local running = false

local function record(line)
	table.insert(results, line)
	print("[SMOKE] " .. line)
end

local function check(name, ok, detail)
	local status = ok and "PASS" or "FAIL"
	totals[ok and "pass" or "fail"] += 1
	record(("%s %s %s"):format(status, name, detail ~= nil and tostring(detail) or ""))
	return ok
end

local function skip(name, reason)
	totals.skip += 1
	record(("SKIP %s %s"):format(name, reason or ""))
end

-- Polls until fn() returns a truthy value or the timeout passes
local function waitFor(fn, timeout)
	local deadline = os.clock() + (timeout or 10)
	repeat
		local ok, value = pcall(fn)
		if ok and value then
			return value
		end
		task.wait(0.25)
	until os.clock() > deadline
	return nil
end

-- A check group that can't crash the run: errors become FAILs
local function guarded(name, fn)
	local ok, err = pcall(fn)
	if not ok then
		check(name, false, "error: " .. tostring(err))
	end
end

local function targetList(text)
	local list = {}
	for id in string.gmatch(text or "", "%S+") do
		table.insert(list, id)
	end
	if #list == 0 then
		-- TODO: return every level/arena/mode id from the game's config
	end
	return list
end

-- TODO: per-target checks. Start a round on this target, pin players, then verify the feature list.
local function runTargetChecks(targetId, player, opts)
	local prefix = targetId .. "."
	-- check(prefix .. "selected", Levels:GetCurrentId() == targetId, Levels:GetCurrentId())
	-- check(prefix .. "partBudget", partCount < 10000, "parts=" .. partCount)
	-- check(prefix .. "rewards", coinsAfter > coinsBefore, coinsAfter - coinsBefore)
	skip(prefix .. "todo", "fill in runTargetChecks")
end

-- TODO: global checks: lobby, shop purchase flow, economy, sounds, badges, layout audit.
local function runGlobalChecks(player, opts)
	skip("global.todo", "fill in runGlobalChecks")
end

function SmokeHarness.IsRunning()
	return running
end

function SmokeHarness.Run(opts)
	if running then
		return
	end
	running = true
	table.clear(results)
	totals = { pass = 0, fail = 0, skip = 0 }
	record("START targets=" .. tostring(opts and opts.targets or ""))

	local player = waitFor(function()
		return Players:GetPlayers()[1]
	end, 60)
	if check("player.joined", player ~= nil) then
		guarded("global", function()
			runGlobalChecks(player, opts)
		end)
		for _, targetId in ipairs(targetList(opts and opts.targets)) do
			guarded(targetId, function()
				runTargetChecks(targetId, player, opts)
			end)
		end
	end

	running = false
	record(("DONE pass=%d fail=%d skip=%d running=false"):format(totals.pass, totals.fail, totals.skip))
end

function SmokeHarness.GetReport()
	local body = {}
	for _, line in ipairs(results) do
		if not string.match(line, "^START") and not string.match(line, "^DONE") then
			table.insert(body, line)
		end
	end
	table.insert(body, ("DONE pass=%d fail=%d skip=%d running=%s"):format(totals.pass, totals.fail, totals.skip, tostring(running)))
	return table.concat(body, "\n")
end

return SmokeHarness
