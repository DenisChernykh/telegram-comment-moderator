import { Hono } from "hono";
import type { Env } from "../platform/env";
import { problem, SafeError } from "../platform/http";
import { checkBoundary } from "../platform/request-boundary";

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  const ids = new WeakMap<Env["MODERATOR"], { name: string; id: DurableObjectId }>();
  let seenRequest = false;
  app.get("/health", (c) =>
    c.json({ ok: true, service: "telegram-comment-moderator", revision: c.env.BUILD_REVISION }),
  );
  app.onError((_e, c) => problem("INTERNAL_ERROR", 503, c.req.path));
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const first = !seenRequest;
      seenRequest = true;
      const path = new URL(request.url).pathname;
      if (path === "/health") return app.fetch(request, env, ctx);
      if (
        path !== "/telegram/webhook" &&
        path !== "/mcp" &&
        !path.startsWith("/oauth/") &&
        !path.startsWith("/.well-known/")
      )
        return problem("NOT_FOUND", 404, path);
      // Preserve rejection at the public edge before any DO call. The native
      // gateway avoids router work; only the immutable destination ID is cached.
      try {
        checkBoundary(request, path, env);
      } catch (error) {
        return error instanceof SafeError
          ? problem(error.code, error.status, path)
          : problem("INTERNAL_ERROR", 503, path);
      }
      const name = `${env.OWNER_ID}:${env.BOT_ID}`;
      let cached = ids.get(env.MODERATOR);
      if (cached?.name !== name) {
        cached = { name, id: env.MODERATOR.idFromName(name) };
        ids.set(env.MODERATOR, cached);
      }
      // IDs are immutable; create a fresh stub so a failed RPC cannot poison it.
      const result = await env.MODERATOR.get(cached.id)
        .fetch(request)
        .catch(() => problem("INTERNAL_ERROR", 503, path));
      if (!request.headers.has("X-Moderator-CPU-Probe")) return result;
      // Only the authenticated webhook boundary can acknowledge a CPU probe.
      if (!result.headers.has("X-Moderator-CPU-Probe")) return result;
      const measured = new Response(result.body, result);
      measured.headers.set("X-Moderator-Isolate-First", String(first));
      return measured;
    },
  };
}
