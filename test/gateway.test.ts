import { expect, it, vi } from "vitest";
import { createApp } from "../src/app/create-app";
import type { Env } from "../src/platform/env";

const secret = "test-webhook-secret-at-least-32-characters";
const ctx = {} as ExecutionContext;
function setup() {
  const fetch = vi.fn(async () => Response.json({ kind: "outside_allowlist" }));
  const namespace = {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn(() => ({ fetch })),
  };
  const env = {
    OWNER_ID: "owner",
    BOT_ID: "bot",
    APP_ORIGIN: "https://moderator.example",
    TELEGRAM_WEBHOOK_SECRET: secret,
    MODERATOR: namespace,
  } as unknown as Env;
  return { app: createApp(), env, namespace, fetch };
}
it("preserves rejection of invalid webhook headers and MCP Origin before any DO access", async () => {
  const { app, env, namespace } = setup();
  const requests: Array<[Request, number]> = [
    [
      new Request("https://moderator.example/telegram/webhook", { method: "POST", body: "{}" }),
      401,
    ],
    [
      new Request("https://moderator.example/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "content-type": "text/plain" },
        body: "{}",
      }),
      415,
    ],
    [
      new Request("https://moderator.example/telegram/webhook", {
        method: "POST",
        headers: {
          "X-Telegram-Bot-Api-Secret-Token": secret,
          "content-type": "application/json",
          "content-length": "65537",
        },
      }),
      413,
    ],
    [
      new Request("https://moderator.example/mcp", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      403,
    ],
  ];
  for (const [request, status] of requests)
    expect((await app.fetch(request, env, ctx)).status).toBe(status);
  expect(namespace.idFromName).not.toHaveBeenCalled();
  expect(namespace.get).not.toHaveBeenCalled();
});
it("caches only immutable per-namespace identity and replaces failed stubs", async () => {
  const { app, env, namespace, fetch } = setup();
  const request = () => new Request("https://moderator.example/mcp", { method: "POST" });
  fetch.mockRejectedValueOnce(new Error("private provider message"));
  expect((await app.fetch(request(), env, ctx)).status).toBe(503);
  expect((await app.fetch(request(), env, ctx)).status).toBe(200);
  expect(namespace.idFromName).toHaveBeenCalledTimes(1);
  expect(namespace.get).toHaveBeenCalledTimes(2);
  await app.fetch(request(), { ...env, BOT_ID: "other-bot" }, ctx);
  expect(namespace.idFromName).toHaveBeenLastCalledWith("owner:other-bot");
});
