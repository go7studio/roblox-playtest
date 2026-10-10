// Minimal Roblox Studio MCP client. No dependencies.
// Speaks MCP stdio (newline-delimited JSON-RPC) to Roblox's StudioMCP launcher, so any agent with a
// shell can drive Studio, even one with no MCP support of its own. It runs alongside an editor's own
// MCP connection; each process gets its own StudioMCP proxy.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TIMEOUT_MS = Number(process.env.RBX_MCP_TIMEOUT_MS || 120000);

export function mcpLauncher() {
  if (process.env.RBX_MCP_CMD) {
    return { cmd: process.env.RBX_MCP_CMD, args: [], shell: true, path: process.env.RBX_MCP_CMD };
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const bat = path.join(local, "Roblox", "mcp.bat");
    return { cmd: "cmd.exe", args: ["/c", bat], shell: false, path: bat };
  }
  const mac = "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
  return { cmd: mac, args: [], shell: false, path: mac };
}

export function launcherExists() {
  const { path: file } = mcpLauncher();
  return process.env.RBX_MCP_CMD ? true : existsSync(file);
}

export class StudioMcp {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const { cmd, args, shell } = mcpLauncher();
    this.timeoutMs = timeoutMs;
    this.proc = spawn(cmd, args, { shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.studio = null;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.proc.on("exit", (code) => this.failAll(new Error(`StudioMCP exited (${code}). ${this.stderr.trim().slice(-400)}`)));
    this.proc.on("error", (err) => this.failAll(err));
  }

  failAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || !this.pending.has(message.id)) continue;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`Timed out after ${timeoutMs} ms waiting for ${method}${params?.name ? " " + params.name : ""}`);
        err.code = "TIMEOUT";
        reject(err);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async init() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "roblox-playtest", version: "1.0.0" },
    }, 30000);
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    return this;
  }

  async tools() {
    const result = await this.request("tools/list", {});
    return (result.tools || []).map((t) => t.name);
  }

  // Raw tool call. Returns { text, images, isError }.
  async call(name, args = {}, timeoutMs) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const content = result?.content || [];
    return {
      text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      images: content.filter((c) => c.type === "image"),
      isError: result?.isError === true,
    };
  }

  async listStudios() {
    const { text } = await this.call("list_roblox_studios", {});
    try {
      return JSON.parse(text).studios || [];
    } catch {
      return [...text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((m) => ({ id: m[0], name: "" }));
    }
  }

  // Picks the Studio to drive: RBX_STUDIO_ID, else the first whose name contains `match`, else the only one.
  async pickStudio(match) {
    if (process.env.RBX_STUDIO_ID) {
      this.studio = { id: process.env.RBX_STUDIO_ID, name: "(RBX_STUDIO_ID)" };
      return this.studio;
    }
    const studios = await this.listStudios();
    const wanted = match || process.env.RBX_STUDIO_MATCH;
    const found = wanted
      ? studios.find((s) => (s.name || "").toLowerCase().includes(String(wanted).toLowerCase()))
      : studios[0];
    this.studio = found || null;
    this.studios = studios;
    return this.studio;
  }

  requireStudio() {
    if (!this.studio) throw new Error("No matching Roblox Studio is connected to the MCP");
    return this.studio.id;
  }

  // { mode: "Edit"|"Play"|..., datamodels: ["Edit"] | ["Server","Client"], raw }
  async state() {
    const { text } = await this.call("get_studio_state", { studio_id: this.requireStudio() }, 30000);
    const mode = (text.match(/Current Studio Mode:\s*(\S+)/) || [])[1] || "Unknown";
    const models = ((text.match(/Available DataModels:\s*([^\n]+)/) || [])[1] || "")
      .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return { mode, datamodels: models, raw: text };
  }

  async luau(datamodel, code, timeoutMs) {
    return this.call("execute_luau", { studio_id: this.requireStudio(), datamodel_type: datamodel, code }, timeoutMs);
  }

  async setPlaying(on, timeoutMs = 60000) {
    return this.call("start_stop_play", { studio_id: this.requireStudio(), is_start: on }, timeoutMs);
  }

  close() {
    try { this.proc.stdin.end(); } catch {}
    setTimeout(() => { try { this.proc.kill(); } catch {} }, 300).unref();
  }
}

export async function connect(opts) {
  const client = new StudioMcp(opts);
  await client.init();
  return client;
}
