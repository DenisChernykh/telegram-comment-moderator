import { timingSafeEqual } from "node:crypto";

export const randomToken = () => crypto.randomUUID() + crypto.randomUUID();
export const base64url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");
export async function hash(value: string) {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.byteLength === y.byteLength && timingSafeEqual(x, y);
}
export async function signature(secret: string, id: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice(6), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `v1,${Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  ).toString("base64")}`;
}
