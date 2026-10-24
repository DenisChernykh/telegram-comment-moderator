import { z } from "zod";

const id = z.number().int().safe();
const chat = z.object({ id, type: z.string() });
const identity = z.object({ id, is_bot: z.boolean().optional() });
const messageBase = z
  .object({
    message_id: id.positive(),
    date: id.nonnegative(),
    chat,
    edit_date: id.nonnegative().optional(),
    text: z.string().max(16384).optional(),
    caption: z.string().max(16384).optional(),
    from: identity.optional(),
    sender_chat: chat.optional(),
    is_automatic_forward: z.boolean().optional(),
    message_thread_id: id.optional(),
    forward_origin: z
      .object({ type: z.string(), chat: chat.optional(), message_id: id.optional() })
      .optional(),
    entities: z.array(z.unknown()).max(200).optional(),
    caption_entities: z.array(z.unknown()).max(200).optional(),
  })
  .passthrough();
export const messageSchema = messageBase.extend({ reply_to_message: messageBase.optional() });
export type Message = z.infer<typeof messageSchema>;
export const updateSchema = z.object({
  update_id: id.nonnegative(),
  message: messageSchema.optional(),
  edited_message: messageSchema.optional(),
  my_chat_member: z
    .object({
      chat,
      date: id,
      new_chat_member: z.object({
        user: identity,
        status: z.string(),
        can_delete_messages: z.boolean().optional(),
      }),
    })
    .optional(),
});
export type Update = z.infer<typeof updateSchema>;
export function sender(m: Message) {
  return m.sender_chat ? `chat:${m.sender_chat.id}` : m.from ? `user:${m.from.id}` : "unknown";
}
export function channelRoot(m: Message, channel: string) {
  return (
    m.is_automatic_forward === true &&
    m.forward_origin?.type === "channel" &&
    String(m.forward_origin.chat?.id) === channel
  );
}
export function hasServiceData(m: Message) {
  const contentKeys = new Set([
    "message_id",
    "date",
    "edit_date",
    "chat",
    "from",
    "sender_chat",
    "text",
    "caption",
    "entities",
    "caption_entities",
    "reply_to_message",
    "message_thread_id",
    "is_automatic_forward",
    "forward_origin",
    "photo",
    "video",
    "audio",
    "voice",
    "document",
    "animation",
    "sticker",
    "video_note",
    "media_group_id",
    "has_protected_content",
    "link_preview_options",
    "show_caption_above_media",
    "has_media_spoiler",
    "is_topic_message",
  ]);
  // Unknown message fields are fail-closed. Adding Bot API content needs an explicit review.
  return Object.keys(m).some((k) => !contentKeys.has(k));
}
export type TelegramResult = {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
  failure_kind?: string;
};
export async function telegram(
  token: string | undefined,
  method: string,
  args: object,
): Promise<TelegramResult> {
  if (!token) return { ok: false, error_code: 503, failure_kind: "not_configured" };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body: JSON.stringify(args),
      redirect: "manual",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status >= 300 && response.status < 400)
      return { ok: false, error_code: 502, failure_kind: "redirect_rejected" };
    try {
      const result = (await response.json()) as TelegramResult;
      if (typeof result?.ok !== "boolean")
        return { ok: false, error_code: 502, failure_kind: "invalid_response" };
      return result;
    } catch {
      return {
        ok: false,
        error_code: response.status >= 400 ? response.status : 502,
        failure_kind: "invalid_response",
      };
    }
  } catch (error) {
    // Error messages can contain the token-bearing request URL. Classify only.
    const failure = error instanceof Error ? error : null;
    const failureKind = /redirect/i.test(failure?.message ?? "")
      ? "redirect_policy"
      : /invalid.*url|parse.*url/i.test(failure?.message ?? "")
        ? "request_url"
        : failure?.name === "AbortError" || failure?.name === "TimeoutError"
          ? "timeout"
          : "network_or_request";
    return { ok: false, error_code: 503, failure_kind: failureKind };
  }
}
