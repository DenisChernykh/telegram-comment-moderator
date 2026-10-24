import { env, reset, runInDurableObject } from "cloudflare:test";
import { createHmac } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { authenticated, oauth } from "../src/modules/auth";
import { type Subscription, sendSigned, subscriptionMethod } from "../src/modules/events";
import { callbackUrl, publicIPv4, validatedIPv4 } from "../src/modules/events/transport";
import type { Moderator } from "../src/modules/moderation";
import { hash } from "../src/platform/crypto";
import type { Env } from "../src/platform/env";

const group = "-1001234567890";
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const origin = "https://moderator.example.workers.dev";
const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
const authEnv = {
  ...env,
  APP_ORIGIN: origin,
  OWNER_LOGIN_SECRET: "test-owner-secret-at-least-32-characters",
} as Env;
const object = () => env.MODERATOR.get(env.MODERATOR.idFromName(crypto.randomUUID()));
afterEach(async () => reset());

it("rejects private, local, metadata, reserved, IPv6 and unapproved callback destinations", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.100.100.200",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
  ])
    expect(publicIPv4(ip), ip).toBe(false);
  expect(publicIPv4("8.8.8.8")).toBe(true);
  for (const url of [
    "http://receiver.example/a",
    "https://evil.example/a",
    "https://receiver.example.evil/a",
    "https://receiver.example:444/a",
    "https://user:pass@receiver.example/a",
    "https://127.0.0.1/a",
    "https://receiver.example/a#fragment",
  ])
    expect(() => callbackUrl(url, "receiver.example")).toThrow();
});
it("accepts workerd CNAME answers only through validated public IPv4 targets", () => {
  expect(
    validatedIPv4(["receiver.example.cdn.cloudflare.net.", "104.18.38.184", "172.64.149.72"]),
  ).toEqual(["104.18.38.184", "172.64.149.72"]);
  for (const records of [
    ["receiver.example.", "127.0.0.1", "8.8.8.8"],
    ["receiver.example.", "10.0.0.1"],
    ["receiver.example.", "::1"],
    ["receiver.example."],
    [],
  ])
    expect(() => validatedIPv4(records)).toThrow("CALLBACK_ADDRESS_BLOCKED");
});
it("uses exact bytes in Standard Webhooks signatures and signs both keys during rotation", async () => {
  const old = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
  const s: Subscription = {
    id: "sub",
    owner: "owner",
    name: "telegram.comment.created",
    group_id: group,
    url: "https://receiver.example/events",
    secret,
    previous_secret: old,
    rotation_until: Date.now() + 300000,
    expires_at: Date.now() + 60000,
    verified_until: Date.now() + 60000,
    active: 1,
    last_error: null,
  };
  const ids: string[] = [];
  const post = async (_url: URL, body: string, headers: Record<string, string>) => {
    ids.push(headers["webhook-id"] ?? "");
    const signed = `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`;
    const expected = [secret, old]
      .map(
        (k) =>
          `v1,${createHmac("sha256", Buffer.from(k.slice(6), "base64"))
            .update(signed)
            .digest("base64")}`,
      )
      .join(" ");
    expect(headers["webhook-signature"]).toBe(expected);
    expect(headers["X-MCP-Subscription-Id"]).toBe("sub");
    return { status: 200, body: "{}", retryAfter: undefined };
  };
  await sendSigned(
    s,
    "evt-stable",
    { eventId: "evt-stable", data: { text: "Привет" } },
    "receiver.example",
    post,
  );
  await sendSigned(
    s,
    "evt-stable",
    { eventId: "evt-stable", data: { text: "Привет" } },
    "receiver.example",
    post,
  );
  expect(ids).toEqual(["evt-stable", "evt-stable"]);
});
it("verifies callback challenges, refreshes identity, and unsubscribes idempotently", async () => {
  const stub = object();
  await runInDurableObject(stub, async (o: Moderator) => {
    o.db.config = {
      ...o.db.config,
      mode: "auto",
      groups: [{ group_id: group, channel_id: "-1009876543210", protected_senders: [] }],
    };
    const p = {
      name: "telegram.comment.created",
      arguments: { group_id: group },
      delivery: { mode: "webhook", url: "https://receiver.example/events", secret },
      ttlMs: 60000,
      cursor: null,
    };
    let verification = 0;
    const post = async (_url: URL, body: string) => {
      verification++;
      return {
        status: 200,
        body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
        retryAfter: undefined,
      };
    };
    const first = await subscriptionMethod(
      "events/subscribe",
      p,
      o.db,
      "owner",
      "receiver.example",
      o.mutate.bind(o),
      post,
    );
    const second = await subscriptionMethod(
      "events/subscribe",
      p,
      o.db,
      "owner",
      "receiver.example",
      o.mutate.bind(o),
      post,
    );
    expect(first.id).toBe(second.id);
    expect(first.cursor).toBeNull();
    expect(verification).toBe(1);
    expect(o.db.count("subscription_count")).toBe(1);
    const { secret: _, ...delivery } = p.delivery;
    await subscriptionMethod(
      "events/unsubscribe",
      { name: p.name, arguments: p.arguments, delivery },
      o.db,
      "owner",
      "receiver.example",
      o.mutate.bind(o),
      post,
    );
    await subscriptionMethod(
      "events/unsubscribe",
      { name: p.name, arguments: p.arguments, delivery },
      o.db,
      "owner",
      "receiver.example",
      o.mutate.bind(o),
      post,
    );
    expect(o.db.config.mode).toBe("manual");
    expect(o.db.rows("SELECT * FROM subscriptions WHERE active=1")).toHaveLength(0);
  });
});
it("does not activate a callback with a wrong challenge or unsupported replay cursor", async () => {
  const stub = object();
  await runInDurableObject(stub, async (o: Moderator) => {
    o.db.config = {
      ...o.db.config,
      groups: [{ group_id: group, channel_id: "-1009876543210", protected_senders: [] }],
    };
    const p = {
      name: "telegram.comment.created",
      arguments: { group_id: group },
      delivery: { mode: "webhook", url: "https://receiver.example/events", secret },
    };
    await expect(
      subscriptionMethod(
        "events/subscribe",
        p,
        o.db,
        "owner",
        "receiver.example",
        o.mutate.bind(o),
        async () => ({ status: 200, body: '{"challenge":"wrong"}', retryAfter: undefined }),
      ),
    ).rejects.toThrow("CALLBACK_CHALLENGE_FAILED");
    const failure =
      o.db.rows<{ value: string }>("SELECT value FROM meta WHERE key='callback_last_failure'")[0]
        ?.value ?? "";
    expect(JSON.parse(failure)).toMatchObject({ reason: "callback_challenge_failed" });
    expect(failure).not.toContain("receiver.example");
    expect(failure).not.toContain(secret);
    await expect(
      subscriptionMethod(
        "events/subscribe",
        { ...p, cursor: "fictional" },
        o.db,
        "owner",
        "receiver.example",
        o.mutate.bind(o),
      ),
    ).rejects.toThrow();
    expect(o.db.rows("SELECT * FROM subscriptions")).toHaveLength(0);
  });
});
it("wakes for idle subscription expiry, clears keys and releases retired identity capacity", async () => {
  await runInDurableObject(object(), async (o: Moderator, state) => {
    o.db.config = {
      ...o.db.config,
      groups: [{ group_id: group, channel_id: "-1009876543210", protected_senders: [] }],
    };
    const p = {
      name: "telegram.comment.created",
      arguments: { group_id: group },
      delivery: { mode: "webhook", url: "https://receiver.example/events", secret },
      ttlMs: 60000,
    };
    const result = await subscriptionMethod(
      "events/subscribe",
      p,
      o.db,
      "owner",
      "receiver.example",
      o.mutate.bind(o),
      async (_url, body) => ({ status: 200, body, retryAfter: undefined }),
    );
    const expires = Date.parse(String(result.refreshBefore));
    expect(await state.storage.getAlarm()).toBe(expires);
    o.cleanup(expires + 1);
    expect(o.db.rows<Subscription>("SELECT * FROM subscriptions")[0]).toMatchObject({
      active: 0,
      secret: "",
      previous_secret: null,
      last_error: "subscription_expired",
    });
    expect(o.db.nextWake()).toBe(expires + 7 * 86400000);
    o.cleanup(expires + 7 * 86400000 + 1);
    expect(o.db.rows("SELECT id FROM subscriptions")).toHaveLength(0);
    expect(o.db.count("subscription_count")).toBe(0);
    // Unsubscribe stays valid after the group/host has been removed. No egress.
    o.db.config = { ...o.db.config, groups: [] };
    await expect(
      subscriptionMethod("events/unsubscribe", p, o.db, "owner", "", o.mutate.bind(o)),
    ).resolves.toMatchObject({ resultType: "complete" });
  });
});
it("reports only a candidate hostname when a callback host needs operator approval", async () => {
  await runInDurableObject(object(), async (o: Moderator) => {
    o.db.config = {
      ...o.db.config,
      groups: [{ group_id: group, channel_id: "-1009876543210", protected_senders: [] }],
    };
    await expect(
      subscriptionMethod(
        "events/subscribe",
        {
          name: "telegram.comment.created",
          arguments: { group_id: group },
          delivery: {
            mode: "webhook",
            url: "https://receiver.example/private-callback?token=secret",
            secret,
          },
        },
        o.db,
        "owner",
        "",
        o.mutate.bind(o),
      ),
    ).rejects.toThrow("CALLBACK_HOST_NOT_ALLOWED");
    const diagnostic =
      o.db.rows<{ value: string }>("SELECT value FROM meta WHERE key='callback_host_candidate'")[0]
        ?.value ?? "";
    expect(JSON.parse(diagnostic)).toMatchObject({ hostname: "receiver.example", trusted: false });
    expect(diagnostic).not.toContain("private-callback");
    expect(diagnostic).not.toContain("secret");
    const failure =
      o.db.rows<{ value: string }>("SELECT value FROM meta WHERE key='callback_last_failure'")[0]
        ?.value ?? "";
    expect(JSON.parse(failure)).toMatchObject({ reason: "callback_host_not_allowed" });
    expect(failure).not.toContain("private-callback");
    expect(failure).not.toContain("secret");
  });
});

