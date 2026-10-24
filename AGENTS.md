# telegram-comment-moderator

Single-owner, API-only Cloudflare Workers **Free** MVP. No paid services, inference API,
automatic plan upgrades, bans, OCR, attachment downloads or general group moderation.
Owner/bot-scoped SQLite Durable Object is the source of truth; Alarms own bounded work.
Groups are an explicit allowlist and discussion ancestry must be proven.

Derived from DenisChernykh/free-hosting-starter commit
7b81c833ae99b40394a3b293dbddf2b3a22cfbc1. Keep feature modules under src/modules;
cross-module imports use index.ts/public-contracts.ts. Platform contains mechanisms.
No application-layer imports of HTTP, Cloudflare or persistence APIs.

Use Node 24 and pnpm 11.15.1, plain pnpm, inherited PATH and repository dependency policy.
Run pnpm check before handoff. Deploy is manual. Initial mode must be dry_run.
Do not log comments, secrets, callback URLs, OAuth codes, query strings or tokens.
Do not print or commit .dev.vars or .local. HTTP invocation logs must stay disabled.
Tests with mocked APIs are never evidence of a live Telegram/ChatGPT integration.
Do not add sub-agents unless the user requests them.
