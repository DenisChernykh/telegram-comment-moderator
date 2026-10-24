export const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS updates_expiry ON updates(expires_at);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id INTEGER NOT NULL,
 revision INTEGER NOT NULL, version_at INTEGER NOT NULL, update_id INTEGER NOT NULL,
 fingerprint TEXT NOT NULL, text TEXT NOT NULL, context TEXT NOT NULL, sender TEXT NOT NULL,
 root_id INTEGER, scope TEXT NOT NULL, status TEXT NOT NULL, message_at INTEGER NOT NULL,
 received_at INTEGER NOT NULL, deadline INTEGER NOT NULL, epoch INTEGER NOT NULL,
 delivery_status TEXT NOT NULL, text_expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, id);
CREATE INDEX IF NOT EXISTS jobs_deadline ON jobs(deadline) WHERE status IN ('pending','awaiting_confirmation','deleting');
CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(text_expires);
CREATE INDEX IF NOT EXISTS jobs_ancestry ON jobs(group_id,message_id);
CREATE TABLE IF NOT EXISTS roots (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, message_id INTEGER NOT NULL,
 text TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS roots_expiry ON roots(expires_at);
CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, revision INTEGER NOT NULL,
 epoch INTEGER NOT NULL, verdict TEXT NOT NULL, reason_code TEXT NOT NULL, explanation TEXT NOT NULL,
 status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, source TEXT NOT NULL,
 UNIQUE(job_id,revision,epoch));
CREATE INDEX IF NOT EXISTS decisions_recent ON decisions(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS decisions_expiry ON decisions(expires_at);
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
 group_id TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, previous_secret TEXT,
 rotation_until INTEGER NOT NULL, expires_at INTEGER NOT NULL, verified_until INTEGER NOT NULL,
 active INTEGER NOT NULL, last_error TEXT);
CREATE INDEX IF NOT EXISTS subscriptions_filter ON subscriptions(group_id,name,active);
CREATE INDEX IF NOT EXISTS subscriptions_expiry ON subscriptions(active,expires_at);
CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY, kind TEXT NOT NULL, job_id TEXT NOT NULL,
 revision INTEGER NOT NULL, target TEXT NOT NULL, epoch INTEGER NOT NULL, state TEXT NOT NULL,
 attempts INTEGER NOT NULL, due_at INTEGER, last_error TEXT);
CREATE INDEX IF NOT EXISTS work_due ON work(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_job ON work(job_id);
CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, redirects TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client TEXT NOT NULL, redirect TEXT NOT NULL,
 challenge TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_flows (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS oauth_flows_expiry ON oauth_flows(expires_at);
CREATE INDEX IF NOT EXISTS oauth_codes_expiry ON oauth_codes(expires_at);
CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, client TEXT NOT NULL, kind TEXT NOT NULL,
 family TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS oauth_tokens_expiry ON oauth_tokens(expires_at);
CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_attempts_expiry ON auth_attempts(expires_at);
INSERT OR IGNORE INTO meta VALUES('schema_version','1');
`;
