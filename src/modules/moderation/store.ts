import type { Configuration, Decision, Job, Work } from "./public-contracts";
import { schema } from "./schema";

export class Store {
  constructor(readonly sql: SqlStorage) {
    sql.exec(schema);
  }
  rows<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
    query: string,
    ...args: (string | number | null)[]
  ): T[] {
    return this.sql.exec<T>(query, ...args).toArray();
  }
  run(query: string, ...args: (string | number | null)[]) {
    this.sql.exec(query, ...args);
  }
  get config(): Configuration {
    const raw = this.rows<{ value: string }>("SELECT value FROM meta WHERE key='config'")[0]?.value;
    return raw
      ? JSON.parse(raw)
      : {
          mode: "dry_run",
          paused: false,
          groups: [],
          decision_deadline_seconds: 1800,
          daily_comment_limit: 500,
          epoch: 1,
        };
  }
  set config(c: Configuration) {
    this.run("INSERT OR REPLACE INTO meta VALUES('config',?)", JSON.stringify(c));
  }
  job(id: string) {
    return this.rows<Job>("SELECT * FROM jobs WHERE id=?", id)[0];
  }
  decision(id: string) {
    return this.rows<Decision>("SELECT * FROM decisions WHERE id=?", id)[0];
  }
  count(key: string) {
    return Number(
      this.rows<{ value: string }>("SELECT value FROM meta WHERE key=?", key)[0]?.value ?? 0,
    );
  }
  increment(key: string, amount = 1) {
    this.run(
      "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+?",
      key,
      String(amount),
      amount,
    );
  }
  addWork(w: Omit<Work, "attempts" | "state" | "last_error">) {
    this.run(
      "INSERT OR IGNORE INTO work VALUES(?,?,?,?,?,?, 'ready',0,?,NULL)",
      w.id,
      w.kind,
      w.job_id,
      w.revision,
      w.target,
      w.epoch,
      w.due_at,
    );
  }
  cancelJob(id: string, reason: string) {
    this.run(
      "UPDATE work SET state='cancelled',due_at=NULL,last_error=? WHERE job_id=? AND due_at IS NOT NULL",
      reason,
      id,
    );
  }
  nextWake() {
    const work = this.rows<{ at: number | null }>(
      "SELECT MIN(due_at) AS at FROM work WHERE due_at IS NOT NULL",
    )[0]?.at;
    const deadline = this.rows<{ at: number | null }>(
      "SELECT MIN(deadline) AS at FROM jobs WHERE status IN ('pending','awaiting_confirmation','deleting')",
    )[0]?.at;
    const expiry = this.rows<{ at: number | null }>("SELECT MIN(text_expires) AS at FROM jobs")[0]
      ?.at;
    const subscriptionExpiry = this.rows<{ at: number | null }>(
      "SELECT MIN(expires_at) AS at FROM subscriptions WHERE active=1",
    )[0]?.at;
    const subscriptionRetention = this.rows<{ at: number | null }>(
      "SELECT MIN(expires_at)+604800000 AS at FROM subscriptions WHERE active=0",
    )[0]?.at;
    const cleanup = [
      "updates",
      "roots",
      "decisions",
      "oauth_tokens",
      "oauth_codes",
      "oauth_flows",
      "auth_attempts",
    ].map(
      (table) =>
        this.rows<{ at: number | null }>(`SELECT MIN(expires_at) AS at FROM ${table}`)[0]?.at,
    );
    const times = [
      work,
      deadline,
      expiry,
      subscriptionExpiry,
      subscriptionRetention,
      ...cleanup,
    ].filter((n): n is number => n != null);
    return times.length ? Math.min(...times) : null;
  }
}