it("OAuth binds one-time codes to PKCE, client, redirect and resource, and rotates refresh tokens", async () => {
  const stub = object();
  await runInDurableObject(stub, async (o: Moderator) => {
    const call = (path: string, init?: RequestInit) =>
      oauth(new Request(origin + path, init), authEnv, o.db, o.mutate.bind(o));
    const register = await call("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    });
    const { client_id } = (await register.json()) as { client_id: string };
    const verifier = "v".repeat(43);
    const challenge = await hash(verifier);
    const params = new URLSearchParams({
      client_id,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
      state: "test-state",
    });
    const consent = await call(`/oauth/authorize?${params}`);
    expect(consent.headers.get("referrer-policy")).toBe("strict-origin");
    expect(consent.headers.get("content-security-policy")).toContain(
      `form-action 'self' ${redirect};`,
    );
    const html = await consent.text();
    const flow = /name="flow" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const approved = await call("/oauth/authorize", {
      method: "POST",
      headers: { origin, cookie: `__Host-oauth-flow=${flow}` },
      body: new URLSearchParams({ flow, owner_secret: authEnv.OWNER_LOGIN_SECRET ?? "" }),
    });
    const callback = new URL(approved.headers.get("location") ?? "");
    expect(callback.searchParams.get("state")).toBe("test-state");
    expect(callback.searchParams.get("iss")).toBe(origin);
    const tokenBody = {
      grant_type: "authorization_code",
      client_id,
      redirect_uri: redirect,
      resource: `${origin}/mcp`,
      code: callback.searchParams.get("code") ?? "",
      code_verifier: verifier,
    };
    const token = (p: Record<string, string>) =>
      call("/oauth/token", { method: "POST", body: new URLSearchParams(p) });
    expect((await token({ ...tokenBody, code_verifier: "wrong".repeat(10) })).status).toBe(400);
    await expect(token({ ...tokenBody, resource: "https://evil.example/mcp" })).rejects.toThrow(
      "INVALID_TARGET",
    );
    const issued = (await (await token(tokenBody)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(
      await authenticated(
        new Request(origin, { headers: { authorization: `Bearer ${issued.access_token}` } }),
        o.db,
      ),
    ).toBe(true);
    expect((await token(tokenBody)).status).toBe(400);
    const refresh = {
      grant_type: "refresh_token",
      client_id,
      resource: `${origin}/mcp`,
      refresh_token: issued.refresh_token,
    };
    const rotated = (await (await token(refresh)).json()) as { access_token: string };
    expect(rotated.access_token).toBeTruthy();
    expect((await token(refresh)).status).toBe(400);
    expect(
      await authenticated(
        new Request(origin, { headers: { authorization: `Bearer ${rotated.access_token}` } }),
        o.db,
      ),
    ).toBe(false);
  });
});
it("OAuth rejects unknown redirects and login CSRF", async () => {
  const stub = object();
  await runInDurableObject(stub, async (o: Moderator) => {
    await expect(
      oauth(
        new Request(`${origin}/oauth/register`, {
          method: "POST",
          body: JSON.stringify({ redirect_uris: ["https://evil.example"] }),
        }),
        authEnv,
        o.db,
        o.mutate.bind(o),
      ),
    ).rejects.toThrow("REDIRECT_NOT_ALLOWED");
    await expect(
      oauth(
        new Request(`${origin}/oauth/authorize`, {
          method: "POST",
          headers: { origin: "https://evil.example" },
          body: "",
        }),
        authEnv,
        o.db,
        o.mutate.bind(o),
      ),
    ).rejects.toThrow("UNTRUSTED_ORIGIN");
  });
});
