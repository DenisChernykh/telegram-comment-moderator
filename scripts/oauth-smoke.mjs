import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { localEnv } from "./local-env.mjs";

localEnv();
const origin = new URL(process.argv[2] || "http://localhost:8787").origin;
const resource = `${origin}/mcp`;
const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(24).toString("base64url");
async function checked(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status} during OAuth smoke`);
  return response;
}
const registration = await (
  await checked(
    await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    }),
  )
).json();
const url = new URL(`${origin}/oauth/authorize`);
for (const [key, value] of Object.entries({
  client_id: registration.client_id,
  redirect_uri: redirect,
  response_type: "code",
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource,
  state,
}))
  url.searchParams.set(key, value);
const start = await checked(await fetch(url));
const page = await start.text();
const flow = /name="flow" value="([^"]+)"/.exec(page)?.[1];
if (!flow) throw new Error("No owner consent form");
if (!start.headers.get("set-cookie")?.startsWith(`__Host-oauth-flow=${flow};`))
  throw new Error("Consent response did not set the CSRF cookie");
const login = await fetch(`${origin}/oauth/authorize`, {
  method: "POST",
  redirect: "manual",
  headers: {
    origin,
    "content-type": "application/x-www-form-urlencoded",
    cookie: `__Host-oauth-flow=${flow}`,
  },
  body: new URLSearchParams({ flow, owner_secret: process.env.OWNER_LOGIN_SECRET || "" }),
});
if (login.status !== 302)
  throw new Error(`Owner login failed (${login.status}); no credentials printed`);
const callback = new URL(login.headers.get("location"));
if (callback.searchParams.get("state") !== state || callback.searchParams.get("iss") !== origin)
  throw new Error("OAuth state/issuer mismatch");
const tokens = await (
  await checked(
    await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        redirect_uri: redirect,
        resource,
        code: callback.searchParams.get("code"),
        code_verifier: verifier,
      }),
    }),
  )
).json();
if (!tokens.access_token) throw new Error("No access token");
await mkdir(".local", { recursive: true, mode: 0o700 });
await writeFile(
  ".local/mcp-tokens.json",
  JSON.stringify({ origin, client_id: registration.client_id, ...tokens }),
  { mode: 0o600 },
);
const discovery = await fetch(resource, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${tokens.access_token}`,
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "server/discover",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "operator-smoke", version: "1" },
      },
    },
  }),
});
const result = await discovery.json();
if (
  !result.result?.supportedVersions?.includes("2026-07-28") ||
  !result.result?.capabilities?.events
)
  throw new Error("MCP Events discovery failed");
console.log(
  JSON.stringify({
    oauth: "passed",
    mcp_2_discovery: "passed",
    events_capability: true,
    chatgpt_connection_tested: false,
  }),
);
