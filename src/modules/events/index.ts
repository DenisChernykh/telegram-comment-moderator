import { z } from "zod";
import { equal, hash, randomToken, signature } from "../../platform/crypto";
import { SafeError } from "../../platform/http";
import type { Store } from "../moderation";
import { callbackUrl, publicPost } from "./transport";

export type Subscription = {
  id: string;
  owner: string;
  name: string;
  group_id: string;
  url: string;
  secret: string;
  previous_secret: string | null;
  rotation_until: number;
  expires_at: number;
  verified_until: number;
  active: number;
  last_error: string | null;
};
export const eventNames = ["telegram.comment.created", "telegram.comment.updated"] as const;
const argumentsSchema = z.object({ group_id: z.string().regex(/^-100\d{5,}$/) }).strict();
const identitySchema = z
  .object({
    name: z.enum(eventNames),
    arguments: argumentsSchema,
    delivery: z
      .object({
        mode: z.literal("webhook"),
        url: z.string().max(2048),
        secret: z.string().optional(),
      })
      .strict(),
    cursor: z.null().optional(),
    ttlMs: z.number().int().positive().nullable().optional(),
  })
  .strict();
export const eventDefinitions = eventNames.map((name) => ({
  name,
  description: `Saved Telegram discussion comment (${name.endsWith("created") ? "new" : "edited"}). Filter to an allowed group. Read pending jobs to recover missed events. No replay.`,
  delivery: ["webhook"],
  inputSchema: z.toJSONSchema(argumentsSchema),
  payloadSchema: {
    type: "object",
    properties: {
      group_id: { type: "string" },
      job_id: { type: "string" },
      revision: { type: "integer" },
      text: { type: "string" },
      context: { type: "string" },
      decision_deadline: { type: "string" },
      policy_version: { type: "string" },
    },
    required: [
      "group_id",
      "job_id",
      "revision",
      "text",
      "context",
      "decision_deadline",
      "policy_version",
    ],
    additionalProperties: false,
  },
}));
export type EventPost = typeof publicPost;
export async function sendSigned(
  s: Subscription,
  eventId: string,
  payload: object,
  hosts: string,
  post: EventPost = publicPost,
) {
  const url = callbackUrl(s.url, hosts);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 256 * 1024) throw new SafeError("EVENT_TOO_LARGE");
  const timestamp = String(Math.floor(Date.now() / 1000));
  let signed = await signature(s.secret, eventId, timestamp, body);
  if (s.previous_secret && s.rotation_until > Date.now())
    signed += ` ${await signature(s.previous_secret, eventId, timestamp, body)}`;
  return post(url, body, {
    "Content-Type": "application/json",
    "webhook-id": eventId,
    "webhook-timestamp": timestamp,
    "webhook-signature": signed,
    "X-MCP-Subscription-Id": s.id,
  });
}
async function handleSubscription(
  method: string,
  raw: unknown,
  store: Store,
  owner: string,
  hosts: string,
  mutate: <T>(fn: () => T) => Promise<T>,
  post: EventPost = publicPost,
) {
  if (method === "events/list") return { resultType: "complete", events: eventDefinitions };
  const p = identitySchema.parse(raw);
  const id = `sub_${await hash(JSON.stringify([owner, p.delivery.url, p.name, p.arguments.group_id]))}`;
  if (method === "events/unsubscribe") {
    await mutate(() => {
      store.run(
        "UPDATE subscriptions SET active=0,secret='',previous_secret=NULL WHERE id=? AND owner=?",
        id,
        owner,
      );
      store.run(
        "UPDATE work SET state='cancelled',due_at=NULL,last_error='unsubscribed' WHERE target=? AND kind='delivery' AND due_at IS NOT NULL",
        id,
      );
      // With one owner/bot authority, disconnecting a monitor conservatively
      // stops unattended deletion until the owner explicitly enables it again.
      const cfg = store.config;
      if (cfg.mode === "auto") store.config = { ...cfg, mode: "manual", epoch: cfg.epoch + 1 };
      store.run(
        "UPDATE work SET state='cancelled',due_at=NULL,last_error='unsubscribed' WHERE kind='delete' AND due_at IS NOT NULL",
      );
      store.run("UPDATE decisions SET status='awaiting_confirmation' WHERE status='deleting'");
      store.run("UPDATE jobs SET status='awaiting_confirmation' WHERE status='deleting'");
    });
    return { resultType: "complete" };
  }
  if (!store.config.groups.some((g) => g.group_id === p.arguments.group_id))
    throw new SafeError("GROUP_NOT_ALLOWED", 403);
  try {
    callbackUrl(p.delivery.url, hosts);
  } catch (error) {
    // Expose only a hostname to the authenticated operator, never the
    // access-bearing callback URL. It still needs independent verification.
    try {
      const candidate = new URL(p.delivery.url).hostname;
      if (/^[a-z0-9.-]{1,253}$/i.test(candidate))
        await mutate(() =>
          store.run(
            "INSERT OR REPLACE INTO meta VALUES('callback_host_candidate',?)",
            JSON.stringify({ hostname: candidate, observed_at: Date.now(), trusted: false }),
          ),
        );
    } catch {
      // Invalid URLs contain no useful host diagnostic.
    }
    throw error;
  }
  const secret = p.delivery.secret;
  if (
    !secret?.startsWith("whsec_") ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(secret.slice(6)) ||
    Buffer.from(secret.slice(6), "base64").length < 24 ||
    Buffer.from(secret.slice(6), "base64").length > 64
  )
    throw new SafeError("SIGNING_SECRET_INVALID");
  const existing = store.rows<Subscription>("SELECT * FROM subscriptions WHERE id=?", id)[0];
  if (!existing && store.count("subscription_count") >= 10)
    throw new SafeError("SUBSCRIPTION_LIMIT", 429);
  const now = Date.now();
  const s: Subscription = {
    id,
    owner,
    name: p.name,
    group_id: p.arguments.group_id,
    url: p.delivery.url,
    secret,
    previous_secret:
      existing?.secret !== secret ? (existing?.secret ?? null) : existing.previous_secret,
    rotation_until: existing?.secret !== secret ? now + 300000 : existing.rotation_until,
    expires_at: now + Math.min(p.ttlMs ?? 86400000, 86400000),
    verified_until: now + 300000,
    active: 1,
    last_error: null,
  };
  // Cache only when the same signing key was verified. Rotations must prove possession.
  if (!existing?.active || existing.verified_until <= now || existing.secret !== secret) {
    const challenge = randomToken();
    const result = await sendSigned(
      s,
      `verify_${crypto.randomUUID()}`,
      { type: "verification", challenge },
      hosts,
      post,
    );
    let echoed = "";
    try {
      echoed = JSON.parse(result.body).challenge;
    } catch {
      /* fail closed */
    }
    if (
      result.status < 200 ||
      result.status >= 300 ||
      typeof echoed !== "string" ||
      !equal(echoed, challenge)
    )
      throw new SafeError("CALLBACK_CHALLENGE_FAILED");
  }
  await mutate(() => {
    // Recheck authority after callback I/O.
    if (!store.config.groups.some((g) => g.group_id === s.group_id))
      throw new SafeError("GROUP_NOT_ALLOWED", 403);
    const current = store.rows<Subscription>("SELECT * FROM subscriptions WHERE id=?", id)[0];
    if (!current && store.count("subscription_count") >= 10)
      throw new SafeError("SUBSCRIPTION_LIMIT", 429);
    store.run(
      "INSERT OR REPLACE INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,1,NULL)",
      s.id,
      s.owner,
      s.name,
      s.group_id,
      s.url,
      s.secret,
      s.previous_secret,
      s.rotation_until,
      s.expires_at,
      s.verified_until,
    );
    if (!current) store.increment("subscription_count");
  });
  return {
    resultType: "complete",
    id,
    refreshBefore: new Date(s.expires_at).toISOString(),
    cursor: null,
    truncated: false,
  };
}

/** Persist only a bounded safe category: task clients may hide JSON-RPC errors. */
export async function subscriptionMethod(...args: Parameters<typeof handleSubscription>) {
  const [method, , store, , , mutate] = args;
  try {
    const result = await handleSubscription(...args);
    if (method === "events/subscribe")
      await mutate(() => store.run("DELETE FROM meta WHERE key='callback_last_failure'"));
    return result;
  } catch (error) {
    if (
      method === "events/subscribe" &&
      error instanceof SafeError &&
      error.code.startsWith("CALLBACK_")
    )
      await mutate(() =>
        store.run(
          "INSERT OR REPLACE INTO meta VALUES('callback_last_failure',?)",
          JSON.stringify({ reason: error.code.toLowerCase(), observed_at: Date.now() }),
        ),
      );
    throw error;
  }
}
