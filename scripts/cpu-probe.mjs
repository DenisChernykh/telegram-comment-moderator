import { writeFile } from "node:fs/promises";
import { localEnv } from "./local-env.mjs";

localEnv();
const origin = "https://telegram-comment-moderator.ingenue-jolts-8i.workers.dev";
const count = Number(process.argv[2] || 12);
if (!Number.isInteger(count) || count < 1 || count > 30)
  throw new Error("Probe count must be 1–30");
const probes = [];
for (let i = 1; i <= count; i++) {
  const started = Date.now();
  const response = await fetch(`${origin}/telegram/webhook`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": process.env.TELEGRAM_WEBHOOK_SECRET,
      "X-Moderator-CPU-Probe": `w${String(i).padStart(2, "0")}`,
    },
    body: JSON.stringify({
      update_id: 900000000,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -1000000000000, type: "supergroup" },
        from: { id: 1, is_bot: false },
        text: "Synthetic CPU probe outside the allowlist; never creates a moderation job.",
      },
    }),
  });
  const data = await response.json();
  if (response.status !== 200 || data.kind !== "outside_allowlist")
    throw new Error("CPU probe did not stay outside the allowlist");
  probes.push({
    probe: i,
    started_at: started,
    status: response.status,
    round_trip_ms: Date.now() - started,
    first_request_in_isolate: response.headers.get("X-Moderator-Isolate-First"),
  });
}
const report = {
  measured_at: new Date().toISOString(),
  scope: "Outer gateway probe; CPU must be correlated with sanitized tail. No job is created.",
  probes,
};
await writeFile(".local/cpu-probes.json", JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report));
