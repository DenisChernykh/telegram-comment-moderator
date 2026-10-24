import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { hash } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { problem, readBody, SafeError } from "../../platform/http";
import { checkBoundary } from "../../platform/request-boundary";
import { authChallenge, authenticated, oauth } from "../auth";
import { type Subscription, sendSigned, subscriptionMethod } from "../events";
import {
  channelRoot,
  hasServiceData,
  type Message,
  sender,
  telegram,
  updateSchema,
} from "../telegram";
import {
  configurationSchema,
  type Decision,
  type DecisionInput,
  decisionSchema,
  type Job,
  POLICY_GUIDANCE,
  POLICY_VERSION,
  spamReasons,
  type Work,
} from "./public-contracts";
import { Store } from "./store";

export { Store } from "./store";

const DAY = 86400000;
const LEASE = 60000;
const LIMIT = 4;

export class Moderator extends DurableObject<Env> {
  readonly db: Store;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Store(ctx.storage.sql);
  }

  /** Persist a watchdog BEFORE writing work. A crash before the final indexed
   * reschedule leaves the watchdog durable. The same rule protects alarm claims.
   * No external I/O is inside blockConcurrencyWhile. */
  async mutate<T>(fn: () => T): Promise<T> {
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > now + LEASE) await this.ctx.storage.setAlarm(now + LEASE);
      let result: { value: T } | { error: unknown };
      // A normal domain rejection must not reject blockConcurrencyWhile, which
      // would reset the object and abort unrelated requests.
      try {
        result = { value: this.ctx.storage.transactionSync(fn) };
      } catch (error) {
        result = { error };
      }
      try {
        await this.schedule();
      } catch (error) {
        // Keep the committed inbox and preexisting watchdog available even
        // when the final reschedule fails. Return 503 outside the block.
        return { error };
      }
      return result;
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }
  async schedule() {
    const next = this.db.nextWake();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else {
      const at = Math.max(Date.now() + 100, next);
      const old = await this.ctx.storage.getAlarm();
      if (old !== at) await this.ctx.storage.setAlarm(at);
    }
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      checkBoundary(request, path, this.env);
      if (path === "/telegram/webhook") {
        const update = updateSchema.parse(JSON.parse(await readBody(request)));
        const probe = request.headers.get("X-Moderator-CPU-Probe") ?? "";
        return Response.json(await this.receive(update), {
          headers: /^w[0-9]{2}$/.test(probe) ? { "X-Moderator-CPU-Probe": probe } : {},
        });
      }
      if (path.startsWith("/.well-known/") || path.startsWith("/oauth/"))
        return await oauth(request, this.env, this.db, this.mutate.bind(this));
      if (path === "/mcp") {
        if (!(await authenticated(request, this.db))) return authChallenge(this.env);
        const { mcp } = await import("../mcp");
        return await mcp(
          request,
          async (name, args) => this.tool(name, args),
          async (method, params) =>
            subscriptionMethod(
              method,
              params,
              this.db,
              this.env.OWNER_ID,
              this.env.CALLBACK_HOSTS,
              this.mutate.bind(this),
            ),
        );
      }
      return problem("NOT_FOUND", 404, path);
    } catch (e) {
      if (e instanceof z.ZodError || e instanceof SyntaxError)
        return problem("VALIDATION_FAILED", 400, path);
      if (e instanceof SafeError) return problem(e.code, e.status, path);
      // Deliberately do not log exceptions: provider errors can include callback URLs or bot tokens.
      console.error(JSON.stringify({ event: "request_failed", path, category: "internal" }));
      return problem("INTERNAL_ERROR", 503, path);
    }
  }
  async receive(update: z.infer<typeof updateSchema>) {
    const membership = update.my_chat_member;
    if (membership && String(membership.new_chat_member.user.id) === this.env.BOT_ID) {
      await this.mutate(() => {
        const id = String(membership.chat.id);
        if (!this.db.config.groups.some((g) => g.group_id === id)) return;
        const old = this.db.rows<{ value: string }>(
          "SELECT value FROM meta WHERE key=?",
          `rights:${id}`,
        )[0];
        const previous = old ? (JSON.parse(old.value) as { date: number; update: number }) : null;
        if (
          previous &&
          (previous.date > membership.date ||
            (previous.date === membership.date && previous.update >= update.update_id))
        )
          return;
        const canDelete =
          membership.new_chat_member.status === "creator" ||
          (membership.new_chat_member.status === "administrator" &&
            membership.new_chat_member.can_delete_messages === true);
        this.db.run(
          "INSERT OR REPLACE INTO meta VALUES(?,?)",
          `rights:${id}`,
          JSON.stringify({
            date: membership.date,
            update: update.update_id,
            can_delete: canDelete,
          }),
        );
        if (!canDelete)
          this.db.run(
            "UPDATE work SET state='cancelled',due_at=NULL,last_error='bot_rights_lost' WHERE kind='delete' AND job_id IN (SELECT id FROM jobs WHERE group_id=?) AND due_at IS NOT NULL",
            id,
          );
      });
      return { accepted: true, kind: "membership" };
    }
    const message = update.edited_message ?? update.message;
    if (message?.chat.type !== "supergroup") return { accepted: true, kind: "ignored" };
    const groupId = String(message.chat.id);
    if (!this.db.config.groups.some((g) => g.group_id === groupId))
      return { accepted: true, kind: "outside_allowlist" };
    const fingerprint = await hash(
      JSON.stringify([
        message.text ?? message.caption ?? "",
        message.entities ?? message.caption_entities ?? [],
        sender(message),
        message.is_automatic_forward ?? false,
      ]),
    );
    return this.mutate(() => {
      const cfg = this.db.config;
      const group = cfg.groups.find((g) => g.group_id === groupId);
      if (!group) return { accepted: true, kind: "outside_allowlist" };
      if (this.db.rows("SELECT id FROM updates WHERE id=?", update.update_id).length)
        return { accepted: true, kind: "duplicate" };
      const now = Date.now();
      const daily = `received:${Math.floor(now / DAY)}`;
      const id = `${groupId}:${message.message_id}`;
      const old = this.db.job(id);
      if (
        this.db.count(daily) >= cfg.daily_comment_limit ||
        (!old && this.db.count("inbox_count") >= 20000)
      )
        throw new SafeError("INBOX_BUDGET_EXHAUSTED", 503);
      this.db.run("INSERT INTO updates VALUES(?,?)", update.update_id, now + 7 * DAY);
      this.db.increment(daily);
      const version = (message.edit_date ?? message.date) * 1000;
      if (
        old &&
        (version < old.version_at ||
          (version === old.version_at && update.update_id <= old.update_id))
      )
        return { accepted: true, kind: "older_revision" };
      if (old?.fingerprint === fingerprint) {
        this.db.run(
          "UPDATE jobs SET version_at=?,update_id=? WHERE id=?",
          version,
          update.update_id,
          id,
        );
        return { accepted: true, kind: "same_content" };
      }
      const rememberRoot = (m: Message) => {
        if (channelRoot(m, group.channel_id)) {
          this.db.run(
            "INSERT OR REPLACE INTO roots VALUES(?,?,?,?,?)",
            `${groupId}:${m.message_id}`,
            groupId,
            m.message_id,
            (m.text ?? m.caption ?? "").slice(0, 3000),
            now + 7 * DAY,
          );
          return true;
        }
        return false;
      };
      if (rememberRoot(message)) return { accepted: true, kind: "protected_root" };
      let root: number | null = null;
      const parent = message.reply_to_message;
      if (parent && String(parent.chat.id) === groupId) {
        if (rememberRoot(parent)) root = parent.message_id;
        else {
          const saved = this.db.job(`${groupId}:${parent.message_id}`);
          if (saved?.scope === "discussion") root = saved.root_id;
        }
      }
      const protectedTarget =
        message.is_automatic_forward === true ||
        hasServiceData(message) ||
        group.protected_senders.includes(sender(message)) ||
        sender(message) === `chat:${group.channel_id}` ||
        sender(message) === `chat:${groupId}` ||
        sender(message) === "unknown";
      const text = (message.text ?? message.caption ?? "").slice(0, 8192);
      const status = protectedTarget
        ? "protected"
        : !text
          ? "review"
          : root === null
            ? "scope_unknown"
            : cfg.paused
              ? "review"
              : "pending";
      const revision = (old?.revision ?? 0) + 1;
      if (old) {
        this.db.cancelJob(id, "revision_superseded");
        this.db.run(
          "UPDATE decisions SET status='superseded' WHERE job_id=? AND status IN ('awaiting_confirmation','would_delete','deleting')",
          id,
        );
      } else this.db.increment("inbox_count");
      const rootText =
        root === null
          ? ""
          : (this.db.rows<{ text: string }>(
              "SELECT text FROM roots WHERE id=?",
              `${groupId}:${root}`,
            )[0]?.text ?? "");
      const context = JSON.stringify({
        post: rootText,
        parent: (parent?.text ?? parent?.caption ?? "").slice(0, 2000),
        post_context_available: rootText.length > 0,
        media_without_text: !text,
      });
      const deadline = Math.min(
        now + cfg.decision_deadline_seconds * 1000,
        message.date * 1000 + 48 * 3600000 - 60000,
      );
      this.db.run(
        "INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        groupId,
        group.channel_id,
        message.message_id,
        revision,
        version,
        update.update_id,
        fingerprint,
        text,
        context,
        sender(message),
        root,
        root === null ? "unknown" : "discussion",
        status,
        message.date * 1000,
        now,
        deadline,
        cfg.epoch,
        "not_subscribed",
        now + 7 * DAY,
      );
      if (status === "pending" && deadline > now) {
        const name = update.edited_message
          ? "telegram.comment.updated"
          : "telegram.comment.created";
        const subs = this.db.rows<Subscription>(
          "SELECT * FROM subscriptions WHERE group_id=? AND name=? AND active=1 AND expires_at>?",
          groupId,
          name,
          now,
        );
        for (const sub of subs)
          this.db.addWork({
            id: `event:${id}:${revision}:${sub.id}`,
            kind: "delivery",
            job_id: id,
            revision,
            target: sub.id,
            epoch: cfg.epoch,
            due_at: now,
          });
        if (subs.length) this.db.run("UPDATE jobs SET delivery_status='queued' WHERE id=?", id);
      }
      if (deadline <= now && status === "pending")
        this.db.run("UPDATE jobs SET status='expired' WHERE id=?", id);
      return { accepted: true, kind: status, job_id: id, revision };
    });
  }

  async tool(name: string, raw: unknown): Promise<Record<string, unknown>> {
    if (name === "get_moderation_status") {
      const webhook = await telegram(this.env.TELEGRAM_BOT_TOKEN, "getWebhookInfo", {});
      const info = webhook.result as
        | {
            pending_update_count?: number;
            last_error_date?: number;
            last_error_message?: string;
            url?: string;
            allowed_updates?: string[];
          }
        | undefined;
      return {
        configuration: this.db.config,
        policy_version: POLICY_VERSION,
        jobs: this.db.rows("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status"),
        queue: this.db.rows(
          "SELECT state,COUNT(*) AS count FROM work WHERE due_at IS NOT NULL GROUP BY state",
        ),
        subscriptions: this.db.rows(
          "SELECT id,name,group_id,active,expires_at,last_error FROM subscriptions",
        ),
        errors: this.db.rows(
          "SELECT kind,last_error,COUNT(*) AS count FROM work WHERE last_error IS NOT NULL GROUP BY kind,last_error LIMIT 20",
        ),
        telegram: {
          connected: webhook.ok,
          token_configured: Boolean(this.env.TELEGRAM_BOT_TOKEN),
          api_error_code: webhook.ok ? null : (webhook.error_code ?? 503),
          api_failure_kind: webhook.failure_kind ?? null,
          webhook_configured: webhook.ok
            ? info?.url === `${this.env.APP_ORIGIN}/telegram/webhook`
            : null,
          pending_update_count: info?.pending_update_count,
          last_error_date: info?.last_error_date,
          has_delivery_error: Boolean(info?.last_error_message),
          allowed_updates: info?.allowed_updates,
        },
        events: {
          replay: false,
          callback_hosts_configured: Boolean(this.env.CALLBACK_HOSTS),
          callback_host_candidate: JSON.parse(
            this.db.rows<{ value: string }>(
              "SELECT value FROM meta WHERE key='callback_host_candidate'",
            )[0]?.value ?? "null",
          ),
          callback_last_failure: JSON.parse(
            this.db.rows<{ value: string }>(
              "SELECT value FROM meta WHERE key='callback_last_failure'",
            )[0]?.value ?? "null",
          ),
          availability:
            "Requires a real Work Web/Cloud or dot subscription; delivery is asynchronous.",
        },
        budget: {
          daily_limit: this.db.config.daily_comment_limit,
          received_today: this.db.count(`received:${Math.floor(Date.now() / DAY)}`),
        },
      };
    }
    if (name === "list_pending_comments") {
      const p = z
        .object({
          limit: z.number().int().min(1).max(20).default(10),
          cursor: z.string().max(100).optional(),
        })
        .strict()
        .parse(raw);
      const jobs = this.db.rows<Job>(
        "SELECT * FROM jobs WHERE status IN ('pending','review','scope_unknown','awaiting_confirmation','would_delete','error','expired') AND id>? ORDER BY id LIMIT ?",
        p.cursor ?? "",
        p.limit + 1,
      );
      const more = jobs.length > p.limit;
      if (more) jobs.pop();
      return {
        comments: jobs.map((j) => ({
          ...j,
          text: j.text.slice(0, 2000),
          context: j.context.slice(0, 2000),
        })),
        nextCursor: more ? jobs.at(-1)?.id : null,
      };
    }
    if (name === "get_comment_context") {
      const p = z
        .object({ job_id: z.string().max(100) })
        .strict()
        .parse(raw);
      const job = this.db.job(p.job_id);
      if (!job) throw new SafeError("COMMENT_NOT_FOUND", 404);
      return {
        comment: job,
        policy_version: POLICY_VERSION,
        policy_guidance: POLICY_GUIDANCE,
        context_limit: "Only received updates; no Bot API getMessage/history, OCR or URL fetching.",
      };
    }
    if (name === "list_recent_decisions") {
      const p = z
        .object({
          limit: z.number().int().min(1).max(50).default(20),
          before: z.number().int().optional(),
        })
        .strict()
        .parse(raw);
      return {
        decisions: this.db.rows<Decision>(
          "SELECT * FROM decisions WHERE created_at<? ORDER BY created_at DESC,id DESC LIMIT ?",
          p.before ?? Date.now() + 1,
          p.limit,
        ),
      };
    }
    if (name === "configure_moderation") return this.configure(raw);
    if (name === "apply_moderation_decisions") {
      const p = z
        .object({ decisions: z.array(decisionSchema).min(1).max(10) })
        .strict()
        .parse(raw);
      const results = [];
      for (const decision of p.decisions) {
        try {
          results.push(await this.apply(decision));
        } catch (e) {
          results.push({
            job_id: decision.job_id,
            error: e instanceof SafeError ? e.code : "INTERNAL_ERROR",
          });
        }
      }
      return { results };
    }
    if (name === "execute_reviewed_decisions") {
      const p = z
        .object({
          decisions: z
            .array(
              z
                .object({
                  decision_id: z.string().max(100),
                  expected_revision: z.number().int().positive(),
                })
                .strict(),
            )
            .min(1)
            .max(10),
        })
        .strict()
        .parse(raw);
      const results = [];
      for (const item of p.decisions) {
        try {
          results.push(await this.confirm(item.decision_id, item.expected_revision));
        } catch (e) {
          results.push({
            decision_id: item.decision_id,
            error: e instanceof SafeError ? e.code : "INTERNAL_ERROR",
          });
        }
      }
      return { results };
    }
    throw new SafeError("TOOL_NOT_FOUND", 404);
  }
  async configure(raw: unknown) {
    const p = configurationSchema.parse(raw);
    if (p.groups) {
      if (new Set(p.groups.map((g) => g.group_id)).size !== p.groups.length)
        throw new SafeError("DUPLICATE_GROUP");
      for (const group of p.groups) {
        const result = await telegram(this.env.TELEGRAM_BOT_TOKEN, "getChat", {
          chat_id: group.group_id,
        });
        const chat = result.result as
          | { id: number; type: string; linked_chat_id?: number }
          | undefined;
        if (
          !result.ok ||
          chat?.type !== "supergroup" ||
          String(chat.linked_chat_id) !== group.channel_id
        )
          throw new SafeError("DISCUSSION_LINK_NOT_VERIFIED");
      }
    }
    return this.mutate(() => {
      const old = this.db.config;
      const cfg = { ...old, ...p, epoch: old.epoch + 1 };
      this.db.config = cfg;
      // Configuration changes invalidate all scheduled deletes, including retries.
      this.db.run(
        "UPDATE work SET state='cancelled',due_at=NULL,last_error='configuration_changed' WHERE due_at IS NOT NULL AND (kind='delete' OR ?=1)",
        cfg.paused ? 1 : 0,
      );
      this.db.run("UPDATE decisions SET status='awaiting_confirmation' WHERE status='deleting'");
      this.db.run("UPDATE jobs SET status='awaiting_confirmation' WHERE status='deleting'");
      for (const sub of this.db.rows<Subscription>("SELECT * FROM subscriptions WHERE active=1")) {
        if (cfg.groups.some((g) => g.group_id === sub.group_id)) continue;
        this.db.run(
          "UPDATE subscriptions SET active=0,secret='',previous_secret=NULL,last_error='group_removed' WHERE id=?",
          sub.id,
        );
        this.db.run(
          "UPDATE work SET state='cancelled',due_at=NULL,last_error='group_removed' WHERE target=? AND due_at IS NOT NULL",
          sub.id,
        );
      }
      return { configuration: cfg, backlog_auto_execution: false };
    });
  }
  eligible(job: Job, revision: number) {
    const cfg = this.db.config;
    const group = cfg.groups.find((g) => g.group_id === job.group_id);
    if (!group) throw new SafeError("GROUP_NOT_ALLOWED", 403);
    if (job.revision !== revision) throw new SafeError("STALE_REVISION", 409);
    if (cfg.paused) throw new SafeError("MODERATION_PAUSED", 409);
    if (
      job.scope !== "discussion" ||
      job.channel_id !== group.channel_id ||
      job.root_id === job.message_id ||
      job.status === "protected" ||
      group.protected_senders.includes(job.sender) ||
      job.sender === `chat:${group.channel_id}` ||
      job.sender === `chat:${group.group_id}`
    )
      throw new SafeError("PROTECTED_OR_UNKNOWN_SCOPE", 403);
    if (Date.now() >= job.deadline || Date.now() >= job.message_at + 48 * 3600000 - 60000)
      throw new SafeError("DECISION_EXPIRED", 409);
  }
  async apply(p: DecisionInput) {
    return this.mutate(() => {
      const job = this.db.job(p.job_id);
      if (!job) throw new SafeError("COMMENT_NOT_FOUND", 404);
      const cfg = this.db.config;
      if (job.revision !== p.expected_revision) throw new SafeError("STALE_REVISION", 409);
      const existing = this.db.rows<Decision>(
        "SELECT * FROM decisions WHERE job_id=? AND revision=? AND epoch=?",
        job.id,
        job.revision,
        cfg.epoch,
      )[0];
      if (existing) return { decision_id: existing.id, status: existing.status, duplicate: true };
      if (["deleted", "missing", "deleting"].includes(job.status)) return { status: job.status };
      this.eligible(job, p.expected_revision);
      if (p.verdict === "spam" && !spamReasons.has(p.reason_code))
        throw new SafeError("SPAM_REASON_NOT_PERMITTED");
      if (p.verdict !== "spam" && spamReasons.has(p.reason_code))
        throw new SafeError("VERDICT_REASON_CONFLICT");
      if (this.db.count("audit_count") >= 30000) throw new SafeError("AUDIT_LIMIT", 429);
      const status =
        p.verdict === "allow"
          ? "allowed"
          : p.verdict === "review"
            ? "review"
            : cfg.mode === "dry_run"
              ? "would_delete"
              : cfg.mode === "manual"
                ? "awaiting_confirmation"
                : "deleting";
      const id = crypto.randomUUID();
      const now = Date.now();
      this.db.run(
        "INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        id,
        job.id,
        job.revision,
        cfg.epoch,
        p.verdict,
        p.reason_code,
        p.explanation,
        status,
        now,
        now + 30 * DAY,
        "model",
      );
      this.db.increment("audit_count");
      this.db.run("UPDATE jobs SET status=? WHERE id=?", status, job.id);
      this.db.cancelJob(job.id, "decision_received");
      if (status === "deleting")
        this.db.addWork({
          id: `delete:${id}`,
          kind: "delete",
          job_id: job.id,
          revision: job.revision,
          target: id,
          epoch: cfg.epoch,
          due_at: now,
        });
      return { decision_id: id, status, actually_deleted: false };
    });
  }
  async confirm(id: string, revision: number) {
    return this.mutate(() => {
      const d = this.db.decision(id);
      const job = d && this.db.job(d.job_id);
      if (!d || !job) throw new SafeError("DECISION_NOT_FOUND", 404);
      if (d.revision !== revision || job.revision !== revision)
        throw new SafeError("STALE_REVISION", 409);
      if (["deleted", "missing", "deleting"].includes(d.status))
        return { decision_id: id, status: d.status, duplicate: true };
      this.eligible(job, revision);
      if (d.verdict !== "spam" || !["would_delete", "awaiting_confirmation"].includes(d.status))
        throw new SafeError("DECISION_NOT_EXECUTABLE", 409);
      if (this.db.config.mode === "dry_run") throw new SafeError("DRY_RUN_NO_DELETE", 409);
      this.db.run(
        "UPDATE decisions SET status='deleting',source='owner_confirmation' WHERE id=?",
        id,
      );
      this.db.run("UPDATE jobs SET status='deleting' WHERE id=?", job.id);
      this.db.addWork({
        id: `delete:${id}:confirmed:${this.db.config.epoch}`,
        kind: "delete",
        job_id: job.id,
        revision,
        target: id,
        epoch: this.db.config.epoch,
        due_at: Date.now(),
      });
      return { decision_id: id, status: "deleting", actually_deleted: false };
    });
  }

  override async alarm() {
    await this.mutate(() => {
      const now = Date.now();
      for (const job of this.db.rows<Job>(
        "SELECT * FROM jobs WHERE status IN ('pending','awaiting_confirmation','deleting') AND deadline<=? ORDER BY deadline LIMIT 50",
        now,
      )) {
        this.db.run("UPDATE jobs SET status='expired' WHERE id=?", job.id);
        this.db.cancelJob(job.id, "decision_deadline");
        this.db.run(
          "UPDATE decisions SET status='expired' WHERE job_id=? AND status IN ('deleting','awaiting_confirmation')",
          job.id,
        );
      }
      this.cleanup(now);
    });
    for (let i = 0; i < LIMIT; i++) {
      const work = await this.mutate(() => {
        const row = this.db.rows<Work>(
          "SELECT * FROM work WHERE due_at<=? ORDER BY due_at,id LIMIT 1",
          Date.now(),
        )[0];
        if (!row) return null;
        if (row.attempts >= 5) {
          this.finish(row, "error", "attempts_exhausted");
          return null;
        }
        this.db.run(
          "UPDATE work SET state='in_flight',attempts=attempts+1,due_at=? WHERE id=?",
          Date.now() + LEASE,
          row.id,
        );
        return { ...row, attempts: row.attempts + 1, state: "in_flight" };
      });
      if (!work) break;
      try {
        if (work.kind === "delivery") await this.deliver(work);
        else await this.remove(work);
      } catch {
        await this.mutate(() => this.retry(work, "network_or_runtime_error"));
      }
    }
    await this.ctx.blockConcurrencyWhile(() => this.schedule());
  }
  finish(w: Work, state: string, error: string | null = null) {
    this.db.run("UPDATE work SET state=?,due_at=NULL,last_error=? WHERE id=?", state, error, w.id);
    const job = this.db.job(w.job_id);
    if (!job || job.revision !== w.revision) return;
    if (w.kind === "delivery")
      this.db.run("UPDATE jobs SET delivery_status=? WHERE id=?", state, job.id);
    else {
      this.db.run("UPDATE decisions SET status=? WHERE id=?", state, w.target);
      this.db.run("UPDATE jobs SET status=? WHERE id=?", state, job.id);
    }
  }
  retry(w: Work, reason: string, retryAfter?: number) {
    const job = this.db.job(w.job_id);
    const cfg = this.db.config;
    if (!job || job.revision !== w.revision || job.deadline <= Date.now()) {
      this.finish(w, "expired", "decision_deadline");
      return;
    }
    if (cfg.paused || (w.kind === "delete" && cfg.epoch !== w.epoch)) {
      this.finish(w, "cancelled", "configuration_changed");
      return;
    }
    if (w.attempts >= 5) {
      this.finish(w, "error", reason);
      return;
    }
    const delay = Math.max(
      retryAfter ? retryAfter * 1000 : 0,
      Math.min(300000, 1000 * 2 ** w.attempts),
    );
    this.db.run(
      "UPDATE work SET state='ready',due_at=?,last_error=? WHERE id=?",
      Math.min(job.deadline, Date.now() + delay),
      reason,
      w.id,
    );
  }
  current(w: Work) {
    return this.db.rows<Work>("SELECT * FROM work WHERE id=? AND state='in_flight'", w.id)[0];
  }
  async deliver(w: Work) {
    const job = this.db.job(w.job_id);
    const cfg = this.db.config;
    const sub = this.db.rows<Subscription>("SELECT * FROM subscriptions WHERE id=?", w.target)[0];
    if (
      !this.current(w) ||
      !job ||
      job.revision !== w.revision ||
      job.status !== "pending" ||
      cfg.paused ||
      !cfg.groups.some((g) => g.group_id === job.group_id) ||
      !sub?.active ||
      sub.expires_at <= Date.now() ||
      sub.owner !== this.env.OWNER_ID ||
      job.deadline <= Date.now()
    ) {
      await this.mutate(() => this.finish(w, "cancelled", "subscription_or_job_inactive"));
      return;
    }
    const result = await sendSigned(
      sub,
      w.id,
      {
        eventId: w.id,
        name: sub.name,
        timestamp: new Date(job.version_at).toISOString(),
        data: {
          group_id: job.group_id,
          job_id: job.id,
          revision: job.revision,
          text: job.text.slice(0, 4000),
          context: job.context.slice(0, 3000),
          decision_deadline: new Date(job.deadline).toISOString(),
          policy_version: POLICY_VERSION,
        },
        cursor: null,
      },
      this.env.CALLBACK_HOSTS,
    );
    await this.mutate(() => {
      if (!this.current(w)) return;
      if (result.status >= 200 && result.status < 300) this.finish(w, "delivered");
      else if (
        result.status === 410 ||
        result.status === 413 ||
        (result.status >= 400 && result.status < 500 && result.status !== 429)
      ) {
        this.finish(w, "error", `callback_http_${result.status}`);
        if (result.status === 410)
          this.db.run(
            "UPDATE subscriptions SET active=0,secret='',previous_secret=NULL,last_error='callback_gone' WHERE id=?",
            sub.id,
          );
      } else this.retry(w, `callback_http_${result.status}`, result.retryAfter);
    });
  }
  async remove(w: Work) {
    const job = this.db.job(w.job_id);
    const d = this.db.decision(w.target);
    const cfg = this.db.config;
    if (!this.current(w) || !job || !d) return;
    try {
      this.eligible(job, w.revision);
    } catch (e) {
      await this.mutate(() =>
        this.finish(w, "cancelled", e instanceof SafeError ? e.code : "invalid_target"),
      );
      return;
    }
    if (
      cfg.epoch !== w.epoch ||
      cfg.mode === "dry_run" ||
      (cfg.mode !== "auto" && d.source !== "owner_confirmation") ||
      d.status !== "deleting"
    ) {
      await this.mutate(() => this.finish(w, "cancelled", "mode_changed"));
      return;
    }
    const rights = await telegram(this.env.TELEGRAM_BOT_TOKEN, "getChatMember", {
      chat_id: job.group_id,
      user_id: Number(this.env.BOT_ID),
    });
    const member = rights.result as { status?: string; can_delete_messages?: boolean } | undefined;
    if (!rights.ok) {
      await this.mutate(() => this.retry(w, "rights_check_failed", rights.parameters?.retry_after));
      return;
    }
    if (
      member?.status !== "creator" &&
      !(member?.status === "administrator" && member.can_delete_messages)
    ) {
      await this.mutate(() => this.finish(w, "error", "bot_rights_lost"));
      return;
    }
    // I/O above may have let a new revision/configuration/unsubscribe arrive.
    const latest = this.db.job(job.id);
    if (!this.current(w) || !latest || this.db.config.epoch !== w.epoch || this.db.config.paused)
      return;
    try {
      this.eligible(latest, w.revision);
    } catch {
      await this.mutate(() => this.finish(w, "cancelled", "stale_after_rights_check"));
      return;
    }
    const result = await telegram(this.env.TELEGRAM_BOT_TOKEN, "deleteMessage", {
      chat_id: job.group_id,
      message_id: job.message_id,
    });
    await this.mutate(() => {
      // Even if a new revision arrives while the API is running, record the old
      // decision's external result. Never label the new text as approved/deleted.
      let state = "error";
      let error: string | null = null;
      if (result.ok) state = "deleted";
      else if (result.error_code === 429 || (result.error_code ?? 503) >= 500) {
        if (this.current(w))
          this.retry(w, `telegram_${result.error_code}`, result.parameters?.retry_after);
        return;
      } else if (result.description?.toLowerCase().includes("message to delete not found")) {
        state = "missing";
        error = "absence_not_proof_of_our_deletion";
      } else error = `telegram_${result.error_code ?? "unknown"}`;
      this.db.run("UPDATE decisions SET status=? WHERE id=?", state, d.id);
      this.finish(w, state, error);
    });
  }
  cleanup(now: number) {
    for (const table of [
      "updates",
      "roots",
      "decisions",
      "oauth_tokens",
      "oauth_codes",
      "oauth_flows",
      "auth_attempts",
    ] as const) {
      const deleted = this.db.rows(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at<=? LIMIT 25) RETURNING rowid`,
        now,
      ).length;
      if (table === "decisions" && deleted) this.db.increment("audit_count", -deleted);
    }
    for (const j of this.db.rows<Job>(
      "SELECT * FROM jobs WHERE text_expires<=? ORDER BY text_expires LIMIT 25",
      now,
    )) {
      this.db.cancelJob(j.id, "retention_expired");
      this.db.run("DELETE FROM work WHERE job_id=?", j.id);
      this.db.run("DELETE FROM jobs WHERE id=?", j.id);
      this.db.increment("inbox_count", -1);
    }
    // Expired subscriptions cannot deliver. Keep active credentials through granted lifetime.
    this.db.run(
      "UPDATE subscriptions SET active=0,secret='',previous_secret=NULL,last_error='subscription_expired' WHERE active=1 AND expires_at<=?",
      now,
    );
    const removedSubscriptions = this.db.rows(
      "DELETE FROM subscriptions WHERE id IN (SELECT id FROM subscriptions WHERE active=0 AND expires_at<=? LIMIT 25) RETURNING id",
      now - 7 * DAY,
    ).length;
    if (removedSubscriptions) this.db.increment("subscription_count", -removedSubscriptions);
    this.db.run(
      "DELETE FROM meta WHERE key LIKE 'received:%' AND CAST(substr(key,10) AS INTEGER)<?",
      Math.floor(now / DAY) - 2,
    );
  }
}
