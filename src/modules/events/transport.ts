import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import { readBody, SafeError } from "../../platform/http";

export function publicIPv4(ip: string) {
  if (isIP(ip) !== 4) return false;
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function callbackUrl(value: string, hosts: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeError("CALLBACK_URL_INVALID");
  }
  const allowed = hosts
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname) ||
    url.hostname.startsWith("[") ||
    !allowed.includes(url.hostname.toLowerCase()) ||
    value.length > 2048
  ) {
    throw new SafeError("CALLBACK_HOST_NOT_ALLOWED");
  }
  return url;
}
export function validatedIPv4(records: readonly string[]) {
  // workerd's resolve4 currently includes CNAME data in its answer array.
  // Aliases are never connection targets; validate every returned IPv4 before
  // selecting one. Never perform another lookup when opening the socket.
  const addresses = records.filter((value) => isIP(value) === 4);
  if (!addresses.length || addresses.some((ip) => !publicIPv4(ip)))
    throw new SafeError("CALLBACK_ADDRESS_BLOCKED");
  return addresses;
}
/** Cloudflare's global public-network fetch validates its actual connection
 * destination, including after DNS changes, and verifies TLS for the URL host.
 * Requires global_fetch_strictly_public; no origin/VPC binding or DNS override.
 * Application DNS preflight rejects non-public answers as an additional check.
 * See the documented platform contract in ARCHITECTURE.md. */
export async function publicPost(
  url: URL,
  body: string,
  headers: Record<string, string>,
  resolve: (hostname: string) => Promise<string[]> = resolve4,
  send: typeof fetch = fetch,
) {
  const signal = AbortSignal.timeout(8000);
  const timeout = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(new SafeError("CALLBACK_TIMEOUT")), {
      once: true,
    }),
  );
  const perform = async () => {
    let records: string[];
    try {
      records = await resolve(url.hostname);
    } catch {
      throw new SafeError("CALLBACK_DNS_ERROR");
    }
    validatedIPv4(records);
    if (signal.aborted) throw new SafeError("CALLBACK_TIMEOUT");
    const response = await send(url, {
      method: "POST",
      headers,
      body,
      signal,
      redirect: "manual",
      cache: "no-store",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SafeError("CALLBACK_REDIRECT_REJECTED");
    }
    if (Number(response.headers.get("content-length")) > 65536) {
      await response.body?.cancel();
      throw new SafeError("CALLBACK_RESPONSE_TOO_LARGE");
    }
    let responseBody: string;
    try {
      responseBody = await readBody(response);
    } catch (error) {
      if (error instanceof SafeError && error.code === "BODY_TOO_LARGE")
        throw new SafeError("CALLBACK_RESPONSE_TOO_LARGE");
      throw error;
    }
    const retry = response.headers.get("retry-after");
    return {
      status: response.status,
      body: responseBody,
      retryAfter: retry && /^\d+$/.test(retry) ? Math.min(3600, Number(retry)) : undefined,
    };
  };
  try {
    return await Promise.race([perform(), timeout]);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError(signal.aborted ? "CALLBACK_TIMEOUT" : "CALLBACK_NETWORK_ERROR");
  }
}
