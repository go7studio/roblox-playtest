#!/usr/bin/env node
// Raw Roblox Studio MCP access from a shell. For the full playtest protocol use rbx-playtest.mjs.
//
//   node rbx-mcp.mjs tools                                   list tool names
//   node rbx-mcp.mjs studios                                 list open Studio instances (ids change on restart)
//   node rbx-mcp.mjs state                                   Studio mode and data models
//   node rbx-mcp.mjs luau <Edit|Server|Client> '<code>'      run Luau (studio_id filled in automatically)
//   node rbx-mcp.mjs call <tool> '<json args>'               call any tool; studio_id is filled in if missing
//
// Env: RBX_STUDIO_ID, RBX_STUDIO_MATCH (place-name substring), RBX_MCP_CMD, RBX_MCP_TIMEOUT_MS.
// Exit codes: 0 ok, 1 tool returned an error, 2 transport/usage error, 3 timeout.

import { writeFileSync } from "node:fs";
import { connect } from "./lib/mcp.mjs";

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log("usage: rbx-mcp.mjs tools | studios | state | luau <Edit|Server|Client> '<code>' | call <tool> '<json>' [--save-image file.png]");
    return 0;
  }
  const client = await connect();
  try {
    if (command === "tools") {
      console.log((await client.tools()).join("\n"));
      return 0;
    }
    if (command === "studios") {
      console.log(JSON.stringify(await client.listStudios(), null, 2));
      return 0;
    }
    await client.pickStudio();
    if (command === "state") {
      console.log((await client.state()).raw);
      return 0;
    }
    let result;
    if (command === "luau") {
      const [datamodel, code] = rest;
      if (!datamodel || code === undefined) throw new Error("usage: luau <Edit|Server|Client> '<code>'");
      result = await client.luau(datamodel, code);
    } else if (command === "call") {
      const tool = rest[0];
      const args = rest[1] && !rest[1].startsWith("--") ? JSON.parse(rest[1]) : {};
      if (args.studio_id === undefined) args.studio_id = client.requireStudio();
      result = await client.call(tool, args);
      const saveAt = rest.indexOf("--save-image");
      if (saveAt >= 0 && result.images[0]) {
        writeFileSync(rest[saveAt + 1], Buffer.from(result.images[0].data, "base64"));
        console.error(`saved ${rest[saveAt + 1]}`);
      }
    } else {
      throw new Error(`unknown command ${command}`);
    }
    console.log(result.text);
    return result.isError ? 1 : 0;
  } finally {
    client.close();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(`rbx-mcp: ${err.message}`);
    process.exitCode = err.code === "TIMEOUT" ? 3 : 2;
  },
);
