import { readFile, writeFile } from "node:fs/promises";

const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
const production = config.env.production;
const authPath = `${process.env.XDG_CONFIG_HOME || ".local/cloudflare-auth"}/.wrangler/config/default.toml`;
const token = (await readFile(authPath, "utf8")).match(/oauth_token = "([^"]+)"/)?.[1];
if (!token) throw new Error("Project Wrangler OAuth is not available");
const since = process.argv[2] || `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
if (!Number.isFinite(Date.parse(since))) throw new Error("Invalid ISO start time");
const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  signal: AbortSignal.timeout(20000),
  body: JSON.stringify({
    query: `query($account: String!, $since: Time!, $script: String!) {
      viewer { accounts(filter: {accountTag: $account}) {
        workersInvocationsAdaptive(limit: 10, filter: {datetime_geq: $since, scriptName: $script}) {
          dimensions { status } sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 }
        }
      } }
    }`,
    variables: { account: production.account_id, since, script: production.name },
  }),
});
const result = await response.json();
if (!response.ok || result.errors?.length)
  throw new Error("Cloudflare Analytics query failed; no credentials printed");
const report = {
  measured_at: new Date().toISOString(),
  since,
  script: production.name,
  sample: result.data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [],
  cpu_unit: "microseconds",
  scope: "aggregate outer Worker; not individual cold request CPU",
};
await writeFile(".local/cloudflare-metrics.json", JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
