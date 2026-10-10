--[[
	DevProbe (template): lets server-side tests (and agents via `rbx-playtest probe`) read what this
	client sees and press its buttons. LocalScript in StarterPlayerScripts. Studio only.

	DevHook.server.luau creates ReplicatedStorage.DevProbe (a RemoteFunction) in Studio.

	rbx-playtest probe hud                  -> which HUD pieces are visible
	rbx-playtest probe press Menu.Play      -> fires that button's click code
]]

local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

if not RunService:IsStudio() then
	return
end

local player = Players.LocalPlayer
local remote = ReplicatedStorage:WaitForChild("DevProbe", 60)
if not remote then
	return
end

local function findGui(path)
	local node = player:WaitForChild("PlayerGui")
	for segment in string.gmatch(path, "[^%.]+") do
		node = node and node:FindFirstChild(segment)
	end
	return node
end

local actions = {}

-- Visible ScreenGuis and their direct visible children
function actions.hud()
	local out = {}
	for _, gui in ipairs(player.PlayerGui:GetChildren()) do
		if gui:IsA("ScreenGui") and gui.Enabled then
			local shown = {}
			for _, child in ipairs(gui:GetChildren()) do
				if child:IsA("GuiObject") and child.Visible then
					table.insert(shown, child.Name)
				end
			end
			out[gui.Name] = shown
		end
	end
	return out
end

-- Runs a button's click code. Scripts can't fire another script's Activated connections, so the game's
-- UI code must expose its handler (e.g. a Menu:Press(button) that every button's Activated calls).
-- For a true mouse click use `rbx-playtest click LocalPlayer.PlayerGui.<path>` instead.
function actions.press(path)
	local button = findGui(path)
	if not (button and button:IsA("GuiButton")) then
		return { ok = false, error = "no button at " .. tostring(path) }
	end
	-- TODO: require the game's UI controller and call its press handler, e.g. Menu:Press(button)
	return { ok = false, error = "press not wired; see DevProbe template" }
end

-- TODO: game-specific reads: currency shown, open menus, current callout text, layout audit

remote.OnClientInvoke = function(action, ...)
	local handler = actions[action]
	if not handler then
		return { ok = false, error = "unknown action " .. tostring(action) }
	end
	local ok, result = pcall(handler, ...)
	return ok and result or { ok = false, error = tostring(result) }
end
