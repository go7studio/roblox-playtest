--[[
	DevHook (template): Studio-only server hook so any agent can drive the game from execute_luau
	(Server data model), where requiring the game framework often fails.

		game.ServerStorage.DevHook:Invoke("status")
		game.ServerStorage.DevHook:Invoke("call", "MatchService", "ForceEndMatch")
		game.ServerStorage.DevHook:Invoke("call", "LobbyService", "AddToQueue", "@1")   -- "@1" = first player
		game.ServerStorage.DevHook:Invoke("pin", true)
		game.ServerStorage.DevHook:Invoke("smoke", "Level1 Level2")   -- starts SmokeHarness in the background
		game.ServerStorage.DevHook:Invoke("smokeReport")

	Put it in ServerScriptService as a Script. SmokeHarness (ModuleScript) sits next to it in a Dev folder.
	Add game-specific commands to `commands` (holdLobby, forceLevel, grant, spawnPickup...).
]]

local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")
local HttpService = game:GetService("HttpService")

if not RunService:IsStudio() then
	return
end

local SmokeHarness = require(script.Parent:WaitForChild("Dev"):WaitForChild("SmokeHarness"))

-- TODO: return the service table by name from the framework (e.g. Knit.GetService(name) after Knit starts)
local function getService(name)
	error("getService not wired: " .. tostring(name))
end

local function resolveArg(value)
	if type(value) == "string" then
		local index = string.match(value, "^@(%d+)$")
		if index then
			return Players:GetPlayers()[tonumber(index)]
		end
	end
	return value
end

local function describe(value)
	if typeof(value) == "Instance" then
		return value:GetFullName()
	elseif type(value) == "table" then
		local ok, json = pcall(HttpService.JSONEncode, HttpService, value)
		return ok and json or tostring(value)
	end
	return tostring(value)
end

local pinned = false

local commands = {}

function commands.status()
	local lines = {}
	-- TODO: add game phase, round timer, alive count, current level
	for _, player in ipairs(Players:GetPlayers()) do
		local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart")
		local humanoid = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
		table.insert(lines, ("player %s pos=%s hp=%s"):format(player.Name,
			root and tostring(root.Position) or "nil", humanoid and humanoid.Health or "nil"))
	end
	return table.concat(lines, "\n")
end

function commands.call(serviceName, methodName, ...)
	local service = getService(serviceName)
	local args = table.pack(...)
	for i = 1, args.n do
		args[i] = resolveArg(args[i])
	end
	return describe(service[methodName](service, table.unpack(args, 1, args.n)))
end

-- Anchors players so solo tests don't die before features can be checked
function commands.pin(on)
	pinned = on ~= false
	for _, player in ipairs(Players:GetPlayers()) do
		local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart")
		if root then
			root.Anchored = pinned
		end
	end
	return "pin=" .. tostring(pinned)
end

function commands.smoke(targets)
	if SmokeHarness.IsRunning() then
		return "smoke already running"
	end
	task.spawn(SmokeHarness.Run, { targets = targets, getService = getService, pin = commands.pin })
	return "smoke started"
end

function commands.smokeReport()
	return SmokeHarness.GetReport()
end

local hook = Instance.new("BindableFunction")
hook.Name = "DevHook"
hook.OnInvoke = function(command, ...)
	local handler = commands[command]
	if not handler then
		return "error: unknown command " .. tostring(command)
	end
	local ok, result = pcall(handler, ...)
	return ok and describe(result) or ("error: " .. tostring(result))
end
hook.Parent = ServerStorage

-- Answered by DevProbe.client.luau: lets tests read and press the client's UI
local probe = Instance.new("RemoteFunction")
probe.Name = "DevProbe"
probe.Parent = game:GetService("ReplicatedStorage")

print("[DevHook] ServerStorage.DevHook ready")
