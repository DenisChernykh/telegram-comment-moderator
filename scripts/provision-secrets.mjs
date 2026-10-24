import { spawn } from "node:child_process";
import { localEnv } from "./local-env.mjs";

localEnv();
for (const name of ["OWNER_LOGIN_SECRET", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN"]) {
  const value = process.env[name];
  if (!value || (name !== "TELEGRAM_BOT_TOKEN" && value.length < 32))
    throw new Error(`Missing ${name}; no value printed.`);
  const child = spawn("pnpm", ["exec", "wrangler", "secret", "put", name, "--env", "production"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  child.stdin.end(`${value}\n`);
  // Wrangler's hidden stdin prompt is used; neither secret nor provider logs are echoed.
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0)
    throw new Error(
      `Secret upload failed for ${name}; inspect Cloudflare, never print the secret.`,
    );
  console.log(`Stored ${name} in Worker secrets.`);
}
