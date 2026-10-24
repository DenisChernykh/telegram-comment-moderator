import { readFile } from "node:fs/promises";
import { localEnv } from "./local-env.mjs";

localEnv();
const token =
  process.env.TELEGRAM_BOT_TOKEN || (await readFile(".local/telegram-token", "utf8")).trim();
async function api(method, args = {}) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const value = await response.json();
    if (!value.ok) throw new Error(`Telegram ${method} failed (${value.error_code})`);
    return value.result;
  } catch (e) {
    if (e.message.startsWith("Telegram ")) throw e;
    throw new Error(`Telegram ${method}: network failure`);
  }
}
const [command, arg] = process.argv.slice(2);
if (command === "discover") {
  const me = await api("getMe");
  const chat = await api("getChat", { chat_id: arg });
  console.log(
    JSON.stringify(
      {
        bot_id: me.id,
        bot_username: me.username,
        channel_id: chat.id,
        channel_title: chat.title,
        linked_group_id: chat.linked_chat_id ?? null,
      },
      null,
      2,
    ),
  );
} else if (command === "setup") {
  const origin = new URL(arg);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    !origin.hostname.endsWith(".workers.dev")
  )
    throw new Error("Use the exact deployed HTTPS workers.dev origin.");
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET.length < 32)
    throw new Error("Configure .dev.vars first.");
  const existing = await api("getWebhookInfo");
  const url = `${origin.origin}/telegram/webhook`;
  if (existing.url && existing.url !== url)
    throw new Error("This bot already has a different webhook; refusing to replace it.");
  await api("setWebhook", {
    url,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "edited_message", "my_chat_member"],
    max_connections: 1,
    drop_pending_updates: false,
  });
  const info = await api("getWebhookInfo");
  console.log(
    JSON.stringify({
      webhook_matches: info.url === url,
      pending_update_count: info.pending_update_count,
      allowed_updates: info.allowed_updates,
    }),
  );
} else if (command === "status") {
  const me = await api("getMe");
  const info = await api("getWebhookInfo");
  console.log(
    JSON.stringify({
      bot_id: me.id,
      bot_username: me.username,
      webhook_configured: Boolean(info.url),
      pending_update_count: info.pending_update_count,
      has_error: Boolean(info.last_error_message),
      last_error_date: info.last_error_date,
      allowed_updates: info.allowed_updates,
    }),
  );
} else if (command === "rights") {
  const me = await api("getMe");
  const chat = await api("getChat", { chat_id: arg });
  const member = await api("getChatMember", { chat_id: arg, user_id: me.id });
  console.log(
    JSON.stringify({
      group_id: chat.id,
      type: chat.type,
      linked_channel_id: chat.linked_chat_id,
      status: member.status,
      can_delete_messages: member.can_delete_messages === true,
    }),
  );
} else
  throw new Error(
    "Commands: discover @channel | setup https://name.workers.dev | status | rights -100group",
  );
