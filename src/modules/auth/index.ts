import { z } from "zod";
import { equal, hash, randomToken } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { readBody, SafeError } from "../../platform/http";
import type { Store } from "../moderation";

export const scopes = ["moderation:read", "moderation:write", "moderation:configure"];
const noStore = { "cache-control": "no-store", pragma: "no-cache" };
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
type Mutate = <T>(fn: () => T) => Promise<T>;
const resource = (env: Env) => `${env.APP_ORIGIN}/mcp`;
export function metadata(path: string, env: Env) {
  if (
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(
      path,
    )
  )
    return Response.json({
      resource: resource(env),
      authorization_servers: [env.APP_ORIGIN],
      scopes_supported: scopes,
    });
  if (path !== "/.well-known/oauth-authorization-server") throw new SafeError("NOT_FOUND", 404);
  return Response.json({
    issuer: env.APP_ORIGIN,
    authorization_endpoint: `${env.APP_ORIGIN}/oauth/authorize`,
    token_endpoint: `${env.APP_ORIGIN}/oauth/token`,
    registration_endpoint: `${env.APP_ORIGIN}/oauth/register`,
    revocation_endpoint: `${env.APP_ORIGIN}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: scopes,
    authorization_response_iss_parameter_supported: true,
  });
}
export async function authenticated(request: Request, store: Store) {
  const value = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9-]{72})$/)?.[1];
  if (!value) return false;
  return (
    store.rows(
      "SELECT hash FROM oauth_tokens WHERE hash=? AND kind='access' AND expires_at>?",
      await hash(value),
      Date.now(),
    ).length === 1
  );
}
export function authChallenge(env: Env) {
  return Response.json(
    { error: "authentication_required" },
    {
      status: 401,
      headers: {
        ...noStore,
        "WWW-Authenticate": `Bearer resource_metadata="${env.APP_ORIGIN}/.well-known/oauth-protected-resource", scope="${scopes.join(" ")}"`,
      },
    },
  );
}
function allowedRedirect(value: string, env: Env) {
  return env.OAUTH_REDIRECT_URIS.split(",")
    .map((s) => s.trim())
    .includes(value);
}
async function rate(store: Store, mutate: Mutate, key: string, limit: number) {
  await mutate(() => {
    const bucket = `${key}:${Math.floor(Date.now() / 60000)}`;
    const count =
      store.rows<{ count: number }>("SELECT count FROM auth_attempts WHERE key=?", bucket)[0]
        ?.count ?? 0;
    if (count >= limit) throw new SafeError("RATE_LIMITED", 429);
    store.run(
      "INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
      bucket,
      Date.now() + 120000,
    );
  });
}
export async function oauth(request: Request, env: Env, store: Store, mutate: Mutate) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/.well-known/")) return metadata(url.pathname, env);
  if (url.pathname === "/oauth/register" && request.method === "POST") {
    await rate(store, mutate, "registration", 10);
    const p = z
      .object({
        redirect_uris: z.array(z.string()).min(1).max(3),
        token_endpoint_auth_method: z.literal("none").optional(),
        grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
        response_types: z.array(z.literal("code")).optional(),
        client_name: z.string().max(100).optional(),
      })
      .passthrough()
      .parse(JSON.parse(await readBody(request, 8192)));
    if (p.redirect_uris.some((v) => !allowedRedirect(v, env)))
      throw new SafeError("REDIRECT_NOT_ALLOWED");
    // Registration is deterministic to bound unauthenticated database growth.
    const redirects = [...new Set(p.redirect_uris)].sort();
    const client = `client_${await hash(JSON.stringify(redirects))}`;
    await mutate(() =>
      store.run(
        "INSERT OR IGNORE INTO oauth_clients VALUES(?,?,?)",
        client,
        JSON.stringify(redirects),
        Date.now(),
      ),
    );
    return Response.json(
      {
        client_id: client,
        redirect_uris: redirects,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { status: 201, headers: noStore },
    );
  }
  if (url.pathname === "/oauth/authorize") {
    if (!env.OWNER_LOGIN_SECRET || env.OWNER_LOGIN_SECRET.length < 32)
      throw new SafeError("OWNER_LOGIN_NOT_CONFIGURED", 503);
    if (request.method === "GET") {
      await rate(store, mutate, "authorize", 20);
      const p = z
        .object({
          client_id: z.string().max(100),
          redirect_uri: z.string().max(2048),
          response_type: z.literal("code"),
          code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          code_challenge_method: z.literal("S256"),
          resource: z.literal(resource(env)),
          state: z.string().min(1).max(1000),
          scope: z.string().optional(),
        })
        .parse(Object.fromEntries(url.searchParams));
      const client = store.rows<{ redirects: string }>(
        "SELECT redirects FROM oauth_clients WHERE id=?",
        p.client_id,
      )[0];
      if (
        !client ||
        !JSON.parse(client.redirects).includes(p.redirect_uri) ||
        !allowedRedirect(p.redirect_uri, env)
      )
        throw new SafeError("INVALID_CLIENT");
      if (
        p.scope
          ?.split(" ")
          .filter(Boolean)
          .some((v) => !scopes.includes(v))
      )
        throw new SafeError("INVALID_SCOPE");
      const flow = randomToken();
      await mutate(() =>
        store.run(
          "INSERT INTO oauth_flows VALUES(?,?,?)",
          flow,
          JSON.stringify(p),
          Date.now() + 300000,
        ),
      );
      const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Telegram moderator — подключение</title><body><h1>Подключить владельца</h1><p>ChatGPT получит доступ к сохранённым комментариям, настройке режима и удалению явного спама в разрешённых обсуждениях. Текущий режим: ${escapeHtml(store.config.mode)}.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="flow" value="${flow}"><label>Ключ владельца <input type="password" name="owner_secret" required autocomplete="current-password" minlength="32" maxlength="256"></label><button type="submit">Разрешить подключение</button></form></body></html>`;
      return new Response(html, {
        headers: {
          ...noStore,
          "content-type": "text/html; charset=utf-8",
          // Browsers apply form-action to the POST's redirect chain too.
          // Permit only the already validated exact OAuth callback.
          "content-security-policy": `default-src 'none'; form-action 'self' ${p.redirect_uri}; frame-ancestors 'none'; base-uri 'none'`,
          // no-referrer makes a browser's form POST Origin null. Keep the
          // origin for CSRF validation while never exposing the OAuth query.
          "referrer-policy": "strict-origin",
          "x-frame-options": "DENY",
          "set-cookie": `__Host-oauth-flow=${flow}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`,
        },
      });
    }
    if (request.method === "POST") {
      if (request.headers.get("origin") !== env.APP_ORIGIN)
        throw new SafeError(
          request.headers.get("origin") === "null" ? "OPAQUE_ORIGIN" : "UNTRUSTED_ORIGIN",
          403,
        );
      await rate(store, mutate, "login", 5);
      const form = new URLSearchParams(await readBody(request, 4096));
      const flow = form.get("flow") ?? "";
      const cookie =
        request.headers.get("cookie")?.match(/(?:^|; )__Host-oauth-flow=([^;]+)/)?.[1] ?? "";
      if (!cookie) throw new SafeError("CSRF_COOKIE_MISSING", 403);
      if (!flow || !equal(flow, cookie)) throw new SafeError("CSRF_REJECTED", 403);
      if (!equal(form.get("owner_secret") ?? "", env.OWNER_LOGIN_SECRET))
        throw new SafeError("LOGIN_REJECTED", 401);
      const code = randomToken();
      const codeHash = await hash(code);
      const data = await mutate(() => {
        const row = store.rows<{ payload: string }>(
          "DELETE FROM oauth_flows WHERE hash=? AND expires_at>? RETURNING payload",
          flow,
          Date.now(),
        )[0];
        if (!row) throw new SafeError("FLOW_EXPIRED");
        const p = JSON.parse(row.payload) as Record<string, string>;
        store.run(
          "INSERT INTO oauth_codes VALUES(?,?,?,?,?,?)",
          codeHash,
          p.client_id ?? "",
          p.redirect_uri ?? "",
          p.code_challenge ?? "",
          resource(env),
          Date.now() + 60000,
        );
        return p;
      });
      const target = new URL(data.redirect_uri ?? "");
      target.searchParams.set("code", code);
      target.searchParams.set("state", data.state ?? "");
      target.searchParams.set("iss", env.APP_ORIGIN);
      return new Response(null, {
        status: 302,
        headers: {
          ...noStore,
          location: target.href,
          "set-cookie": "__Host-oauth-flow=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        },
      });
    }
  }
  if (request.method === "POST" && ["/oauth/token", "/oauth/revoke"].includes(url.pathname)) {
    await rate(store, mutate, "token", 60);
    const form = new URLSearchParams(await readBody(request, 8192));
    if (url.pathname === "/oauth/revoke") {
      const tokenHash = await hash(form.get("token") ?? "");
      await mutate(() => {
        const exists =
          store.rows("SELECT hash FROM oauth_tokens WHERE hash=?", tokenHash).length > 0;
        store.run(
          "DELETE FROM oauth_tokens WHERE family IN (SELECT family FROM oauth_tokens WHERE hash=?)",
          tokenHash,
        );
        if (exists) {
          const cfg = store.config;
          store.config = { ...cfg, mode: "manual", epoch: cfg.epoch + 1 };
          store.run(
            "UPDATE subscriptions SET active=0,secret='',previous_secret=NULL,last_error='authorization_revoked'",
          );
          store.run(
            "UPDATE work SET state='cancelled',due_at=NULL,last_error='authorization_revoked' WHERE due_at IS NOT NULL",
          );
        }
      });
      return Response.json({}, { headers: noStore });
    }
    if (form.get("resource") !== resource(env)) throw new SafeError("INVALID_TARGET");
    const client = form.get("client_id") ?? "";
    const access = randomToken();
    const refresh = randomToken();
    const ah = await hash(access);
    const rh = await hash(refresh);
    const sourceHash = await hash(form.get("code") ?? form.get("refresh_token") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = await hash(verifier);
    const result = await mutate(() => {
      let family = randomToken();
      if (form.get("grant_type") === "authorization_code") {
        const code = store.rows<{ client: string; redirect: string; challenge: string }>(
          "SELECT * FROM oauth_codes WHERE hash=? AND expires_at>?",
          sourceHash,
          Date.now(),
        )[0];
        if (
          !code ||
          code.client !== client ||
          code.redirect !== form.get("redirect_uri") ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          !equal(code.challenge, challenge)
        )
          return false;
        store.run("DELETE FROM oauth_codes WHERE hash=?", sourceHash);
      } else if (form.get("grant_type") === "refresh_token") {
        const token = store.rows<{ client: string; kind: string; family: string }>(
          "SELECT * FROM oauth_tokens WHERE hash=? AND expires_at>?",
          sourceHash,
          Date.now(),
        )[0];
        if (!token || token.client !== client) return false;
        if (token.kind === "spent") {
          store.run("DELETE FROM oauth_tokens WHERE family=?", token.family);
          return false;
        }
        if (token.kind !== "refresh") return false;
        family = token.family;
        store.run("UPDATE oauth_tokens SET kind='spent' WHERE hash=?", sourceHash);
      } else return false;
      const issued = `tokens:${Math.floor(Date.now() / 86400000)}`;
      if (store.count(issued) >= 2000) return false;
      store.run(
        "INSERT INTO oauth_tokens VALUES(?,?,'access',?,?)",
        ah,
        client,
        family,
        Date.now() + 3600000,
      );
      store.run(
        "INSERT INTO oauth_tokens VALUES(?,?,'refresh',?,?)",
        rh,
        client,
        family,
        Date.now() + 30 * 86400000,
      );
      store.increment(issued);
      return true;
    });
    if (!result)
      return Response.json({ error: "invalid_grant" }, { status: 400, headers: noStore });
    return Response.json(
      {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
        scope: scopes.join(" "),
      },
      { headers: noStore },
    );
  }
  throw new SafeError("NOT_FOUND", 404);
}
