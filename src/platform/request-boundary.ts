import { equal } from "./crypto";
import type { Env } from "./env";
import { SafeError } from "./http";

/** Reject at the public gateway; recheck in the DO before parsing/persistence. */
export function checkBoundary(request: Request, path: string, env: Env) {
  if (path === "/telegram/webhook") {
    if (request.method !== "POST") throw new SafeError("NOT_FOUND", 404);
    const expected = env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected || expected.length < 32) throw new SafeError("WEBHOOK_NOT_CONFIGURED", 503);
    if (!equal(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", expected))
      throw new SafeError("UNAUTHENTICATED", 401);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? ""))
      throw new SafeError("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 65536)
    throw new SafeError("BODY_TOO_LARGE", 413);
  const origin = request.headers.get("Origin");
  if (path === "/mcp" && origin && origin !== env.APP_ORIGIN && origin !== "https://chatgpt.com")
    throw new SafeError("UNTRUSTED_ORIGIN", 403);
}
