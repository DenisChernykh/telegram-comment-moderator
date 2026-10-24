import { readFile, writeFile } from "node:fs/promises";
import { localEnv } from "./local-env.mjs";

localEnv();
const auth = JSON.parse(await readFile(".local/mcp-tokens.json", "utf8"));
const origin = new URL(auth.origin).origin;
const results = [];
async function probe(name, path, init, expected) {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  const result = {
    name,
    status: response.status,
    round_trip_ms: Math.round(performance.now() - started),
    passed: response.status === expected,
  };
  results.push(result);
  return data;
}
await probe("health", "/health", undefined, 200);
await probe("unauthenticated_mcp", "/mcp", { method: "POST" }, 401);
await probe("no_openid_discovery", "/.well-known/openid-configuration", undefined, 404);
const ignored = await probe(
  "synthetic_outside_allowlist_webhook",
  "/telegram/webhook",
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": process.env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      update_id: 900000000,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -1000000000000, type: "supergroup" },
        from: { id: 1, is_bot: false },
        text: "Synthetic boundary probe; not a real Telegram comment.",
      },
    }),
  },
  200,
);
if (ignored.kind !== "outside_allowlist") throw new Error("Unexpected webhook admission");
async function rpc(method, params = {}) {
  return probe(
    method,
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.access_token}`,
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(params.name ? { "Mcp-Name": params.name } : {}),
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "remote-smoke", version: "1" },
          },
        },
      }),
    },
    200,
  );
}
const discovery = await rpc("server/discover");
const tools = await rpc("tools/list");
const events = await rpc("events/list");
const status = await rpc("tools/call", { name: "get_moderation_status", arguments: {} });
const report = {
  measured_at: new Date().toISOString(),
  origin,
  results,
  mcp2: discovery.result?.supportedVersions?.includes("2026-07-28") === true,
  tools: tools.result?.tools?.length ?? 0,
  events: events.result?.events?.length ?? 0,
  status_call_passed:
    !status.error &&
    !status.result?.isError &&
    ["dry_run", "manual", "auto"].includes(status.result?.structuredContent?.configuration?.mode),
  mode: status.result?.structuredContent?.configuration?.mode,
  allowed_group_count: status.result?.structuredContent?.configuration?.groups?.length,
  telegram_api_available: status.result?.structuredContent?.telegram?.connected === true,
  webhook_configured: status.result?.structuredContent?.telegram?.webhook_configured ?? null,
  real_telegram_comment: false,
  chatgpt_event_execution: false,
  timing_kind: "network round trip; not CPU; isolate coldness not guaranteed",
};
await writeFile(".local/remote-smoke.json", JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (
  results.some((r) => !r.passed) ||
  !report.mcp2 ||
  report.tools !== 7 ||
  report.events !== 2 ||
  !report.status_call_passed
)
  process.exitCode = 1;
