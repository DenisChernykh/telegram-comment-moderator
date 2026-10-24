export class SafeError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export function problem(code: string, status: number, path: string) {
  return Response.json(
    {
      type: `urn:telegram-moderator:${code.toLowerCase()}`,
      title: code,
      status,
      code,
      instance: path,
      requestId: crypto.randomUUID(),
    },
    {
      status,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
    },
  );
}
export async function readBody(request: Pick<Request, "body">, max = 64 * 1024) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new SafeError("BODY_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
