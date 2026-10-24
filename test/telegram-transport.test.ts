import { afterEach, expect, it, vi } from "vitest";
import { telegram } from "../src/modules/telegram";

afterEach(() => vi.unstubAllGlobals());

it("uses a runtime-valid Telegram request and refuses redirects without following them", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.redirect).toBe("manual");
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({});
    return new Response(null, { status: 302, headers: { location: "https://other.example/" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await telegram("123456:test-fixture", "getWebhookInfo", {})).toEqual({
    ok: false,
    error_code: 502,
    failure_kind: "redirect_rejected",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("reports unknown API state with bounded failures and never returns URL-bearing error messages", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("not JSON", { status: 403 })),
  );
  expect(await telegram("123456:test-fixture", "getWebhookInfo", {})).toEqual({
    ok: false,
    error_code: 403,
    failure_kind: "invalid_response",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Invalid URL containing private-token-fixture");
    }),
  );
  const failed = await telegram("123456:test-fixture", "getWebhookInfo", {});
  expect(failed).toMatchObject({ ok: false, error_code: 503, failure_kind: "request_url" });
  expect(JSON.stringify(failed)).not.toContain("private-token-fixture");
});
