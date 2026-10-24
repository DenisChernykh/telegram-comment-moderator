import { expect, it, vi } from "vitest";
import { publicPost } from "../src/modules/events/transport";

const url = new URL("https://receiver.example/secret-path?secret-query");
const dns = async () => ["receiver.example.cdn.cloudflare.net.", "104.18.38.184"];

it("uses URL TLS identity, manual redirects and exact body bytes, and limits streamed response bytes", async () => {
  const send = vi.fn(async (input, init) => {
    expect(String(input)).toBe(url.href);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      body: '{"challenge":"fixture"}',
    });
    expect(init?.headers).not.toHaveProperty("Host");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response('{"challenge":"fixture"}', { headers: { "retry-after": "9000" } });
  }) as typeof fetch;
  expect(
    await publicPost(
      url,
      '{"challenge":"fixture"}',
      { "Content-Type": "application/json" },
      dns,
      send,
    ),
  ).toMatchObject({ status: 200, body: '{"challenge":"fixture"}', retryAfter: 3600 });
  const chunks = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(65536));
      c.enqueue(new Uint8Array(1));
      c.close();
    },
  });
  await expect(
    publicPost(url, "{}", {}, dns, (async () => new Response(chunks)) as typeof fetch),
  ).rejects.toThrow("CALLBACK_RESPONSE_TOO_LARGE");
});
it("never sends callback bytes when DNS includes a private address, and never follows redirect targets", async () => {
  const send = vi.fn(
    async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
  ) as typeof fetch;
  await expect(
    publicPost(url, "{}", {}, async () => ["104.18.38.184", "127.0.0.1"], send),
  ).rejects.toThrow("CALLBACK_ADDRESS_BLOCKED");
  expect(send).not.toHaveBeenCalled();
  await expect(publicPost(url, "{}", {}, dns, send)).rejects.toThrow("CALLBACK_REDIRECT_REJECTED");
  expect(send).toHaveBeenCalledTimes(1);
});
it("returns only bounded failure categories when a provider error contains URL or signing material", async () => {
  const send = (async () => {
    throw new Error("secret-path secret-query whsec_private");
  }) as typeof fetch;
  await expect(publicPost(url, "{}", {}, dns, send)).rejects.toThrow(/^CALLBACK_NETWORK_ERROR$/);
  await expect(
    publicPost(
      url,
      "{}",
      {},
      async () => {
        throw new Error("secret-query");
      },
      send,
    ),
  ).rejects.toThrow(/^CALLBACK_DNS_ERROR$/);
});
