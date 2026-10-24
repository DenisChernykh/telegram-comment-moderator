import { spawn } from "node:child_process";

// Parse in memory and emit only allowlisted diagnostics. Never persist raw tail
// records: they may carry Authorization, Cookie and OAuth query parameters.
const child = spawn("pnpm", ["exec", "wrangler", "tail", "--env", "production", "--format=json"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    // Wrangler's own debug log would otherwise retain the unsanitized records.
    WRANGLER_LOG_PATH: process.platform === "win32" ? "NUL" : "/dev/null",
  },
});
let buffer = "";
let start = -1;
let depth = 0;
let quoted = false;
let escapedCharacter = false;
let records = 0;
const routes = new Set([
  "/mcp",
  "/health",
  "/telegram/webhook",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/register",
]);
child.stdout.on("data", (chunk) => {
  for (const char of chunk.toString()) {
    if (start < 0) {
      if (char !== "{") continue;
      buffer = "";
      start = 0;
      depth = 0;
      quoted = false;
      escapedCharacter = false;
    }
    buffer += char;
    if (quoted) {
      if (escapedCharacter) escapedCharacter = false;
      else if (char === "\\") escapedCharacter = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
    if (buffer.length > 1024 * 1024) {
      child.kill("SIGINT");
      buffer = "";
      start = -1;
      return;
    }
    if (depth !== 0) continue;
    try {
      const item = JSON.parse(buffer);
      const request = item.event?.request;
      const path = request?.url ? new URL(request.url).pathname : null;
      const headers = request?.headers ?? {};
      const origin = headers.origin ?? headers.Origin;
      console.log(
        JSON.stringify({
          event_timestamp: item.eventTimestamp,
          outcome: item.outcome,
          execution_model: item.executionModel,
          entrypoint: item.entrypoint,
          path: routes.has(path) ? path : "other",
          method: request?.method,
          status: item.event?.response?.status,
          exceptions: item.exceptions?.length ?? 0,
          cpu_time: item.cpuTime,
          wall_time: item.wallTime,
          origin_kind: origin === undefined ? "absent" : origin === "null" ? "opaque" : "present",
          cpu_probe: /^w[0-9]{2}$/.test(headers["x-moderator-cpu-probe"] ?? "")
            ? Number(headers["x-moderator-cpu-probe"].slice(1))
            : undefined,
        }),
      );
      records++;
    } catch {
      /* Ignore non-JSON Wrangler notices, without logging their text. */
    }
    buffer = "";
    start = -1;
  }
});
child.stderr.resume();
const timer = setTimeout(() => child.kill("SIGINT"), 30000);
child.on("exit", () => {
  clearTimeout(timer);
  console.log(JSON.stringify({ sanitized_tail_records: records }));
});
