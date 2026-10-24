import { readFile } from "node:fs/promises";

const auth = JSON.parse(await readFile(".local/mcp-tokens.json", "utf8"));
const [name, args = "{}"] = process.argv.slice(2);
if (!name) throw new Error("Usage: node scripts/mcp-call.mjs tool_name '{...}'");
const response = await fetch(`${auth.origin}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${auth.access_token}`,
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "tools/call",
    "Mcp-Name": name,
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: JSON.parse(args),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "operator", version: "1" },
      },
    },
  }),
});
const data = await response.json();
// This is an explicit owner inbox read; do not redirect output into technical logs.
console.log(JSON.stringify(data, null, 2));
